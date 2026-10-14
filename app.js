/* =========================================================
   NT FLEET MANAGEMENT SYSTEM
   Architecture: Supabase Cloud-First (Direct DB Write & Sync)
   ========================================================= */

const app = document.querySelector('#app');

// =========================================================
// SUPABASE CONFIGURATION
// =========================================================
const SUPABASE_URL = 'https://qwbkguzdxqeqzeshinjm.supabase.co';
const SUPABASE_PUBLISHABLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF3YmtndXpkeHFlcXplc2hpbmptIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyMzYyMTEsImV4cCI6MjEwMzgxMjIxMX0.UgVu8Jvqsb3V8ILBFSAM7m1YftkAFoqaYySwVf5Dd6g';

const supabaseClient = window.supabase
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY)
  : null;

// =========================================================
// TELEGRAM NOTIFICATION CONFIGURATION
// =========================================================
const TELEGRAM_BOT_TOKEN = '8743895319:AAHmk34e-cyJX8xsrid6WznA8lNUYnBDdvw';
const TELEGRAM_CHAT_ID = '-5392899354';

async function sendTelegramNotification(message) {
  if (!TELEGRAM_CHAT_ID) {
    console.warn('ยังไม่ได้ระบุ TELEGRAM_CHAT_ID');
    return;
  }

  const endpoint = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
      }),
    });
  } catch (error) {
    console.error('Telegram notification failed:', error);
  }
}

// =========================================================
// SERVICE MILEAGE ALERT (เช็คระยะทุกๆ 10,000 กม. แจ้งเตือนล่วงหน้า 500 กม.)
// =========================================================
async function checkServiceMileageAlert(plate, currentMileage, driver = '') {
  const mileageNum = Number(currentMileage);
  if (isNaN(mileageNum) || mileageNum <= 0) return;

  const interval = 10000;
  const threshold = 500;

  const remainder = mileageNum % interval;
  const remaining = remainder === 0 ? 0 : interval - remainder;

  if (remaining <= threshold && remaining >= 0) {
    const nextMilestone = remainder === 0 ? mileageNum : mileageNum + remaining;

    const alertMsg =
      `⚠️ <b>แจ้งเตือนกำหนดเช็คสภาพรถ / เช็คระยะ</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `🚗 <b>ทะเบียน:</b> ${plate}\n` +
      `<b>เลขไมล์ปัจจุบัน:</b> ${mileageNum.toLocaleString()} กม.\n` +
      `<b>รอบเช็คสภาพ:</b> ${nextMilestone.toLocaleString()} กม.\n` +
      `<b>ระยะทางคงเหลือ:</b> อีก ${remaining.toLocaleString()} กม.\n` +
      `<b>ผู้บันทึกล่าสุด:</b> ${driver || '-'}\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `🔔 กรุณานำรถเข้ารับการตรวจเช็คสภาพตามระยะกำหนด`;

    await sendTelegramNotification(alertMsg);
  }
}

// =========================================================
// APP CONFIGURATION & STATE
// =========================================================
const THEME_KEY = 'nt-fms-theme';
const PROFILE_KEY = 'nt-fms-profile';
const SESSION_KEY = 'nt-fms-session';
const OVER_BUDGET = 2000;
const DASHBOARD_REFRESH_MS = 30000;

const VEHICLE_DEPARTMENTS = [
  'ทั้งหมด',
  'สำนักงานหัวหิน',
  'รถประจำศูนย์ตอนนอก',
  'รถประจำศูนย์การกำลังและสื่อสาร',
  'รถประจำศูนย์หัวหิน',
  'รถประจำศูนย์บางสะพาน',
  'รถประจำศูนย์ประจวบฯ',
  'รถประจำศูนย์สนันสนุน',
  'รถประจำศูนย์ตามหนี้',
];

let dashboardRefreshTimer = null;

const state = {
  role: null,
  user: null,

  view: 'user-entry',
  userTab: 'usage',

  edit: null,
  vehicle: null,

  supabaseUser: null,
  employee: null,
  sessionToken: null,

  backendConnected: true,
  lastSyncedAt: null,

  mobileMenuOpen: false,
};

// =========================================================
// IN-MEMORY DATABASE CACHE (ซิงค์ตรงจาก Supabase เท่านั้น)
// =========================================================
let db = {
  vehicles: [],
  usages: [],
  fuels: [],
  services: [],
  audit: [],
};

// =========================================================
// SUPABASE STORAGE HELPER
// =========================================================
async function uploadFileToSupabase(bucket, path, file) {
  if (!supabaseClient) {
    throw new Error('Supabase client ยังไม่พร้อมใช้งาน');
  }

  if (!file) {
    throw new Error('ไม่ได้เลือกไฟล์รูปภาพ');
  }

  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowedTypes.includes(file.type)) {
    throw new Error('รองรับเฉพาะ JPG, PNG และ WEBP เท่านั้น');
  }

  if (file.size > 3 * 1024 * 1024) {
    throw new Error('รูปต้องมีขนาดไม่เกิน 3 MB');
  }

  const { error } = await supabaseClient.storage
    .from(bucket)
    .upload(path, file, {
      cacheControl: '0',
      contentType: file.type,
      upsert: true,
    });

  if (error) {
    console.error('Storage Upload Error:', error);
    throw new Error(`อัปโหลดรูปไม่สำเร็จ: ${error.message}`);
  }

  const { data: publicUrlData } = supabaseClient.storage
    .from(bucket)
    .getPublicUrl(path);

  if (!publicUrlData?.publicUrl) {
    throw new Error('ไม่สามารถสร้าง Public URL ของรูปได้');
  }

  return `${publicUrlData.publicUrl.split('?')[0]}?t=${Date.now()}`;
}

// =========================================================
// HELPER FUNCTIONS
// =========================================================
function loadProfile() {
  try {
    return JSON.parse(localStorage.getItem(PROFILE_KEY)) || { avatar: '', phone: '' };
  } catch {
    return { avatar: '', phone: '' };
  }
}

function saveProfile(profile) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

function currentTheme() {
  return (
    localStorage.getItem(THEME_KEY) ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  );
}

function applyTheme(theme = currentTheme()) {
  document.documentElement.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'dark' ? '#0b1120' : '#ffffff');
}

function toggleTheme() {
  const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, nextTheme);

  if (document.startViewTransition) {
    document.startViewTransition(async () => {
      applyTheme(nextTheme);
      await renderApp();
    });
  } else {
    applyTheme(nextTheme);
    renderApp();
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function bangkokMonthKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);

  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}`;
}

function thaiMonth(month = bangkokMonthKey()) {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('th-TH', {
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Bangkok',
  }).format(new Date(Date.UTC(year, monthNumber - 1, 1, 12)));
}

function lastSyncLabel() {
  return state.lastSyncedAt
    ? new Intl.DateTimeFormat('th-TH', {
        dateStyle: 'short',
        timeStyle: 'medium',
        timeZone: 'Asia/Bangkok',
      }).format(state.lastSyncedAt)
    : 'เชื่อมต่อฐานข้อมูล Supabase แล้ว';
}

function thaiDate(date) {
  return new Intl.DateTimeFormat('th-TH', {
    dateStyle: 'medium',
  }).format(new Date(`${date}T00:00:00`));
}

function money(value) {
  return new Intl.NumberFormat('th-TH', {
    style: 'currency',
    currency: 'THB',
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function number(value, digits = 0) {
  return new Intl.NumberFormat('th-TH', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(Number(value || 0));
}

function mileage(record) {
  return Math.max(0, Number(record.endMileage) - Number(record.startMileage));
}

function esc(value = '') {
  return String(value).replace(
    /[&<>'"]/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;',
      }[character]),
  );
}

async function addAudit(action, detail) {
  const entry = {
    actor: state.user?.name || 'System',
    employee_id: state.user?.employeeId || null,
    action,
    detail,
  };

  if (supabaseClient) {
    try {
      await supabaseClient.from('audit').insert(entry);
    } catch (err) {
      console.warn('Insert audit warning:', err);
    }
  }

  db.audit.unshift({
    id: `aud-${Date.now()}`,
    time: new Date().toISOString(),
    ...entry,
  });
  db.audit = db.audit.slice(0, 100);
}

/* =========================================================
   ICONS
   ========================================================= */
function icon(name) {
  const icons = {
    layout: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="3" width="7" height="18" rx="1.5"></rect><rect x="3" y="14" width="7" height="7" rx="1.5"></rect></svg>`,
    file: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6M8 13h8M8 17h8"></path></svg>`,
    history: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2M3 12H1M5 5 3.5 3.5"></path></svg>`,
    table: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M3 10h18M9 4v16M15 4v16"></path></svg>`,
    fuel: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16M4 21h14M9 7h5v4H9zM17 8h2l2 2v7a2 2 0 0 1-4 0v-5"></path></svg>`,
    creditCard: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2"></rect><line x1="2" y1="10" x2="22" y2="10"></line></svg>`,
    report: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V5M4 19h17"></path><path d="m7 15 4-4 3 3 6-7"></path></svg>`,
    audit: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v4l3 2"></path></svg>`,
    profile: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5"></circle><path d="M4.5 20c.9-3.4 3.4-5 7.5-5s6.6 1.6 7.5 5"></path></svg>`,
    bell: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"></path><path d="M10 21h4"></path></svg>`,
    logout: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4"></path><path d="m14 16 4-4-4-4M8 12h10"></path></svg>`,
    menu: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"></path></svg>`,
    x: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"></path></svg>`,
    sun: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"></path></svg>`,
    moon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.4 14.6A8.9 8.9 0 0 1 9.4 3.6 9 9 0 1 0 20.4 14.6Z"></path></svg>`,
  };
  return icons[name] || icons.layout;
}

function brand() {
  return `
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">
        <span></span><span></span><span></span>
      </span>
      <div>
        <strong>nt</strong>
        <small>Fleet Management System</small>
      </div>
    </div>
  `;
}

function toast(message, kind = 'success') {
  const template = document.querySelector('#toast-template');
  if (!template) return;

  const node = template.content.firstElementChild.cloneNode(true);
  node.textContent = message;
  node.classList.add(kind);

  document.body.append(node);
  setTimeout(() => node.remove(), 3200);
}

function avatarMarkup(profileImageUrl, name, extraStyle = '') {
  const fallbackLetter = esc(name?.charAt(0) || 'U');

  if (!profileImageUrl) {
    return `<span>${fallbackLetter}</span>`;
  }

  return `
    <img
      src="${esc(profileImageUrl)}"
      alt="Avatar"
      loading="lazy"
      style="${extraStyle}"
      onerror="
        this.style.display='none';
        if (this.nextElementSibling) { this.nextElementSibling.style.display='flex'; }
      "
    />
    <span style="display:none;">${fallbackLetter}</span>
  `;
}

function vehicleFromUrl() {
  return new URLSearchParams(window.location.search).get('vehicleId')?.trim() || '';
}

/* =========================================================
   AUTH SCREENS
   ========================================================= */
function renderLoadingVehicle() {
  app.innerHTML = `
    <main class="auth-page">
      <section class="auth-card">
        ${brand()}
        <h1>กำลังเข้าสู่ระบบ</h1>
        <p>โปรดรอสักครู่ ระบบกำลังเชื่อมต่อฐานข้อมูล...</p>
      </section>
    </main>
  `;
}

function renderVehicleError(message) {
  app.innerHTML = `
    <main class="auth-page">
      <section class="auth-card">
        ${brand()}
        <h1>ไม่สามารถเปิดรายการรถได้</h1>
        <p>${esc(message)}</p>
        <p class="hint">โปรดตรวจสอบ QR Code หรือเข้าสู่ระบบแบบทั่วไป</p>
        <div class="button-row" style="margin-top: 16px;">
          <button class="button button-full" onclick="window.location.href=window.location.pathname">เข้าสู่ระบบทั่วไป</button>
        </div>
      </section>
    </main>
  `;
}

function renderLogin() {
  const vehicle = state.vehicle;

  // หากสแกน QR Code มาให้แสดงข้อมูลรถ แต่หากเข้าแบบธรรมดาจะแสดงเป็นโหมดเข้าสู่ระบบทั่วไป
  const vehicleInfoMarkup = vehicle
    ? `
      <div class="vehicle-card">
        <span class="section-label">รถที่สแกน</span>
        <strong>${esc(vehicle.plate)}</strong>
        <p>${esc(vehicle.model)} / สถานะ: ${esc(vehicle.status)}</p>
      </div>
    `
    : `
      <div class="notice" style="margin: 16px 0; text-align: center;">
        เข้าสู่ระบบบันทึกการใช้งานยานพาหนะส่วนกลาง
      </div>
    `;

  app.innerHTML = `
    <main class="auth-page">
      <section class="auth-card">
        ${brand()}
        <h1 style="text-align: center;">บันทึกการใช้งานรถจังหวัดประจวบคีรีขันธ์</h1>
        <p style="text-align: center; margin-bottom: 8px;">บริษัท โทรคมนาคมแห่งชาติ จำกัด (มหาชน)</p>

        ${vehicleInfoMarkup}

        <form id="login-form">
          <div class="field">
            <label for="employee-id">รหัสพนักงาน</label>
            <input
              id="employee-id"
              name="employeeId"
              inputmode="numeric"
              pattern="[0-9]*"
              required
              maxlength="12"
              placeholder="กรุณากรอกรหัสพนักงาน"
              autocomplete="off"
              autofocus
            />
          </div>
          <button class="button button-full" type="submit">เข้าสู่ระบบ</button>
        </form>
      </section>
    </main>
  `;

  document.querySelector('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const employeeId = new FormData(event.currentTarget).get('employeeId').trim();
    const submit = event.currentTarget.querySelector('[type=submit]');

    submit.disabled = true;
    submit.textContent = 'กำลังตรวจสอบรหัสพนักงาน...';

    try {
      const { data, error } = await supabaseClient.rpc('login_with_employee_id', {
        p_employee_id: employeeId,
      });

      if (error) throw new Error(error.message || 'ไม่สามารถเข้าสู่ระบบได้');
      if (!data || !data.success) throw new Error('ไม่พบข้อมูลพนักงานในระบบ');

      state.user = data.user;
      state.role = data.user.role;
      state.sessionToken = data.session_token;

      localStorage.setItem(SESSION_KEY, data.session_token);
      localStorage.setItem('nt-fms-user', JSON.stringify(data.user));

      if (supabaseClient && data.user?.employeeId) {
        const { data: empData } = await supabaseClient
          .from('employees')
          .select('profile_image, phone')
          .eq('employee_id', data.user.employeeId)
          .maybeSingle();

        if (empData) {
          if (empData.profile_image) {
            state.user.profileImage = `${empData.profile_image.split('?')[0]}?t=${Date.now()}`;
          }
          if (empData.phone) {
            state.user.phone = empData.phone;
          }
          localStorage.setItem('nt-fms-user', JSON.stringify(state.user));
        }
      }

      await syncRemoteData();

      state.view = state.role === 'admin' ? 'admin-dashboard' : 'user-entry';
      await addAudit('เข้าสู่ระบบ', `เข้าสู่ระบบในบทบาท ${state.role} (รหัสพนักงาน ${data.user.employeeId})`);
      await renderApp();
    } catch (error) {
      toast(error.message || 'ไม่สามารถเข้าสู่ระบบได้', 'error');
      submit.disabled = false;
      submit.textContent = 'เข้าสู่ระบบ';
    }
  });
}

/* =========================================================
   DATA SYNCHRONIZATION (SUPABASE CLOUD -> MEMORY CACHE)
   ========================================================= */
function normalizeVehicle(vehicle) {
  return {
    ...vehicle,
    id: vehicle.id || vehicle.vehicleId || vehicle.vehicle_id,
    vehicleId: vehicle.vehicleId || vehicle.vehicle_id || vehicle.id,
    plate: vehicle.plate,
    model: vehicle.model,
    department: vehicle.department || '',
    status: vehicle.status || 'พร้อมใช้งาน',
    fleetCardBalance: Number(vehicle.fleet_card_balance ?? vehicle.fleetCardBalance ?? 0),
    fleetCardNumber: vehicle.fleet_card_number || vehicle.fleetCardNumber || '',
  };
}

async function syncRemoteData() {
  if (!supabaseClient) return;

  try {
    const [vRes, uRes, fRes, sRes, aRes] = await Promise.all([
      supabaseClient.from('vehicles').select('*'),
      supabaseClient.from('usages').select('*').order('created_at', { ascending: false }),
      supabaseClient.from('fuels').select('*').order('created_at', { ascending: false }),
      supabaseClient.from('services').select('*').order('created_at', { ascending: false }),
      supabaseClient.from('audit').select('*').order('time', { ascending: false }).limit(100),
    ]);

    if (vRes.data && vRes.data.length > 0) {
      db.vehicles = vRes.data.map(normalizeVehicle);
    }
    if (uRes.data) {
      db.usages = uRes.data.map((u) => ({
        id: u.id,
        employeeId: u.employee_id || '',
        date: u.date,
        driver: u.driver,
        plate: u.plate,
        department: u.department,
        depart: u.depart,
        return: u.return,
        startMileage: Number(u.start_mileage ?? u.startMileage ?? 0),
        endMileage: Number(u.end_mileage ?? u.endMileage ?? 0),
        purpose: u.purpose,
        note: u.note,
        created_at: u.created_at || null,
      }));
    }
    if (fRes.data) {
      db.fuels = fRes.data.map((f) => ({
        id: f.id,
        employeeId: f.employee_id || '',
        date: f.date,
        driver: f.driver,
        plate: f.plate,
        mileage: Number(f.mileage ?? 0),
        type: f.type,
        liters: Number(f.liters ?? 0),
        amount: Number(f.amount ?? 0),
        payment: f.payment,
        receipt: f.receipt_url || '',
        approved: f.approved,
        created_at: f.created_at || null,
      }));
    }
    if (sRes.data) {
      db.services = sRes.data.map((s) => ({
        id: s.id,
        employeeId: s.employee_id || '',
        date: s.date,
        plate: s.plate,
        mileage: Number(s.mileage ?? 0),
        serviceType: s.service_type,
        note: s.note,
        created_at: s.created_at || null,
      }));
    }
    if (aRes.data) {
      db.audit = aRes.data.map((a) => ({
        id: a.id,
        time: a.time,
        actor: a.actor,
        action: a.action,
        detail: a.detail,
      }));
    }

    state.lastSyncedAt = new Date();
  } catch (err) {
    console.warn('Sync Remote Data Warning:', err);
  }
}

/* =========================================================
   NAVIGATION
   ========================================================= */
const navItems = {
  user: [
    ['user-entry-usage', 'file', 'บันทึกการใช้รถ'],
    ['user-entry-fuel', 'fuel', 'บันทึกเติมน้ำมัน'],
    ['user-entry-service', 'table', 'บันทึกเช็คระยะ'],
    ['user-history', 'history', 'ประวัติของฉัน'],
    ['user-profile', 'profile', 'Profile'],
  ],
  admin: [
    ['admin-dashboard', 'layout', 'หน้าหลัก'],
    ['admin-entry', 'file', 'บันทึกข้อมูล'],
    ['admin-usage', 'table', 'ประวัติใช้รถ'],
    ['admin-fuel', 'fuel', 'ประวัติน้ำมัน'],
    ['admin-service', 'history', 'เช็คระยะ'],
    ['admin-fleet-card', 'creditCard', 'จัดการ Fleet Card'],
    ['admin-reports', 'report', 'รายงาน'],
    ['admin-users', 'profile', 'จัดการผู้ใช้'],
    ['admin-audit', 'audit', 'Audit Log'],
    ['admin-profile', 'profile', 'Profile'],
  ],
};

function isNavActive(view) {
  if (state.role === 'user' && view.startsWith('user-entry-')) {
    return state.view === 'user-entry' && state.userTab === view.replace('user-entry-', '');
  }
  return state.view === view;
}

function navMarkup() {
  return (navItems[state.role] || [])
    .map(
      ([view, iconName, label]) => `
        <button type="button" data-view="${view}" class="${isNavActive(view) ? 'active' : ''}">
          <span class="nav-icon">${icon(iconName)}</span>
          <span class="nav-label">${label}</span>
        </button>
      `,
    )
    .join('');
}

/* =========================================================
   MOBILE DRAWER
   ========================================================= */
function mobileDrawerMarkup() {
  const profile = state.user ? loadProfile() : { avatar: '' };
  const roleLabel = state.role === 'admin' ? 'ผู้ดูแลระบบ' : 'พนักงาน';
  const avatarUrl = state.user?.profileImage || profile.avatar || '';
  const avatar = avatarMarkup(avatarUrl, state.user?.name);

  return `
    <div
      class="mobile-drawer-overlay ${state.mobileMenuOpen ? 'is-open' : ''}"
      id="mobile-drawer-overlay"
      aria-hidden="${state.mobileMenuOpen ? 'false' : 'true'}"
    >
      <aside class="mobile-drawer ${state.mobileMenuOpen ? 'is-open' : ''}" aria-label="เมนูหลัก">
        <div class="drawer-header">
          <div>${brand()}</div>
          <button class="icon-button drawer-close" id="drawer-close" type="button" aria-label="ปิดเมนู">
            ${icon('x')}
          </button>
        </div>

        <div class="drawer-user">
          <div class="drawer-avatar">${avatar}</div>
          <div class="drawer-user-copy">
            <strong>${esc(state.user?.name || 'ผู้ใช้งาน')}</strong>
            <span>${roleLabel}</span>
          </div>
        </div>

        <div class="drawer-section-label">เมนูระบบ</div>
        <nav class="drawer-nav" aria-label="เมนูสำหรับมือถือ">${navMarkup()}</nav>

        <div class="drawer-divider"></div>

        <button type="button" class="drawer-action" id="drawer-theme-toggle">
          <span class="nav-icon">
            ${document.documentElement.dataset.theme === 'dark' ? icon('sun') : icon('moon')}
          </span>
          <span>${document.documentElement.dataset.theme === 'dark' ? 'ใช้ธีมสว่าง' : 'ใช้ธีมมืด'}</span>
        </button>

        <button type="button" class="drawer-action drawer-logout" id="drawer-logout">
          <span class="nav-icon">${icon('logout')}</span>
          <span>ออกจากระบบ</span>
        </button>

        <div class="drawer-footer">
          <span>NT Fleet Management System</span>
          <small>Mobile Navigation</small>
        </div>
      </aside>
    </div>
  `;
}

function openMobileMenu() {
  state.mobileMenuOpen = true;
  const overlay = document.querySelector('#mobile-drawer-overlay');
  const drawer = document.querySelector('.mobile-drawer');
  if (!overlay || !drawer) return;

  overlay.classList.add('is-open');
  drawer.classList.add('is-open');
  overlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('drawer-open');
}

function closeMobileMenu() {
  state.mobileMenuOpen = false;
  const overlay = document.querySelector('#mobile-drawer-overlay');
  const drawer = document.querySelector('.mobile-drawer');
  if (!overlay || !drawer) {
    document.body.classList.remove('drawer-open');
    return;
  }

  overlay.classList.remove('is-open');
  drawer.classList.remove('is-open');
  overlay.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('drawer-open');
}

/* =========================================================
   MAIN APP
   ========================================================= */
async function renderApp() {
  const roleLabel = state.role === 'admin' ? 'ผู้ดูแลระบบ' : 'พนักงาน';
  const nextThemeLabel = document.documentElement.dataset.theme === 'dark' ? 'ใช้ธีมสว่าง' : 'ใช้ธีมมืด';
  const themeIcon = document.documentElement.dataset.theme === 'dark' ? icon('sun') : icon('moon');

  const avatar = avatarMarkup(
    state.user?.profileImage,
    state.user?.name,
    'width:100%;height:100%;border-radius:inherit;object-fit:cover;'
  );

  app.innerHTML = `
    <div class="app-layout">
      <aside class="sidebar">
        <div class="sidebar-top">
          ${brand()}
          <div class="workspace-label">เมนูระบบ</div>
          <nav class="nav" aria-label="เมนูหลัก">${navMarkup()}</nav>
        </div>

        <div class="sidebar-bottom">
          <div class="user-summary">
            <div class="avatar">${avatar}</div>
            <div>
              <span>${roleLabel}</span>
              <strong>${esc(state.user?.name || 'ผู้ใช้งาน')}</strong>
            </div>
          </div>
          <button class="sidebar-logout" id="logout-sidebar" type="button">ออกจากระบบ</button>
        </div>
      </aside>

      <main class="main">
        <header class="topbar">
          <div class="mobile-menu-wrap">
            <button class="icon-button mobile-menu-button" id="mobile-menu-button" type="button" aria-label="เปิดเมนู">
              ${icon('menu')}
            </button>
          </div>

          <div class="topbar-copy">
            <div class="eyebrow">NT FLEET MANAGEMENT</div>
            <h1>ระบบบันทึกการใช้งานรถจังหวัดประจวบคีรีขันธ์</h1>
            <p>บริษัท โทรคมนาคมแห่งชาติ จำกัด (มหาชน)</p>
          </div>

          <div class="user-actions">
            <div class="vehicle-pill">
              <span>รถที่ใช้งาน</span>
              <strong>${esc(state.vehicle?.plate || 'เลือกรายคัน')}</strong>
            </div>

            <button class="icon-button theme-toggle" id="theme-toggle" type="button" aria-label="${nextThemeLabel}">
              ${themeIcon}
            </button>

            <div class="account-chip">
              <div class="avatar">${avatar}</div>
              <div class="account-copy">
                <strong>${esc(state.user?.name || 'ผู้ใช้งาน')}</strong>
                <span>${roleLabel}</span>
              </div>
            </div>

            <button class="ghost-button topbar-logout" id="logout" type="button">ออกจากระบบ</button>
          </div>
        </header>

        <section class="page" id="page"></section>
      </main>

      ${mobileDrawerMarkup()}

      <div class="mobile-bottom-actions">
        <button type="button" data-bottom-view="usage" class="${(state.view === 'user-entry' || state.view === 'admin-entry') && state.userTab === 'usage' ? 'active' : ''}">
          <span class="bottom-action-icon">${icon('file')}</span>
          <span>ใช้รถ</span>
        </button>
        <button type="button" data-bottom-view="fuel" class="${(state.view === 'user-entry' || state.view === 'admin-entry') && state.userTab === 'fuel' ? 'active' : ''}">
          <span class="bottom-action-icon">${icon('fuel')}</span>
          <span>เติมน้ำมัน</span>
        </button>
        <button type="button" data-bottom-view="service" class="${(state.view === 'user-entry' || state.view === 'admin-entry') && state.userTab === 'service' ? 'active' : ''}">
          <span class="bottom-action-icon">${icon('table')}</span>
          <span>เช็คระยะ</span>
        </button>
      </div>
    </div>
  `;

  bindMainNavigation();
  await renderView();
  updateDashboardRefresh();
}

function bindMainNavigation() {
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.addEventListener('click', async () => {
      const view = button.dataset.view;

      if (view.startsWith('user-entry-')) {
        state.view = 'user-entry';
        state.userTab = view.replace('user-entry-', '');
      } else if (view === 'user-history') {
        state.view = 'user-history';
      } else if (view === 'user-profile') {
        state.view = 'user-profile';
      } else if (view === 'admin-profile') {
        state.view = 'admin-profile';
      } else {
        state.view = view;
      }

      state.edit = null;
      closeMobileMenu();
      await renderApp();
    });
  });

  document.querySelectorAll('[data-bottom-view]').forEach((button) => {
    button.addEventListener('click', async () => {
      const bottomView = button.dataset.bottomView;
      state.view = state.role === 'admin' ? 'admin-entry' : 'user-entry';
      state.userTab = bottomView;
      state.edit = null;
      closeMobileMenu();
      await renderApp();
    });
  });

  document.querySelector('#mobile-menu-button')?.addEventListener('click', openMobileMenu);
  document.querySelector('#drawer-close')?.addEventListener('click', closeMobileMenu);
  document.querySelector('#mobile-drawer-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'mobile-drawer-overlay') closeMobileMenu();
  });

  document.querySelector('#drawer-theme-toggle')?.addEventListener('click', () => {
    closeMobileMenu();
    toggleTheme();
  });

  document.querySelector('#drawer-logout')?.addEventListener('click', logoutUser);
  document.querySelector('#theme-toggle')?.addEventListener('click', toggleTheme);
  document.querySelectorAll('#logout, #logout-sidebar').forEach((btn) => btn.addEventListener('click', logoutUser));
}

function logoutUser() {
  addAudit('ออกจากระบบ', 'ออกจากระบบ');

  state.role = null;
  state.user = null;
  state.supabaseUser = null;
  state.employee = null;
  state.sessionToken = null;

  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(PROFILE_KEY);
  localStorage.removeItem('nt-fms-user');

  state.view = 'user-entry';
  state.userTab = 'usage';
  state.edit = null;
  state.mobileMenuOpen = false;

  clearInterval(dashboardRefreshTimer);
  dashboardRefreshTimer = null;
  document.body.classList.remove('drawer-open');

  renderLogin();
}

function pageHead(title, description, action = '') {
  return `
    <div class="page-head">
      <div>
        <h2>${title}</h2>
        <p>${description}</p>
      </div>
      ${action}
    </div>
  `;
}

/* =========================================================
   VEHICLE / MILEAGE
   ========================================================= */
async function latestMileage(plate) {
  if (!plate) return '';

  try {
    if (supabaseClient) {
      const { data: usageData } = await supabaseClient
        .from('usages')
        .select('end_mileage, created_at, date')
        .eq('plate', plate)
        .not('end_mileage', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1);

      const { data: fuelData } = await supabaseClient
        .from('fuels')
        .select('mileage, created_at, date')
        .eq('plate', plate)
        .not('mileage', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1);

      const latestUsage = usageData?.[0];
      const latestFuel = fuelData?.[0];

      if (latestUsage && latestFuel) {
        const uTime = new Date(latestUsage.created_at || latestUsage.date).getTime();
        const fTime = new Date(latestFuel.created_at || latestFuel.date).getTime();
        return uTime >= fTime ? Number(latestUsage.end_mileage) : Number(latestFuel.mileage);
      } else if (latestUsage) {
        return Number(latestUsage.end_mileage);
      } else if (latestFuel) {
        return Number(latestFuel.mileage);
      }
    }
  } catch (err) {
    console.warn('Fetch latest mileage error:', err);
  }

  return '';
}

function getVehicle(plate) {
  return db.vehicles.find((item) => item.plate === plate);
}

function vehicleOptions(selected = '') {
  // หากสแกน QR Code มาจะล็อกเฉพาะรถคันนั้น แต่ถ้าล็อกอินทั่วไปจะให้เลือกได้ทุกคัน
  const visibleVehicles = state.role === 'user' && state.vehicle ? [state.vehicle] : db.vehicles;

  return visibleVehicles
    .map(
      (vehicle) => `
        <option value="${esc(vehicle.plate)}" ${vehicle.plate === selected ? 'selected' : ''}>
          ${esc(vehicle.plate)} - ${esc(vehicle.model)}
        </option>
      `,
    )
    .join('');
}

function renderVehicleCard(plate) {
  const vehicle = getVehicle(plate);
  return vehicle
    ? `
      <div class="vehicle-card">
        <strong>${esc(vehicle.plate)}</strong>
        <p>${esc(vehicle.model)} · สถานะ: ${esc(vehicle.status)}</p>
      </div>
    `
    : '';
}

function recordTabs(active) {
  return `
    <div class="tabs">
      <button data-record-tab="usage" type="button" class="${active === 'usage' ? 'active' : ''}">บันทึกการใช้รถ</button>
      <button data-record-tab="fuel" type="button" class="${active === 'fuel' ? 'active' : ''}">บันทึกเติมน้ำมัน</button>
      <button data-record-tab="service" type="button" class="${active === 'service' ? 'active' : ''}">บันทึกเช็คระยะ</button>
    </div>
  `;
}

/* =========================================================
   FORMS (USAGE / FUEL / SERVICE)
   ========================================================= */
async function usageForm(record = {}, context = 'user') {
  const plate = record.plate || state.vehicle?.plate || db.vehicles[0]?.plate || '';
  const start = record.startMileage ?? (await latestMileage(plate));

  return `
    <form class="record-form" data-kind="usage" data-context="${context}" data-id="${record.id || ''}">
      <div class="grid two">
        <div class="field">
          <label>วันที่บันทึก</label>
          <input required type="date" name="date" value="${record.date || today()}" />
        </div>
        <div class="field">
          <label>ชื่อผู้ขับขี่</label>
          <input required name="driver" value="${esc(record.driver || state.user?.name || '')}" />
        </div>
        <div class="field">
          <label>ทะเบียนรถ</label>
          <select required name="plate">${vehicleOptions(plate)}</select>
        </div>
        <div class="field">
          <label>หน่วยงาน</label>
          <input name="department" value="${esc(record.department || 'ศูนย์วิศวกรรมขายฯ')}" />
        </div>
        <div class="field">
          <label>เวลาออกเดินทาง</label>
          <input required type="time" name="depart" value="${record.depart || ''}" />
        </div>
        <div class="field">
          <label>เวลาเดินทางกลับ</label>
          <input required type="time" name="return" value="${record.return || ''}" />
        </div>
        <div class="field">
          <label>เลขไมล์เริ่มต้น (กม.)</label>
          <input required min="0" type="number" name="startMileage" value="${start}" />
        </div>
        <div class="field">
          <label>เลขไมล์สิ้นสุด (กม.)</label>
          <input required min="0" type="number" name="endMileage" value="${record.endMileage || ''}" />
        </div>
      </div>
      <div class="field">
        <label>วัตถุประสงค์ / หน้างานที่ไปปฏิบัติ</label>
        <input required name="purpose" value="${esc(record.purpose || '')}" placeholder="ระบุวัตถุประสงค์การเดินทาง" />
      </div>
      <div class="field">
        <label>หมายเหตุ</label>
        <textarea name="note" placeholder="ข้อมูลเพิ่มเติม (ถ้ามี)">${esc(record.note || '')}</textarea>
      </div>
      <div class="button-row">
        <button class="button" type="submit">${record.id ? 'บันทึกการแก้ไข' : 'บันทึกการใช้งานรถ'}</button>
      </div>
    </form>
  `;
}

async function fuelForm(record = {}, context = 'user') {
  const plate = record.plate || state.vehicle?.plate || db.vehicles[0]?.plate || '';
  const currentMileage = record.mileage || (await latestMileage(plate)) || '';
  const vehicleObj = getVehicle(plate);
  const cardBalance = vehicleObj?.fleetCardBalance ?? 0;
  const currentPayment = record.payment || 'Fleet Card';

  return `
    <form class="record-form" data-kind="fuel" data-context="${context}" data-id="${record.id || ''}">
      <div class="grid two">
        <div class="field">
          <label>วันที่เติมน้ำมัน</label>
          <input required type="date" name="date" value="${record.date || today()}" />
        </div>
        <div class="field">
          <label>ผู้บันทึก</label>
          <input required name="driver" value="${esc(record.driver || state.user?.name || '')}" />
        </div>
        <div class="field">
          <label>ทะเบียนรถ</label>
          <select required name="plate" id="fuel-plate-select">${vehicleOptions(plate)}</select>
        </div>
        <div class="field">
          <label>เลขไมล์ขณะเติม</label>
          <input required min="0" type="number" name="mileage" value="${currentMileage}" />
        </div>
        <div class="field">
          <label>ประเภทน้ำมัน</label>
          <select required name="type">
            <option value="ดีเซล" ${record.type === 'ดีเซล' ? 'selected' : ''}>ดีเซล</option>
            <option value="เบนซิน" ${record.type === 'เบนซิน' ? 'selected' : ''}>เบนซิน</option>
            <option value="แก๊สโซฮอล์" ${record.type === 'แก๊สโซฮอล์' ? 'selected' : ''}>แก๊สโซฮอล์</option>
          </select>
        </div>
        <div class="field">
          <label>จำนวนลิตร</label>
          <input required min="0" step="0.01" type="number" name="liters" value="${record.liters || ''}" />
        </div>
        <div class="field">
          <label>จำนวนเงินรวม (บาท)</label>
          <input required min="0" step="0.01" type="number" name="amount" id="fuel-amount-input" value="${record.amount || ''}" />
        </div>
        <div class="field">
          <label>วิธีชำระเงิน</label>
          <select required name="payment" id="fuel-payment-select">
            <option value="Fleet Card" ${currentPayment === 'Fleet Card' ? 'selected' : ''}>Fleet Card</option>
            <option value="เงินสด" ${currentPayment === 'เงินสด' ? 'selected' : ''}>เงินสด</option>
            <option value="โอน" ${currentPayment === 'โอน' ? 'selected' : ''}>โอน</option>
          </select>
        </div>
      </div>

      <!-- กล่องแสดงสถานะและคำนวณยอดเงิน Fleet Card แบบ Real-time -->
      <div id="fleet-card-status-box" class="fleet-card-info-box" style="${currentPayment === 'Fleet Card' ? '' : 'display: none;'}">
        <div class="fleet-card-info-header">
          <span>💳 ข้อมูลบัตร Fleet Card ประจำรถ (<span id="fleet-card-plate-display">${esc(plate)}</span>)</span>
          <small id="fleet-card-number-display">${vehicleObj?.fleetCardNumber ? `เลขบัตร: ${esc(vehicleObj.fleetCardNumber)}` : 'บัตรประจำคัน'}</small>
        </div>
        <div class="fleet-card-calc-grid">
          <div>
            <small>ยอดเงินในบัตรปัจจุบัน</small>
            <strong id="fleet-card-current-bal">${money(cardBalance)}</strong>
          </div>
          <div>
            <small>ยอดที่เติมครั้งนี้</small>
            <strong id="fleet-card-fill-amount" style="color: var(--danger);">-฿0</strong>
          </div>
          <div>
            <small>ยอดเงินคงเหลือหลังเติม</small>
            <strong id="fleet-card-remaining-bal" style="color: var(--success);">${money(cardBalance)}</strong>
          </div>
        </div>
        <div id="fleet-card-warning" class="fleet-card-alert" style="display: none;">
          ⚠️ ยอดเงินใน Fleet Card ไม่เพียงพอสำหรับการเติมครั้งนี้ (ยอดคงเหลือติดลบ)
        </div>
      </div>

      <div class="field">
        <label>อัปโหลดรูปสลิปใบเสร็จ</label>
        <input type="file" accept="image/*" name="receiptFile" />
        <div class="file-name">${record.receipt ? 'มีเอกสารหลักฐานแนบแล้ว' : 'ยังไม่ได้แนบเอกสาร'}</div>
      </div>
      <div class="button-row">
        <button class="button" type="submit">${record.id ? 'บันทึกการแก้ไข' : 'บันทึกการเติมน้ำมัน'}</button>
      </div>
    </form>
  `;
}

async function serviceForm(record = {}) {
  const plate = record.plate || state.vehicle?.plate || db.vehicles[0]?.plate || '';
  const currentMileage = record.mileage || (await latestMileage(plate)) || '';

  return `
    <form class="record-form" data-kind="service" data-id="${record.id || ''}">
      <div class="grid two">
        <div class="field">
          <label>วันที่ตรวจเช็ค</label>
          <input required type="date" name="date" value="${record.date || today()}" />
        </div>
        <div class="field">
          <label>ทะเบียนรถ</label>
          <select required name="plate">${vehicleOptions(plate)}</select>
        </div>
        <div class="field">
          <label>เลขไมล์ปัจจุบัน</label>
          <input required min="0" type="number" name="mileage" value="${currentMileage}" />
        </div>
        <div class="field">
          <label>ประเภทการตรวจเช็ค</label>
          <input required name="serviceType" value="${esc(record.serviceType || '')}" placeholder="เช่น เปลี่ยนถ่ายน้ำมันเครื่อง" />
        </div>
      </div>
      <div class="field">
        <label>รายละเอียด / หมายเหตุ</label>
        <textarea name="note">${esc(record.note || '')}</textarea>
      </div>
      <div class="button-row">
        <button class="button" type="submit">บันทึกเช็คระยะ</button>
      </div>
    </form>
  `;
}

/* =========================================================
   ENTRY VIEW
   ========================================================= */
async function renderEntry(context = 'user') {
  const page = document.querySelector('#page');
  if (!page) return;

  const tab = state.userTab;
  const selectedPlate = (state.edit || {}).plate || state.vehicle?.plate || db.vehicles[0]?.plate;

  const titleMap = { usage: 'บันทึกการใช้รถ', fuel: 'บันทึกเติมน้ำมัน', service: 'บันทึกเช็คระยะ' };
  const title = context === 'admin' ? 'บันทึกข้อมูล' : titleMap[tab] || 'บันทึกข้อมูลรถส่วนกลาง';
  const description = context === 'admin' ? 'ผู้ดูแลระบบสามารถบันทึกข้อมูลแทนพนักงานได้' : (state.vehicle ? 'บันทึกข้อมูลสำหรับรถที่สแกนจาก QR Code' : 'บันทึกข้อมูลการใช้งานยานพาหนะส่วนกลาง');

  const form =
    tab === 'usage'
      ? await usageForm(state.edit || {}, context)
      : tab === 'fuel'
      ? await fuelForm(state.edit || {}, context)
      : await serviceForm(state.edit || {});

  page.innerHTML = `
    ${pageHead(title, description)}
    <div class="entry-layout">
      <section class="card vehicle-context-card">
        <div class="card-header">
          <div>
            <h3>รถที่กำลังบันทึก</h3>
            <p>${state.vehicle ? 'ข้อมูลรถจาก QR Code ที่สแกน' : 'เลือกเปลี่ยนทะเบียนรถได้จากฟอร์มบันทึก'}</p>
          </div>
          <span class="status-dot-label"><i></i>${esc((getVehicle(selectedPlate) || state.vehicle)?.status || 'พร้อมใช้งาน')}</span>
        </div>
        <div id="active-vehicle-card-area">
          ${renderVehicleCard(selectedPlate)}
        </div>
        ${context === 'user' && state.vehicle ? `<p class="hint">พนักงานไม่สามารถเปลี่ยนรถในรายการได้ เนื่องจากรถถูกระบุจาก QR Code ที่สแกน</p>` : ''}
      </section>

      <section class="card record-card">
        <div class="card-header">
          <div>
            <h3>${title}</h3>
            <p>${description}</p>
          </div>
        </div>
        ${recordTabs(tab)}
        <div id="record-form-area">${form}</div>
      </section>
    </div>
  `;

  bindEntry(context);
}

function bindEntry(context) {
  document.querySelectorAll('[data-record-tab]').forEach((button) => {
    button.addEventListener('click', async () => {
      state.userTab = button.dataset.recordTab;
      state.edit = null;
      await renderEntry(context);
    });
  });

  const form = document.querySelector('.record-form');
  form?.addEventListener('submit', saveRecord);

  // การคำนวณและอัปเดตยอด Fleet Card แบบ Real-time
  const updateFleetCardDisplay = () => {
    const paymentSelect = document.querySelector('#fuel-payment-select');
    const plateSelect = document.querySelector('[name=plate]');
    const amountInput = document.querySelector('#fuel-amount-input');
    const box = document.querySelector('#fleet-card-status-box');
    if (!box || !paymentSelect) return;

    if (paymentSelect.value !== 'Fleet Card') {
      box.style.display = 'none';
      return;
    }

    box.style.display = 'block';
    const plate = plateSelect?.value || state.vehicle?.plate || '';
    const vehicleObj = getVehicle(plate);
    const balance = Number(vehicleObj?.fleetCardBalance || 0);
    const amount = Number(amountInput?.value || 0);
    const remaining = balance - amount;

    const plateDisplay = document.querySelector('#fleet-card-plate-display');
    const numDisplay = document.querySelector('#fleet-card-number-display');
    const currentBalEl = document.querySelector('#fleet-card-current-bal');
    const fillAmountEl = document.querySelector('#fleet-card-fill-amount');
    const remBalEl = document.querySelector('#fleet-card-remaining-bal');
    const warningEl = document.querySelector('#fleet-card-warning');

    if (plateDisplay) plateDisplay.textContent = plate;
    if (numDisplay) numDisplay.textContent = vehicleObj?.fleetCardNumber ? `เลขบัตร: ${vehicleObj.fleetCardNumber}` : 'บัตรประจำคัน';
    if (currentBalEl) currentBalEl.textContent = money(balance);
    if (fillAmountEl) fillAmountEl.textContent = amount > 0 ? `-${money(amount)}` : '฿0';

    if (remBalEl) {
      remBalEl.textContent = money(remaining);
      remBalEl.style.color = remaining < 0 ? 'var(--danger)' : 'var(--success)';
    }

    if (warningEl) {
      warningEl.style.display = remaining < 0 ? 'block' : 'none';
    }
  };

  document.querySelector('#fuel-payment-select')?.addEventListener('change', updateFleetCardDisplay);
  document.querySelector('#fuel-amount-input')?.addEventListener('input', updateFleetCardDisplay);

  document.querySelector('[name=plate]')?.addEventListener('change', async (event) => {
    const selectedPlate = event.target.value;
    const input = document.querySelector('[name=startMileage], [name=mileage]');
    if (input) {
      input.value = (await latestMileage(selectedPlate)) || '';
    }
    
    // อัปเดตกล่องแสดงข้อมูลรถด้านบนตามทะเบียนที่เลือก
    const cardArea = document.querySelector('#active-vehicle-card-area');
    if (cardArea) {
      cardArea.innerHTML = renderVehicleCard(selectedPlate);
    }

    updateFleetCardDisplay();
  });

  updateFleetCardDisplay();
}

/* =========================================================
   SAVE RECORD: CLOUD-FIRST WRITE DIRECT TO SUPABASE + TELEGRAM
   ========================================================= */
function formToRecord(form) {
  const fd = new FormData(form);
  return Object.fromEntries([...fd.entries()].filter(([key]) => key !== 'receiptFile'));
}

async function saveRecord(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const submitBtn = form.querySelector('[type=submit]');
  const kind = form.dataset.kind;
  const record = formToRecord(form);

  record.employeeId = state.user?.employeeId || '';
  if (!record.employeeId) {
    return toast('ไม่พบรหัสพนักงาน กรุณาเข้าสู่ระบบใหม่อีกครั้ง', 'error');
  }

  // หากสแกน QR Code มาให้ใช้ทะเบียนที่สแกน แต่ถ้าไม่ได้สแกนให้ใช้ทะเบียนที่เลือกจากฟอร์ม
  if (state.role === 'user' && state.vehicle) {
    record.plate = state.vehicle.plate;
  }

  if (kind === 'usage') {
    record.startMileage = Number(record.startMileage);
    record.endMileage = Number(record.endMileage);
    if (record.endMileage < record.startMileage) {
      return toast('เลขไมล์สิ้นสุดต้องไม่น้อยกว่าเลขไมล์เริ่มต้น', 'error');
    }
  }

  if (kind === 'fuel') {
    record.mileage = Number(record.mileage);
    record.liters = Number(record.liters);
    record.amount = Number(record.amount);

    const file = form.querySelector('[name=receiptFile]')?.files?.[0];
    if (file) {
      const fileExt = (file.name.split('.').pop() || 'jpg').toLowerCase();
      const cleanEmployeeId = String(record.employeeId).replace(/[^a-zA-Z0-9_-]/g, '');
      const filePath = `receipts/${cleanEmployeeId}_${Date.now()}.${fileExt}`;
      record.receipt = await uploadFileToSupabase('profiles', filePath, file);
    } else if (form.dataset.id) {
      record.receipt = db.fuels.find((item) => item.id === form.dataset.id)?.receipt || '';
    }
    if (!form.dataset.id) {
      record.approved = false;
    }
  }

  if (kind === 'service') {
    record.mileage = Number(record.mileage);
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'กำลังบันทึกลงฐานข้อมูลคลาวด์...';
  }

  try {
    if (!supabaseClient) {
      throw new Error('ระบบไม่ได้เชื่อมต่อ Supabase');
    }

    const isNew = !form.dataset.id;

    if (kind === 'usage') {
      const payload = {
        employee_id: record.employeeId,
        driver: record.driver,
        plate: record.plate,
        department: record.department,
        date: record.date,
        depart: record.depart,
        return: record.return,
        start_mileage: record.startMileage,
        end_mileage: record.endMileage,
        purpose: record.purpose,
        note: record.note,
      };

      if (!isNew) {
        const { error } = await supabaseClient.from('usages').update(payload).eq('id', form.dataset.id);
        if (error) throw error;
      } else {
        const { error } = await supabaseClient.from('usages').insert(payload);
        if (error) throw error;
      }
    } else if (kind === 'fuel') {
      const payload = {
        employee_id: record.employeeId,
        driver: record.driver,
        plate: record.plate,
        date: record.date,
        mileage: record.mileage,
        type: record.type,
        liters: record.liters,
        amount: record.amount,
        payment: record.payment,
        receipt_url: record.receipt || '',
        approved: record.approved || false,
      };

      if (!isNew) {
        const { error } = await supabaseClient.from('fuels').update(payload).eq('id', form.dataset.id);
        if (error) throw error;
      } else {
        const { error } = await supabaseClient.from('fuels').insert(payload);
        if (error) throw error;

        // หักเงินในบัตร Fleet Card เมื่อเลือกวิธีชำระเป็น Fleet Card
        let remainingFleetBalance = null;
        if (record.payment === 'Fleet Card') {
          const targetVehicle = getVehicle(record.plate);
          const currentBal = Number(targetVehicle?.fleetCardBalance || 0);
          remainingFleetBalance = currentBal - Number(record.amount);

          const { error: vError } = await supabaseClient
            .from('vehicles')
            .update({ fleet_card_balance: remainingFleetBalance })
            .eq('plate', record.plate);

          if (vError) {
            console.error('หักเงิน Fleet Card ไม่สำเร็จ:', vError);
          } else {
            if (targetVehicle) targetVehicle.fleetCardBalance = remainingFleetBalance;
            await addAudit(
              'หักเงิน Fleet Card',
              `รถทะเบียน ${record.plate} เติมน้ำมัน ฿${record.amount.toLocaleString()} | คงเหลือ ฿${remainingFleetBalance.toLocaleString()}`
            );
          }
        }
      }
    } else if (kind === 'service') {
      const payload = {
        employee_id: record.employeeId,
        date: record.date,
        plate: record.plate,
        mileage: record.mileage,
        service_type: record.serviceType,
        note: record.note,
      };

      if (!isNew) {
        const { error } = await supabaseClient.from('services').update(payload).eq('id', form.dataset.id);
        if (error) throw error;
      } else {
        const { error } = await supabaseClient.from('services').insert(payload);
        if (error) throw error;
      }
    }

    if (isNew) {
      let telegramMsg = '';
      const formattedDate = thaiDate(record.date);

      if (kind === 'usage') {
        const dist = Math.max(0, record.endMileage - record.startMileage);
        telegramMsg =
          `🚗 <b>มีบันทึกการใช้รถใหม่</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `<b>วันที่:</b> ${formattedDate}\n` +
          `<b>ทะเบียน:</b> ${record.plate}\n` +
          `<b>ผู้ขับขี่:</b> ${record.driver} (${record.employeeId})\n` +
          `<b>หน่วยงาน:</b> ${record.department || '-'}\n` +
          `<b>เวลาเดินทาง:</b> ${record.depart} - ${record.return}\n` +
          `<b>ระยะทาง:</b> ${dist.toLocaleString()} กม. (ไมล์ ${record.startMileage} -> ${record.endMileage})\n` +
          `<b>วัตถุประสงค์:</b> ${record.purpose}\n` +
          (record.note ? `<b>หมายเหตุ:</b> ${record.note}\n` : '');
      } else if (kind === 'fuel') {
        const vehicleObj = getVehicle(record.plate);
        const cardBalText = record.payment === 'Fleet Card'
          ? `\n💳 <b>ยอดคงเหลือ Fleet Card:</b> ${money(vehicleObj?.fleetCardBalance || 0)}`
          : '';

        telegramMsg =
          `⛽ <b>มีบันทึกการเติมน้ำมันใหม่</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `<b>วันที่:</b> ${formattedDate}\n` +
          `<b>ทะเบียน:</b> ${record.plate}\n` +
          `<b>ผู้บันทึก:</b> ${record.driver} (${record.employeeId})\n` +
          `<b>ประเภท:</b> ${record.type}\n` +
          `<b>จำนวน:</b> ${Number(record.liters).toFixed(2)} ลิตร\n` +
          `<b>ยอดเงิน:</b> ${Number(record.amount).toLocaleString()} บาท\n` +
          `<b>ชำระโดย:</b> ${record.payment}${cardBalText}\n` +
          `<b>เลขไมล์:</b> ${record.mileage.toLocaleString()} กม.\n` +
          (record.receipt ? `<b>แนบสลิป:</b> มีรูปหลักฐานแนบแล้ว\n` : '');
      } else if (kind === 'service') {
        telegramMsg =
          `🔧 <b>มีบันทึกการเช็คระยะใหม่</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `<b>วันที่:</b> ${formattedDate}\n` +
          `<b>ทะเบียน:</b> ${record.plate}\n` +
          `<b>ผู้บันทึก:</b> รหัสพนักงาน ${record.employeeId}\n` +
          `<b>ประเภท:</b> ${record.serviceType}\n` +
          `<b>เลขไมล์:</b> ${record.mileage.toLocaleString()} กม.\n` +
          (record.note ? `<b>รายละเอียด:</b> ${record.note}\n` : '');
      }

      if (telegramMsg) {
        await sendTelegramNotification(telegramMsg);
      }

      if (kind === 'usage' && record.endMileage) {
        await checkServiceMileageAlert(record.plate, record.endMileage, record.driver);
      } else if (kind === 'fuel' && record.mileage) {
        await checkServiceMileageAlert(record.plate, record.mileage, record.driver);
      }
    }

    await addAudit(form.dataset.id ? 'แก้ไขข้อมูล' : 'บันทึกข้อมูล', `${kind}: ${record.plate}`);
    await syncRemoteData();

    state.edit = null;
    toast(form.dataset.id ? 'บันทึกการแก้ไขขึ้นคลาวด์เรียบร้อย' : 'บันทึกข้อมูลขึ้นคลาวด์เรียบร้อย');
    await renderApp();
  } catch (err) {
    console.error('Save Record Database Error:', err);
    toast('บันทึกลงฐานข้อมูลไม่สำเร็จ: ' + err.message, 'error');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = form.dataset.id ? 'บันทึกการแก้ไข' : 'บันทึกข้อมูล';
    }
  }
}

/* =========================================================
   USER HISTORY
   ========================================================= */
function userHistory() {
  const records = [
    ...db.usages.filter((item) => item.driver === state.user.name).map((item) => ({ ...item, kind: 'การใช้รถ' })),
    ...db.fuels.filter((item) => item.driver === state.user.name).map((item) => ({ ...item, kind: 'เติมน้ำมัน' })),
  ].sort((a, b) => b.date.localeCompare(a.date));

  const page = document.querySelector('#page');
  page.innerHTML = `
    ${pageHead('ประวัติการบันทึกของฉัน', 'ตรวจสอบรายการใช้รถและเติมน้ำมันที่บันทึกโดยบัญชีนี้')}
    <section class="card history-card">
      <div class="mobile-history-list">
        ${
          records.length
            ? records
                .map(
                  (item) => `
                    <article class="history-item">
                      <div class="history-item-top">
                        <div>
                          <span class="history-kind">${item.kind}</span>
                          <strong>${esc(item.plate)}</strong>
                        </div>
                        ${
                          item.kind === 'เติมน้ำมัน'
                            ? `<span class="tag ${item.approved ? 'approved' : 'pending'}">${item.approved ? 'อนุมัติแล้ว' : 'รออนุมัติ'}</span>`
                            : `<span class="tag approved">บันทึกแล้ว</span>`
                        }
                      </div>
                      <div class="history-item-date">${thaiDate(item.date)}</div>
                      <div class="history-item-detail">
                        ${
                          item.kind === 'การใช้รถ'
                            ? `ระยะทาง ${number(mileage(item))} กม.<br />${esc(item.purpose || '-')}`
                            : `${number(item.liters, 2)} ลิตร · ${money(item.amount)}`
                        }
                      </div>
                    </article>
                  `,
                )
                .join('')
            : `<div class="empty">ยังไม่มีรายการที่บันทึกโดยผู้ใช้นี้</div>`
        }
      </div>

      ${
        records.length
          ? `
            <div class="table-wrap desktop-history-table">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>วันที่</th>
                    <th>ประเภท</th>
                    <th>ทะเบียน</th>
                    <th>รายละเอียด</th>
                    <th>สถานะ</th>
                  </tr>
                </thead>
                <tbody>
                  ${records
                    .map(
                      (item) => `
                        <tr>
                          <td>${thaiDate(item.date)}</td>
                          <td>${item.kind}</td>
                          <td>${esc(item.plate)}</td>
                          <td>
                            ${
                              item.kind === 'การใช้รถ'
                                ? `ระยะทาง ${number(mileage(item))} กม. · ${esc(item.purpose || '-')}`
                                : `${number(item.liters, 2)} ลิตร · ${money(item.amount)}`
                            }
                          </td>
                          <td>
                            ${
                              item.kind === 'เติมน้ำมัน'
                                ? `<span class="tag ${item.approved ? 'approved' : 'pending'}">${item.approved ? 'อนุมัติแล้ว' : 'รออนุมัติ'}</span>`
                                : `<span class="tag approved">บันทึกแล้ว</span>`
                            }
                          </td>
                        </tr>
                      `,
                    )
                    .join('')}
                </tbody>
              </table>
            </div>
          `
          : ''
      }
    </section>
  `;
}

/* =========================================================
   PROFILE
   ========================================================= */
function renderProfile() {
  const profile = loadProfile();
  const lastLogin = localStorage.getItem('nt-fms-last-login') || new Date().toISOString();
  const lastLoginText = new Intl.DateTimeFormat('th-TH', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Bangkok',
  }).format(new Date(lastLogin));

  const avatarUrl = state.user?.profileImage || profile.avatar || '';
  const avatar = avatarMarkup(avatarUrl, state.user?.name);

  const page = document.querySelector('#page');
  page.innerHTML = `
    ${pageHead('Profile', 'จัดการข้อมูลบัญชีและการติดต่อของคุณ')}
    <div class="profile-grid">
      <section class="card profile-card">
        <div class="profile-hero">
          <div class="profile-avatar-large">${avatar}</div>
          <div>
            <div class="profile-kicker">${state.role === 'admin' ? 'ผู้ดูแลระบบ' : 'พนักงาน'}</div>
            <h3>${esc(state.user?.name || 'ผู้ใช้งาน')}</h3>
            <p>Employee ID: ${esc(state.user?.employeeId || '-')}</p>
          </div>
        </div>

        <div class="field">
          <label>Avatar</label>
          <input id="profile-avatar" type="file" accept="image/jpeg,image/png,image/webp" />
          <div class="file-name">${state.user?.profileImage || profile.avatar ? 'มีรูปโปรไฟล์อยู่แล้ว' : 'ยังไม่ได้เลือกรูป'}</div>
          <div class="hint">แนะนำไฟล์รูปขนาดไม่เกิน 3 MB (JPG, PNG, WEBP)</div>
        </div>

        <div class="field">
          <label>Name</label>
          <input id="profile-name" value="${esc(state.user?.name || '')}" disabled />
        </div>

        <div class="field">
          <label>E-mail</label>
          <input id="profile-email" type="email" placeholder="example@ntplc.co.th" value="${esc(state.user?.email || '')}" />
        </div>

        <div class="field">
          <label>เบอร์โทรศัพท์</label>
          <input id="profile-phone" type="tel" placeholder="เช่น 081-234-5678" value="${esc(state.user?.phone || '')}" />
        </div>

        <div class="button-row">
          <button class="button" id="save-profile" type="button">บันทึก Profile</button>
        </div>
      </section>

      <section class="card profile-info-card">
        <div class="card-header">
          <div>
            <h3>Account Information</h3>
            <p>ข้อมูลบัญชีที่กำลังใช้งาน</p>
          </div>
        </div>
        <div class="profile-info-list">
          <div class="profile-info-row">
            <span>ชื่อผู้ใช้งาน</span>
            <strong>${esc(state.user?.name || '-')}</strong>
          </div>
          <div class="profile-info-row">
            <span>รหัสพนักงาน</span>
            <strong>${esc(state.user?.employeeId || '-')}</strong>
          </div>
          <div class="profile-info-row">
            <span>สิทธิ์</span>
            <strong>${state.role === 'admin' ? 'ผู้ดูแลระบบ' : 'พนักงาน'}</strong>
          </div>
          <div class="profile-info-row">
            <span>เบอร์โทรศัพท์</span>
            <strong>${esc(state.user?.phone || '-')}</strong>
          </div>
          <div class="profile-info-row">
            <span>รถที่กำลังใช้งาน</span>
            <strong>${esc(state.vehicle?.plate || 'เลือกรายคัน')}</strong>
          </div>
          <div class="profile-info-row">
            <span>Last login</span>
            <strong>${lastLoginText}</strong>
          </div>
        </div>
      </section>  
    </div>
  `;

  document.querySelector('#save-profile')?.addEventListener('click', async () => {
    const fileInput = document.querySelector('#profile-avatar');
    const file = fileInput?.files?.[0];
    const saveBtn = document.querySelector('#save-profile');

    let avatarUrl = state.user?.profileImage || profile.avatar || '';

    try {
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = file ? 'กำลังอัปโหลดรูป...' : 'กำลังบันทึก...';
      }

      if (file) {
        const rawId = String(state.user?.employeeId || '1001').trim().replace(/[^a-zA-Z0-9_-]/g, '');
        const fileExt = file.name.split('.').pop() || 'jpg';
        const fileName = `${rawId}/avatar_${Date.now()}.${fileExt}`;
        avatarUrl = await uploadFileToSupabase('profiles', fileName, file);
      }

      const email = document.querySelector('#profile-email')?.value.trim() || '';
      const phone = document.querySelector('#profile-phone')?.value.trim() || '';

      if (supabaseClient && state.user?.employeeId) {
        const cleanUrl = avatarUrl ? avatarUrl.split('?')[0] : '';
        const { error } = await supabaseClient
          .from('employees')
          .update({ profile_image: cleanUrl, phone: phone })
          .eq('employee_id', state.user.employeeId);

        if (error) throw error;
      }

      const displayAvatarUrl = avatarUrl ? `${avatarUrl.split('?')[0]}?t=${Date.now()}` : '';

      saveProfile({ avatar: avatarUrl, email, phone });
      state.user = { ...state.user, email, phone, profileImage: displayAvatarUrl };

      localStorage.setItem('nt-fms-user', JSON.stringify(state.user));
      localStorage.setItem('nt-fms-last-login', new Date().toISOString());

      toast('บันทึกข้อมูล Profile สำเร็จ');
      await renderApp();
    } catch (error) {
      console.error('Save Profile Error:', error);
      toast(`บันทึกไม่สำเร็จ: ${error?.message || 'เกิดข้อผิดพลาด'}`, 'error');
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'บันทึก Profile';
      }
    }
  });
}

/* =========================================================
   DASHBOARD & DATA AGGREGATION
   ========================================================= */
function monthData(month = bangkokMonthKey(), department = 'ทั้งหมด') {
  const inMonth = (item) => String(item.date || '').slice(0, 7) === month;

  let usages = db.usages.filter(inMonth);
  let fuels = db.fuels.filter(inMonth);

  if (department && department !== 'ทั้งหมด') {
    const targetPlates = new Set(
      db.vehicles
        .filter((v) => (v.department || '').trim() === department.trim())
        .map((v) => v.plate)
    );

    usages = usages.filter(
      (item) => targetPlates.has(item.plate) || (item.department || '').trim() === department.trim()
    );

    fuels = fuels.filter((item) => targetPlates.has(item.plate));
  }

  const distance = usages.reduce((sum, item) => sum + mileage(item), 0);
  const liters = fuels.reduce((sum, item) => sum + Number(item.liters || 0), 0);
  const amount = fuels.reduce((sum, item) => sum + Number(item.amount || 0), 0);

  return {
    usages,
    fuels,
    distance,
    liters,
    amount,
    efficiency: liters ? distance / liters : 0,
  };
}

function statsMarkup(data, month = bangkokMonthKey()) {
  return `
    <div class="grid dashboard">
      <article class="stat-card">
        <div class="label">ระยะทางรวม</div>
        <div class="value">${number(data.distance)} กม.</div>
        <div class="sub">จาก ${data.usages.length} รายการใช้รถ</div>
      </article>

      <article class="stat-card">
        <div class="label">ค่าน้ำมันรวม</div>
        <div class="value">${money(data.amount)}</div>
        <div class="sub">${number(data.liters, 2)} ลิตร</div>
      </article>

      <article class="stat-card">
        <div class="label">อัตราสิ้นเปลืองเฉลี่ย</div>
        <div class="value">${number(data.efficiency, 2)} กม./ลิตร</div>
        <div class="sub">คำนวณจากข้อมูล ${thaiMonth(month)}</div>
      </article>
    </div>
  `;
}

function dashboardMarkup(data) {
  const amountByPlate = Object.entries(
    data.fuels.reduce((map, item) => {
      map[item.plate] = (map[item.plate] || 0) + Number(item.amount || 0);
      return map;
    }, {}),
  );

  const usageByDepartment = Object.entries(
    data.usages.reduce((map, item) => {
      const department = item.department || 'ไม่ระบุหน่วยงาน';
      map[department] = (map[department] || 0) + 1;
      return map;
    }, {}),
  );

  const fuelMaximum = Math.max(...amountByPlate.map(([, amount]) => amount), 1);
  const usageMaximum = Math.max(...usageByDepartment.map(([, count]) => count), 1);

  const barRows = (items, maximum, format) =>
    items.length
      ? items
          .map(
            ([label, value]) => `
              <div class="bar-item">
                <span title="${esc(label)}">${esc(label)}</span>
                <div class="bar-track">
                  <div class="bar-fill" style="width:${Math.max((Number(value) / maximum) * 100, 3)}%"></div>
                </div>
                <strong>${format(value)}</strong>
              </div>
            `,
          )
          .join('')
      : `<div class="empty">ยังไม่มีข้อมูลในเดือนนี้</div>`;

  return `
    <div class="chart-layout">
      <section class="card">
        <div class="card-heading">
          <div>
            <h3>ค่าน้ำมันแยกรายคัน</h3>
            <p>เปรียบเทียบยอดค่าใช้จ่ายของเดือนปัจจุบัน</p>
          </div>
          <span class="data-count">${amountByPlate.length} คัน</span>
        </div>
        <div class="bar-chart">${barRows(amountByPlate, fuelMaximum, money)}</div>
      </section>

      <section class="card">
        <div class="card-heading">
          <div>
            <h3>การใช้รถตามหน่วยงาน</h3>
            <p>อ้างอิงจากรายการใช้รถที่บันทึกแล้ว</p>
          </div>
          <span class="data-count">${data.usages.length} รายการ</span>
        </div>
        <div class="bar-chart department-chart">
          ${barRows(usageByDepartment, usageMaximum, (val) => `${number(val)} รายการ`)}
        </div>
      </section>
    </div>
  `;
}

function renderDashboard(admin = false) {
  const month = bangkokMonthKey();
  const data = monthData(month, 'ทั้งหมด');
  const source = `เชื่อมต่อ Supabase · อัปเดตล่าสุด ${lastSyncLabel()}`;

  const actions = `
    <div class="dashboard-actions">
      <span class="live-status">
        <i></i>
        ${esc(source)}
      </span>
      <button class="ghost-button" id="refresh-dashboard" type="button">↻ อัปเดตข้อมูล</button>
    </div>
  `;

  document.querySelector('#page').innerHTML = `
    ${pageHead(
      admin ? 'ภาพรวมการใช้งานรถ' : 'ภาพรวมรายเดือน',
      `สรุปข้อมูลของเดือน${thaiMonth(month)} — ระบบจะเริ่มนับใหม่อัตโนมัติเมื่อขึ้นเดือนใหม่`,
      actions,
    )}
    ${statsMarkup(data, month)}
    <div class="report-section">${dashboardMarkup(data)}</div>
  `;

  document.querySelector('#refresh-dashboard')?.addEventListener('click', () => refreshDashboardNow(admin));
}

function dashboardViewActive() {
  return state.view === 'admin-dashboard' || state.view === 'user-dashboard';
}

function updateDashboardRefresh() {
  clearInterval(dashboardRefreshTimer);
  dashboardRefreshTimer = null;

  if (!state.user || !dashboardViewActive()) return;

  dashboardRefreshTimer = setInterval(async () => {
    if (!dashboardViewActive() || document.hidden) return;
    try {
      await syncRemoteData();
      renderDashboard(state.view === 'admin-dashboard');
    } catch {
      // Keep state
    }
  }, DASHBOARD_REFRESH_MS);
}

async function refreshDashboardNow(admin) {
  const button = document.querySelector('#refresh-dashboard');
  if (button) {
    button.disabled = true;
    button.textContent = 'กำลังอัปเดต...';
  }

  try {
    await syncRemoteData();
    renderDashboard(admin);
    toast('อัปเดตข้อมูลล่าสุดจาก Supabase แล้ว');
  } catch (error) {
    if (button) {
      button.disabled = false;
      button.textContent = '↻ อัปเดตข้อมูล';
    }
    toast(error.message || 'ไม่สามารถอัปเดตข้อมูลได้', 'error');
  }
}

/* =========================================================
   ADMIN TABLES (DIRECT DELETE & APPROVE TO SUPABASE)
   ========================================================= */
function adminTable(type) {
  const isUsage = type === 'usage';
  const records = isUsage ? db.usages : db.fuels;
  const title = isUsage ? 'จัดการข้อมูลการใช้งานรถ' : 'จัดการข้อมูลการเติมน้ำมัน';
  const description = isUsage
    ? 'ค้นหาตามชื่อผู้ขับขี่ ทะเบียนรถ หรือวัตถุประสงค์'
    : 'ตรวจสอบรายการเติมน้ำมัน สลิป และการอนุมัติรายการ';

  const rows = records
    .map((item) =>
      isUsage
        ? `
          <tr>
            <td>${thaiDate(item.date)}</td>
            <td>${esc(item.driver)}</td>
            <td>${esc(item.plate)}</td>
            <td>${number(mileage(item))} กม.</td>
            <td>${esc(item.purpose)}</td>
            <td>
              <button class="ghost-button" data-edit="usage:${item.id}" type="button">แก้ไข</button>
              <button class="danger-button" data-delete="usage:${item.id}" type="button">ลบ</button>
            </td>
          </tr>
        `
        : `
          <tr class="${Number(item.amount) > OVER_BUDGET ? 'over-budget' : ''}">
            <td>${thaiDate(item.date)}</td>
            <td>${esc(item.driver)}</td>
            <td>${esc(item.plate)}</td>
            <td>${number(item.liters, 2)} ลิตร</td>
            <td>
              ${money(item.amount)}
              ${Number(item.amount) > OVER_BUDGET ? `<span class="tag danger">เกินงบ</span>` : ''}
            </td>
            <td>
              ${item.receipt ? `<button class="ghost-button" data-receipt="${item.id}" type="button">ดูสลิป</button>` : '-'}
            </td>
            <td>
              <span class="tag ${item.approved ? 'approved' : 'pending'}">${item.approved ? 'อนุมัติแล้ว' : 'รออนุมัติ'}</span>
            </td>
            <td>
              <button class="ghost-button" data-edit="fuel:${item.id}" type="button">แก้ไข</button>
              ${!item.approved ? `<button class="button" data-approve="${item.id}" type="button">อนุมัติ</button>` : ''}
              <button class="danger-button" data-delete="fuel:${item.id}" type="button">ลบ</button>
            </td>
          </tr>
        `,
    )
    .join('');

  const headers = isUsage
    ? `<th>วันที่</th><th>ผู้ขับขี่</th><th>ทะเบียน</th><th>ระยะทาง</th><th>วัตถุประสงค์</th><th>จัดการ</th>`
    : `<th>วันที่</th><th>ผู้บันทึก</th><th>ทะเบียน</th><th>ลิตร</th><th>ยอดเงิน</th><th>หลักฐาน</th><th>สถานะ</th><th>จัดการ</th>`;

  document.querySelector('#page').innerHTML = `
    ${pageHead(title, description)}
    <section class="card">
      <div class="filter-bar">
        <input id="table-search" placeholder="ค้นหาข้อมูล" />
        <input id="date-filter" type="date" />
        <select id="plate-filter">
          <option value="">ทุกรถ</option>
          ${vehicleOptions('')}
        </select>
        <button class="ghost-button" id="clear-filter" type="button">ล้างตัวกรอง</button>
      </div>

      <div class="table-wrap">
        <table class="data-table">
          <thead><tr>${headers}</tr></thead>
          <tbody id="table-body">${rows || `<tr><td colspan="8" class="empty">ไม่พบข้อมูล</td></tr>`}</tbody>
        </table>
      </div>
    </section>
  `;

  bindTable(type);
}

function bindTable(type) {
  const refresh = () => {
    const search = document.querySelector('#table-search').value.toLowerCase();
    const date = document.querySelector('#date-filter').value;
    const plate = document.querySelector('#plate-filter').value;

    const all = type === 'usage' ? db.usages : db.fuels;
    const filtered = all
      .filter((item) => !search || Object.values(item).join(' ').toLowerCase().includes(search))
      .filter((item) => !date || item.date === date)
      .filter((item) => !plate || item.plate === plate);

    const original = type === 'usage' ? db.usages : db.fuels;
    if (type === 'usage') db.usages = filtered;
    else db.fuels = filtered;

    adminTable(type);

    if (type === 'usage') db.usages = original;
    else db.fuels = original;

    document.querySelector('#table-search').value = search;
    document.querySelector('#date-filter').value = date;
    document.querySelector('#plate-filter').value = plate;
  };

  document.querySelector('#table-search')?.addEventListener('input', refresh);
  document.querySelector('#date-filter')?.addEventListener('change', refresh);
  document.querySelector('#plate-filter')?.addEventListener('change', refresh);
  document.querySelector('#clear-filter')?.addEventListener('click', () => adminTable(type));

  document.querySelectorAll('[data-edit]').forEach((button) => {
    button.addEventListener('click', () => {
      const [kind, id] = button.dataset.edit.split(':');
      state.userTab = kind;
      state.edit = (kind === 'usage' ? db.usages : db.fuels).find((item) => item.id === id);
      state.view = 'admin-entry';
      renderApp();
    });
  });

  document.querySelectorAll('[data-delete]').forEach((button) => {
    button.addEventListener('click', async () => {
      const [kind, id] = button.dataset.delete.split(':');
      if (!confirm('ยืนยันการลบรายการนี้จากฐานข้อมูลคลาวด์หรือไม่?')) return;

      try {
        if (supabaseClient) {
          const table = kind === 'usage' ? 'usages' : 'fuels';
          const { error } = await supabaseClient.from(table).delete().eq('id', id);
          if (error) throw error;
        }

        await addAudit('ลบข้อมูล', `${kind}: ID ${id}`);
        await syncRemoteData();
        toast('ลบรายการเรียบร้อย');
        adminTable(type);
      } catch (err) {
        toast('ลบไม่สำเร็จ: ' + err.message, 'error');
      }
    });
  });

  document.querySelectorAll('[data-approve]').forEach((button) => {
    button.addEventListener('click', async () => {
      const fuelId = button.dataset.approve;
      try {
        if (supabaseClient) {
          const { error } = await supabaseClient.from('fuels').update({ approved: true }).eq('id', fuelId);
          if (error) throw error;
        }

        await addAudit('อนุมัติรายการเติมน้ำมัน', `ID: ${fuelId}`);
        await syncRemoteData();
        toast('อนุมัติรายการเรียบร้อย');
        adminTable('fuel');
      } catch (err) {
        toast('อนุมัติไม่สำเร็จ: ' + err.message, 'error');
      }
    });
  });

  document.querySelectorAll('[data-receipt]').forEach((button) => {
    button.addEventListener('click', () => showReceipt(button.dataset.receipt));
  });
}

function showReceipt(id) {
  const item = db.fuels.find((entry) => entry.id === id);
  if (!item?.receipt) {
    return toast('ไม่มีรูปสลิปในรายการนี้', 'error');
  }

  app.insertAdjacentHTML(
    'beforeend',
    `
      <div class="modal" data-modal role="dialog" aria-modal="true" aria-labelledby="receipt-title">
        <div class="modal-panel receipt-modal">
          <div class="modal-head">
            <div>
              <div class="eyebrow">หลักฐานการชำระเงิน</div>
              <h3 id="receipt-title">สลิปการเติมน้ำมัน</h3>
            </div>
            <button class="icon-button icon-button-compact" data-close-modal type="button" aria-label="ปิดหน้าต่าง">
              ${icon('x')}
            </button>
          </div>
          <div class="receipt-viewer">
            <img src="${item.receipt}" alt="สลิปการเติมน้ำมัน" />
          </div>
        </div>
      </div>
    `,
  );

  const modal = document.querySelector('[data-modal]');
  const close = () => modal?.remove();

  modal.querySelector('[data-close-modal]').addEventListener('click', close);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) close();
  });
}

/* =========================================================
   ADMIN SERVICE TABLE
   ========================================================= */
function adminServiceTable() {
  const records = db.services || [];
  const title = 'ตรวจสอบข้อมูลการเช็คระยะยานพาหนะ';
  const description = 'ค้นหาและตรวจสอบประวัติการตรวจเช็คระยะ บำรุงรักษา หรือเปลี่ยนถ่ายน้ำมันเครื่อง';

  const rows = records
    .map(
      (item) => `
        <tr>
          <td>${thaiDate(item.date)}</td>
          <td class="fw-bold text-primary">${esc(item.plate)}</td>
          <td>${number(item.mileage)} กม.</td>
          <td><span class="tag approved">${esc(item.serviceType || 'ตรวจเช็คระยะ')}</span></td>
          <td>${esc(item.note || '-')}</td>
          <td>
            <button class="danger-button" data-delete-service="${item.id}" type="button">ลบ</button>
          </td>
        </tr>
      `,
    )
    .join('');

  document.querySelector('#page').innerHTML = `
    ${pageHead(title, description)}
    <section class="card">
      <div class="filter-bar">
        <input id="service-search" placeholder="ค้นหาทะเบียน หรือประเภทการตรวจเช็ค..." />
        <input id="service-date-filter" type="date" />
        <select id="service-plate-filter">
          <option value="">ทุกทะเบียนรถ</option>
          ${vehicleOptions('')}
        </select>
        <button class="ghost-button" id="clear-service-filter" type="button">ล้างตัวกรอง</button>
      </div>

      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>วันที่ตรวจเช็ค</th>
              <th>ทะเบียนรถ</th>
              <th>เลขไมล์ขณะตรวจเช็ค</th>
              <th>ประเภทการเช็คระยะ</th>
              <th>รายละเอียด / หมายเหตุ</th>
              <th>จัดการ</th>
            </tr>
          </thead>
          <tbody id="service-table-body">${rows || `<tr><td colspan="6" class="empty">ไม่พบข้อมูลการเช็คระยะ</td></tr>`}</tbody>
        </table>
      </div>
    </section>
  `;

  bindServiceTable();
}

function bindServiceTable() {
  const refresh = () => {
    const search = document.querySelector('#service-search').value.toLowerCase();
    const date = document.querySelector('#service-date-filter').value;
    const plate = document.querySelector('#service-plate-filter').value;

    const filtered = (db.services || []).filter((item) => {
      const matchText =
        !search ||
        (item.plate || '').toLowerCase().includes(search) ||
        (item.serviceType || '').toLowerCase().includes(search) ||
        (item.note || '').toLowerCase().includes(search);
      const matchDate = !date || item.date === date;
      const matchPlate = !plate || item.plate === plate;
      return matchText && matchDate && matchPlate;
    });

    const tbody = document.querySelector('#service-table-body');
    if (!tbody) return;

    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty">ไม่พบข้อมูลตามเงื่อนไขค้นหา</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered
      .map(
        (item) => `
        <tr>
          <td>${thaiDate(item.date)}</td>
          <td class="fw-bold text-primary">${esc(item.plate)}</td>
          <td>${number(item.mileage)} กม.</td>
          <td><span class="tag approved">${esc(item.serviceType || 'ตรวจเช็คระยะ')}</span></td>
          <td>${esc(item.note || '-')}</td>
          <td>
            <button class="danger-button" data-delete-service="${item.id}" type="button">ลบ</button>
          </td>
        </tr>
      `,
      )
      .join('');

    bindServiceDeleteButtons();
  };

  document.querySelector('#service-search')?.addEventListener('input', refresh);
  document.querySelector('#service-date-filter')?.addEventListener('change', refresh);
  document.querySelector('#service-plate-filter')?.addEventListener('change', refresh);
  document.querySelector('#clear-service-filter')?.addEventListener('click', () => adminServiceTable());

  bindServiceDeleteButtons();
}

function bindServiceDeleteButtons() {
  document.querySelectorAll('[data-delete-service]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.deleteService;
      if (!confirm('ยืนยันการลบรายการตรวจเช็คระยะนี้จากฐานข้อมูลหรือไม่?')) return;

      try {
        if (supabaseClient) {
          const { error } = await supabaseClient.from('services').delete().eq('id', id);
          if (error) throw error;
        }

        await addAudit('ลบข้อมูลเช็คระยะ', `ID: ${id}`);
        await syncRemoteData();
        toast('ลบรายการเช็คระยะเรียบร้อย');
        adminServiceTable();
      } catch (err) {
        toast('ลบไม่สำเร็จ: ' + err.message, 'error');
      }
    });
  });
}

/* =========================================================
   ADMIN FLEET CARD MANAGEMENT (ฟังก์ชันแอดมินจัดการงบประมาณ Fleet Card)
   ========================================================= */
function renderAdminFleetCards() {
  const page = document.querySelector('#page');
  const vehicles = db.vehicles || [];

  const totalBudget = vehicles.reduce((sum, v) => sum + Number(v.fleetCardBalance || 0), 0);
  const totalCards = vehicles.filter((v) => Number(v.fleetCardBalance || 0) > 0 || v.fleetCardNumber).length;

  const rows = vehicles
    .map(
      (v) => `
      <tr>
        <td class="fw-bold text-primary">${esc(v.plate)}</td>
        <td>${esc(v.model || '-')}</td>
        <td>${esc(v.department || '-')}</td>
        <td>${v.fleetCardNumber ? `<code>${esc(v.fleetCardNumber)}</code>` : '<span style="color:var(--muted-foreground);">-</span>'}</td>
        <td style="font-weight: 750; font-size: 0.9rem; color: ${v.fleetCardBalance <= 500 ? 'var(--danger)' : 'var(--success)'};">
          ${money(v.fleetCardBalance || 0)}
        </td>
        <td>
          <button class="button" data-fleet-manage="${esc(v.plate)}" type="button">
            💳 เติมเงิน / ปรับยอด
          </button>
        </td>
      </tr>
    `,
    )
    .join('');

  page.innerHTML = `
    ${pageHead('จัดการงบประมาณ Fleet Card', 'ตรวจสอบยอดเงินในบัตรเติมน้ำมันประจำรถแต่ละคัน เพิ่มหรือลดวงเงินงบประมาณได้ตลอดเวลา')}
    
    <div class="grid dashboard" style="margin-bottom: 20px;">
      <article class="stat-card">
        <div class="label">ยอดเงินงบประมาณรวมทุกคัน</div>
        <div class="value" style="color: var(--success);">${money(totalBudget)}</div>
        <div class="sub">จำนวนรถทั้งหมด ${vehicles.length} คัน</div>
      </article>

      <article class="stat-card">
        <div class="label">บัตร Fleet Card ที่มีวงเงิน</div>
        <div class="value">${number(totalCards)} ใบ</div>
        <div class="sub">พร้อมใช้งานสำหรับการเติมน้ำมัน</div>
      </article>
    </div>

    <section class="card">
      <div class="filter-bar">
        <input id="fleet-card-search" placeholder="ค้นหาตามทะเบียน, รุ่นรถ, ศูนย์..." />
        <button class="ghost-button" id="refresh-fleet-cards" type="button">↻ รีเฟรชข้อมูล</button>
      </div>

      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>ทะเบียนรถ</th>
              <th>รุ่นรถ</th>
              <th>สังกัด / ศูนย์</th>
              <th>เลขที่บัตร Fleet Card</th>
              <th>ยอดเงินคงเหลือในบัตร</th>
              <th style="width: 170px;">การจัดการ</th>
            </tr>
          </thead>
          <tbody id="fleet-card-table-body">${rows || `<tr><td colspan="6" class="empty">ไม่พบข้อมูลรถในระบบ</td></tr>`}</tbody>
        </table>
      </div>
    </section>
  `;

  document.querySelectorAll('[data-fleet-manage]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const plate = btn.dataset.fleetManage;
      const vehicle = getVehicle(plate);
      if (vehicle) openFleetCardModal(vehicle);
    });
  });

  document.querySelector('#refresh-fleet-cards')?.addEventListener('click', async () => {
    await syncRemoteData();
    renderAdminFleetCards();
    toast('อัปเดตข้อมูลงบประมาณ Fleet Card แล้ว');
  });

  document.querySelector('#fleet-card-search')?.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    const filtered = vehicles.filter(
      (v) =>
        v.plate.toLowerCase().includes(query) ||
        (v.model || '').toLowerCase().includes(query) ||
        (v.department || '').toLowerCase().includes(query) ||
        (v.fleetCardNumber || '').toLowerCase().includes(query)
    );

    const tbody = document.querySelector('#fleet-card-table-body');
    if (!tbody) return;

    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty">ไม่พบข้อมูลตามคำค้นหา</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered
      .map(
        (v) => `
        <tr>
          <td class="fw-bold text-primary">${esc(v.plate)}</td>
          <td>${esc(v.model || '-')}</td>
          <td>${esc(v.department || '-')}</td>
          <td>${v.fleetCardNumber ? `<code>${esc(v.fleetCardNumber)}</code>` : '<span style="color:var(--muted-foreground);">-</span>'}</td>
          <td style="font-weight: 750; font-size: 0.9rem; color: ${v.fleetCardBalance <= 500 ? 'var(--danger)' : 'var(--success)'};">
            ${money(v.fleetCardBalance || 0)}
          </td>
          <td>
            <button class="button" data-fleet-manage="${esc(v.plate)}" type="button">
              💳 เติมเงิน / ปรับยอด
            </button>
          </td>
        </tr>
      `,
      )
      .join('');

    tbody.querySelectorAll('[data-fleet-manage]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const plate = btn.dataset.fleetManage;
        const vehicle = getVehicle(plate);
        if (vehicle) openFleetCardModal(vehicle);
      });
    });
  });
}

function openFleetCardModal(vehicle) {
  const modalId = 'fleet-card-modal';
  document.getElementById(modalId)?.remove();

  const currentBal = Number(vehicle.fleetCardBalance || 0);

  const modalHtml = `
    <div class="modal" id="${modalId}" role="dialog" aria-modal="true">
      <div class="modal-panel" style="max-width: 500px;">
        <div class="modal-head">
          <div>
            <div class="eyebrow">จัดการงบประมาณบัตรน้ำมัน</div>
            <h3>รถทะเบียน: ${esc(vehicle.plate)}</h3>
          </div>
          <button class="icon-button icon-button-compact" id="close-fleet-modal" type="button">✕</button>
        </div>

        <div style="margin: 16px 0; padding: 14px; background: var(--surface-subtle); border-radius: var(--radius); border: 1px solid var(--border);">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 0.82rem; color: var(--muted-foreground);">ยอดเงินคงเหลือปัจจุบัน:</span>
            <strong style="font-size: 1.25rem; color: var(--primary);">${money(currentBal)}</strong>
          </div>
          <div style="font-size: 0.75rem; color: var(--muted-foreground); margin-top: 4px;">
            สังกัด: ${esc(vehicle.department || '-')} | รุ่น: ${esc(vehicle.model || '-')}
          </div>
        </div>

        <form id="fleet-adjust-form">
          <div class="field">
            <label>รูปแบบการปรับยอดเงิน</label>
            <select name="actionType" id="fleet-action-type" required>
              <option value="topup">➕ เติมเงินเข้าบัตร (เพิ่มยอด)</option>
              <option value="deduct">➖ ตัดเงิน/ลดงบประมาณ (ลดยอด)</option>
              <option value="set">⚙️ กำหนดค่ายอดเงินคงเหลือโดยตรง (Set Balance)</option>
            </select>
          </div>

          <div class="field">
            <label id="fleet-amount-label">จำนวนเงินที่ต้องการเติม (บาท)</label>
            <input required type="number" min="0" step="0.01" name="amount" id="modal-adjust-amount" placeholder="ระบุจำนวนเงิน (บาท)" autofocus />
          </div>

          <div class="field">
            <label>เลขที่บัตร Fleet Card (ถ้ามี)</label>
            <input type="text" name="cardNumber" value="${esc(vehicle.fleetCardNumber || '')}" placeholder="เช่น 7001-XXXX-XXXX-XXXX" />
          </div>

          <div class="field">
            <label>หมายเหตุ / เหตุผลการปรับยอด</label>
            <input type="text" name="note" placeholder="เช่น เติมงบประจำเดือน, โอนย้ายงบประมาณ" />
          </div>

          <div style="margin-top: 10px; padding: 10px; background: var(--accent); border-radius: var(--radius); border: 1px solid color-mix(in srgb, var(--nt-gold) 30%, var(--border));">
            <span style="font-size: 0.78rem; color: var(--accent-foreground); display: block;">
              ยอดเงินใหม่หลังบันทึก: <strong id="preview-new-balance" style="font-size: 1rem;">${money(currentBal)}</strong>
            </span>
          </div>

          <div class="button-row" style="margin-top: 20px; justify-content: flex-end;">
            <button class="ghost-button" id="cancel-fleet-modal" type="button">ยกเลิก</button>
            <button class="button" id="submit-fleet-modal" type="submit">บันทึกยอดเงิน</button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHtml);

  const form = document.querySelector('#fleet-adjust-form');
  const actionTypeSelect = document.querySelector('#fleet-action-type');
  const amountInput = document.querySelector('#modal-adjust-amount');
  const amountLabel = document.querySelector('#fleet-amount-label');
  const previewEl = document.querySelector('#preview-new-balance');

  const updatePreview = () => {
    const action = actionTypeSelect.value;
    const val = Number(amountInput.value || 0);
    let newBal = currentBal;

    if (action === 'topup') {
      amountLabel.textContent = 'จำนวนเงินที่ต้องการเติม (บาท)';
      newBal = currentBal + val;
    } else if (action === 'deduct') {
      amountLabel.textContent = 'จำนวนเงินที่ต้องการตัดออก/ลด (บาท)';
      newBal = currentBal - val;
    } else if (action === 'set') {
      amountLabel.textContent = 'กำหนดยอดคงเหลือใหม่เป็น (บาท)';
      newBal = val;
    }

    previewEl.textContent = money(newBal);
    previewEl.style.color = newBal < 0 ? 'var(--danger)' : 'var(--primary)';
  };

  actionTypeSelect.addEventListener('change', updatePreview);
  amountInput.addEventListener('input', updatePreview);

  const closeModal = () => document.getElementById(modalId)?.remove();
  document.querySelector('#close-fleet-modal')?.addEventListener('click', closeModal);
  document.querySelector('#cancel-fleet-modal')?.addEventListener('click', closeModal);

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.querySelector('#submit-fleet-modal');
    btn.disabled = true;
    btn.textContent = 'กำลังบันทึกลงฐานข้อมูล...';

    const fd = new FormData(e.currentTarget);
    const action = fd.get('actionType');
    const val = Number(fd.get('amount') || 0);
    const cardNumber = String(fd.get('cardNumber') || '').trim();
    const note = String(fd.get('note') || '').trim();

    let newBal = currentBal;
    let actionDesc = '';

    if (action === 'topup') {
      newBal = currentBal + val;
      actionDesc = `เติมเงิน ฿${val.toLocaleString()}`;
    } else if (action === 'deduct') {
      newBal = currentBal - val;
      actionDesc = `ตัดเงิน ฿${val.toLocaleString()}`;
    } else {
      newBal = val;
      actionDesc = `กำหนดยอดเงินเป็น ฿${val.toLocaleString()}`;
    }

    try {
      if (!supabaseClient) throw new Error('ไม่ได้เชื่อมต่อกับ Supabase');

      const { error } = await supabaseClient
        .from('vehicles')
        .update({
          fleet_card_balance: newBal,
          fleet_card_number: cardNumber,
        })
        .eq('plate', vehicle.plate);

      if (error) throw error;

      vehicle.fleetCardBalance = newBal;
      vehicle.fleetCardNumber = cardNumber;

      const auditMsg = `${actionDesc} | รถทะเบียน ${vehicle.plate} (ยอดเดิม ฿${currentBal.toLocaleString()} -> ยอดใหม่ ฿${newBal.toLocaleString()})${note ? ` [${note}]` : ''}`;
      await addAudit('ปรับยอดเงิน Fleet Card', auditMsg);

      const tgMsg =
        `💳 <b>มีการปรับยอดเงินงบประมาณ Fleet Card</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🚗 <b>ทะเบียนรถ:</b> ${vehicle.plate}\n` +
        `<b>การดำเนินการ:</b> ${actionDesc}\n` +
        `<b>ยอดเงินคงเหลือใหม่:</b> ${money(newBal)}\n` +
        `<b>ผู้ดำเนินการ:</b> ${state.user?.name || 'แอดมิน'}\n` +
        (note ? `<b>หมายเหตุ:</b> ${note}\n` : '');
      await sendTelegramNotification(tgMsg);

      toast('ปรับปรุงยอดเงิน Fleet Card สำเร็จ');
      closeModal();
      await syncRemoteData();
      renderAdminFleetCards();
    } catch (err) {
      console.error('Update Fleet Card balance error:', err);
      toast('เกิดข้อผิดพลาด: ' + (err.message || 'ไม่สามารถบันทึกได้'), 'error');
      btn.disabled = false;
      btn.textContent = 'บันทึกยอดเงิน';
    }
  });
}

/* =========================================================
   REPORTS
   ========================================================= */
function renderReports() {
  const page = document.querySelector('#page');
  const currentMonth = bangkokMonthKey();
  const currentDept = 'ทั้งหมด';
  const data = monthData(currentMonth, currentDept);

  const deptOptionsHtml = VEHICLE_DEPARTMENTS.map(
    (dept) => `<option value="${esc(dept)}" ${dept === currentDept ? 'selected' : ''}>${dept === 'ทั้งหมด' ? 'ทั้งหมด (ทุกศูนย์)' : esc(dept)}</option>`
  ).join('');

  page.innerHTML = `
    ${pageHead('รายงานและวิเคราะห์', 'เลือกเดือน ปี และศูนย์เพื่อแสดงสรุปการใช้งานรถ')}
    <section class="card">
      <div class="report-toolbar">
        <div class="report-filters">
          <div class="field">
            <label for="report-month">เลือกเดือน/ปีสำหรับรายงาน</label>
            <input id="report-month" type="month" value="${currentMonth}" />
          </div>
          <div class="field">
            <label for="report-department">เลือกศูนย์ / สังกัดรถ</label>
            <select id="report-department">
              ${deptOptionsHtml}
            </select>
          </div>
        </div>

        <div class="report-actions">
          <button class="button" id="calculate-report" type="button">คำนวณรายงาน</button>
          <button class="ghost-button" id="print-report" type="button">พิมพ์ / บันทึก PDF</button>
          <button class="ghost-button" id="export-csv" type="button">Export Excel (CSV)</button>
        </div>
      </div>
    </section>

    <div id="report-area" class="report-area">
      ${statsMarkup(data, currentMonth)}
      <div class="report-section">${dashboardMarkup(data)}</div>
    </div>
  `;

  document.querySelector('#calculate-report')?.addEventListener('click', () => {
    const selectedMonth = document.querySelector('#report-month').value || bangkokMonthKey();
    const selectedDept = document.querySelector('#report-department').value || 'ทั้งหมด';
    const info = monthData(selectedMonth, selectedDept);

    document.querySelector('#report-area').innerHTML = `
      ${statsMarkup(info, selectedMonth)}
      <div class="report-section">${dashboardMarkup(info)}</div>
    `;
  });

  document.querySelector('#print-report')?.addEventListener('click', () => {
    const selectedMonth = document.querySelector('#report-month').value || bangkokMonthKey();
    const selectedDept = document.querySelector('#report-department').value || 'ทั้งหมด';
    printOfficialReport(selectedMonth, selectedDept);
  });

  document.querySelector('#export-csv')?.addEventListener('click', () => {
    const selectedMonth = document.querySelector('#report-month').value || bangkokMonthKey();
    const selectedDept = document.querySelector('#report-department').value || 'ทั้งหมด';
    exportOfficialCsv(selectedMonth, selectedDept);
  });
}

function printOfficialReport(month, department = 'ทั้งหมด') {
  const data = monthData(month, department);
  const now = new Date();

  const dateFormatted =
    new Intl.DateTimeFormat('th-TH', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Asia/Bangkok',
    }).format(now) + ' น.';

  const docNo = `NT-HH-${month.replace('-', '')}-${String(now.getDate()).padStart(2, '0')}`;

  const usageRows = data.usages.slice(0, 25).map((item, idx) => `
    <tr>
      <td>${idx + 1}</td>
      <td>${thaiDate(item.date)}</td>
      <td>${esc(item.plate)}</td>
      <td>${esc(item.driver)}</td>
      <td>${esc(item.department || '-')}</td>
      <td>${number(item.startMileage)}</td>
      <td>${number(item.endMileage)}</td>
      <td>${number(mileage(item))} กม.</td>
      <td>${esc(item.purpose || '-')}</td>
    </tr>
  `).join('');

  const fuelRows = data.fuels.slice(0, 20).map((item, idx) => `
    <tr>
      <td>${idx + 1}</td>
      <td>${thaiDate(item.date)}</td>
      <td>${esc(item.plate)}</td>
      <td>${esc(item.driver)}</td>
      <td>${number(item.mileage)}</td>
      <td>${esc(item.type || '-')}</td>
      <td>${number(item.liters, 2)}</td>
      <td>${money(item.amount)}</td>
      <td>${item.approved ? 'อนุมัติแล้ว' : 'รออนุมัติ'}</td>
    </tr>
  `).join('');

  let printArea = document.querySelector('#official-print-area');
  if (!printArea) {
    printArea = document.createElement('div');
    printArea.id = 'official-print-area';
    document.body.appendChild(printArea);
  }

  printArea.innerHTML = `
    <div class="official-header">
      <div class="official-header-left">
        <div class="company-name">บริษัท โทรคมนาคมแห่งชาติ จำกัด (มหาชน)</div>
        <div class="report-title">
          รายงานสรุปการใช้ยานพาหนะและน้ำมันเชื้อเพลิง ประจำเดือน ${thaiMonth(month)}
          ${department !== 'ทั้งหมด' ? ` (${esc(department)})` : ' (รวมทุกศูนย์)'}
        </div>
      </div>

      <div class="official-header-right">
        <div><span>เลขที่เอกสาร:</span> ${docNo}</div>
        <div><span>วันที่พิมพ์:</span> ${dateFormatted}</div>
        <div><span>สังกัด:</span> ${department !== 'ทั้งหมด' ? esc(department) : 'บกน.2(ปข.) (ทั้งหมด)'}</div>
      </div>
    </div>

    <div class="official-kpis">
      <div class="official-kpi">
        <div>ระยะทางสะสมรวม</div>
        <strong>${number(data.distance)} กม.</strong>
      </div>
      <div class="official-kpi">
        <div>ปริมาณน้ำมันรวม</div>
        <strong>${number(data.liters, 2)} ลิตร</strong>
      </div>
      <div class="official-kpi">
        <div>ค่าน้ำมันเชื้อเพลิงรวม</div>
        <strong>${money(data.amount)}</strong>
      </div>
      <div class="official-kpi">
        <div>อัตราสิ้นเปลืองเฉลี่ย</div>
        <strong>${number(data.efficiency, 2)} กม./ลิตร</strong>
      </div>
    </div>

    <div class="official-section-title">
      1. รายการใช้ยานพาหนะ (จำนวน ${data.usages.length} รายการ) ${department !== 'ทั้งหมด' ? `[${esc(department)}]` : ''}
    </div>

    <table class="official-table vehicle-table">
      <colgroup>
        <col style="width: 5.0%">
        <col style="width: 12.3%">
        <col style="width: 13.6%">
        <col style="width: 16.0%">
        <col style="width: 15.8%">
        <col style="width: 12.3%">
        <col style="width: 12.3%">
        <col style="width: 13.6%">
        <col style="width: 22.3%">
      </colgroup>
      <thead>
        <tr>
          <th>ลำดับที่</th>
          <th>วันที่</th>
          <th>ทะเบียนรถ</th>
          <th>ผู้ขับขี่</th>
          <th>หน่วยงาน</th>
          <th>ไมล์เริ่มต้น</th>
          <th>ไมล์สิ้นสุด</th>
          <th>ระยะทาง</th>
          <th>วัตถุประสงค์</th>
        </tr>
      </thead>
      <tbody>
        ${usageRows || `<tr><td colspan="9" class="empty-row">ไม่มีรายการใช้รถของศูนย์นี้ในเดือนนี้</td></tr>`}
      </tbody>
    </table>

    <div class="official-section-title fuel-title">
      2. รายการเบิกจ่ายน้ำมันเชื้อเพลิง (จำนวน ${data.fuels.length} รายการ) ${department !== 'ทั้งหมด' ? `[${esc(department)}]` : ''}
    </div>

    <table class="official-table fuel-table">
      <colgroup>
        <col style="width: 5.0%">
        <col style="width: 13.6%">
        <col style="width: 14.8%">
        <col style="width: 17.1%">
        <col style="width: 13.6%">
        <col style="width: 12.3%">
        <col style="width: 13.6%">
        <col style="width: 17.3%">
        <col style="width: 16.0%">
      </colgroup>
      <thead>
        <tr>
          <th>ลำดับที่</th>
          <th>วันที่</th>
          <th>ทะเบียนรถ</th>
          <th>ผู้บันทึก</th>
          <th>เลขไมล์ที่เติม</th>
          <th>ประเภท</th>
          <th>จำนวน (ลิตร)</th>
          <th>ยอดเงินรวม</th>
          <th>สถานะ</th>
        </tr>
      </thead>
      <tbody>
        ${fuelRows || `<tr><td colspan="9" class="empty-row">ไม่มีรายการเติมน้ำมันของศูนย์นี้ในเดือนนี้</td></tr>`}
      </tbody>
    </table>

    <div class="official-signatures">
      <div class="official-sign">
        <div class="signature-line">............................................................</div>
        <div class="signature-name">(............................................................)</div>
        <div class="signature-role">ผู้รายงาน / เจ้าหน้าที่ควบคุมยานพาหนะ</div>
        <div class="signature-date">วันที่ ......./......./.......</div>
      </div>
      <div class="official-sign">
        <div class="signature-line">............................................................</div>
        <div class="signature-name">(............................................................)</div>
        <div class="signature-role">ผู้ตรวจสอบ / หัวหน้างานยานพาหนะ</div>
        <div class="signature-date">วันที่ ......./......./.......</div>
      </div>
      <div class="official-sign">
        <div class="signature-line">............................................................</div>
        <div class="signature-name">(............................................................)</div>
        <div class="signature-role">ผู้อนุมัติ / ผู้จัดการศูนย์บริการ NT</div>
        <div class="signature-date">วันที่ ......./......./.......</div>
      </div>
    </div>
  `;

  document.body.classList.add('printing-official');
  window.print();
  window.addEventListener(
    'afterprint',
    () => {
      document.body.classList.remove('printing-official');
    },
    { once: true }
  );
}

function exportOfficialCsv(month, department = 'ทั้งหมด') {
  const data = monthData(month, department);
  const now = new Date();
  const dateStr = now.toLocaleDateString('th-TH');

  let csv = '';
  csv += '"บริษัท โทรคมนาคมแห่งชาติ จำกัด (มหาชน)"\n';
  csv += `"รายงานสรุปการใช้ยานพาหนะและน้ำมันเชื้อเพลิง ประจำเดือน ${thaiMonth(month)} (${department})"\n`;
  csv += `"วันที่ออกรายงาน: ${dateStr}","ศูนย์/สังกัด: ${department}","ผู้ออกรายงาน: ${state.user?.name || 'ผู้ดูแลระบบ'}"\n\n`;

  csv += '"สรุปข้อมูลภาพรวม"\n';
  csv += `"ระยะทางสะสมรวม (กม.)","${data.distance}","กิโลเมตร"\n`;
  csv += `"ปริมาณน้ำมันรวม (ลิตร)","${data.liters.toFixed(2)}","ลิตร"\n`;
  csv += `"ค่าน้ำมันรวม (บาท)","${data.amount.toFixed(2)}","บาท"\n`;
  csv += `"อัตราสิ้นเปลืองเฉลี่ย","${data.efficiency.toFixed(2)}","กม./ลิตร"\n\n`;

  csv += '"=== ส่วนที่ 1: รายการใช้ยานพาหนะ ==="\n';
  const usageHeaders = ['ลำดับ', 'วันที่', 'ทะเบียนรถ', 'ผู้ขับขี่', 'หน่วยงาน', 'เวลาไป', 'เวลากลับ', 'ไมล์เริ่มต้น', 'ไมล์สิ้นสุด', 'ระยะทาง (กม.)', 'วัตถุประสงค์'];
  csv += usageHeaders.map((h) => `"${h}"`).join(',') + '\n';

  data.usages.forEach((item, idx) => {
    const row = [
      idx + 1,
      item.date,
      item.plate,
      item.driver,
      item.department || '-',
      item.depart || '-',
      item.return || '-',
      item.startMileage,
      item.endMileage,
      mileage(item),
      item.purpose || '-',
    ];
    csv += row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',') + '\n';
  });

  csv += '\n"=== ส่วนที่ 2: รายการเติมน้ำมันเชื้อเพลิง ==="\n';
  const fuelHeaders = ['ลำดับ', 'วันที่', 'ทะเบียนรถ', 'ผู้บันทึก', 'ประเภทน้ำมัน', 'เลขไมล์', 'ลิตร', 'ยอดเงิน (บาท)', 'วิธีชำระ', 'สถานะ'];
  csv += fuelHeaders.map((h) => `"${h}"`).join(',') + '\n';

  data.fuels.forEach((item, idx) => {
    const row = [
      idx + 1,
      item.date,
      item.plate,
      item.driver,
      item.type,
      item.mileage,
      item.liters,
      item.amount,
      item.payment,
      item.approved ? 'อนุมัติแล้ว' : 'รออนุมัติ',
    ];
    csv += row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',') + '\n';
  });

  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const safeDept = department === 'ทั้งหมด' ? 'All' : department.replace(/[\s/\\.]+/g, '_');
  link.download = `NT_Fleet_Report_${safeDept}_${month}_${now.toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  toast(`ส่งออกรายงาน Excel (CSV) สังกัด "${department}" เรียบร้อย`);
}

/* =========================================================
   AUDIT LOGS
   ========================================================= */
function renderAudit() {
  document.querySelector('#page').innerHTML = `
    ${pageHead('Audit Log', 'บันทึกการดำเนินการของผู้ใช้งานภายในระบบ')}
    <section class="card">
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>วันและเวลา</th>
              <th>ผู้ใช้งาน</th>
              <th>การดำเนินการ</th>
              <th>รายละเอียด</th>
            </tr>
          </thead>
          <tbody>
            ${
              db.audit.length
                ? db.audit
                    .map(
                      (item) => `
                        <tr>
                          <td>
                            ${new Intl.DateTimeFormat('th-TH', {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            }).format(new Date(item.time))}
                          </td>
                          <td>${esc(item.actor)}</td>
                          <td>${esc(item.action)}</td>
                          <td>${esc(item.detail)}</td>
                        </tr>
                      `,
                    )
                    .join('')
                : `<tr><td colspan="4" class="empty">ยังไม่มีประวัติการดำเนินการ</td></tr>`
            }
          </tbody>
        </table>
      </div>
    </section>
  `;
}

/* =========================================================
   ADMIN USERS MANAGEMENT
   ========================================================= */
let cachedEmployees = [];

async function renderAdminUsers() {
  const page = document.querySelector('#page');
  page.innerHTML = `
    ${pageHead(
      'จัดการผู้ใช้งานและสิทธิ์',
      'ตรวจสอบรายชื่อพนักงาน แก้ไขบทบาท (User/Admin) และอัปโหลดเปลี่ยนรูปโปรไฟล์',
      `<button class="button" id="btn-add-user" type="button">+ เพิ่มพนักงานใหม่</button>`
    )}
    <section class="card">
      <div class="filter-bar">
        <input id="user-search-input" placeholder="ค้นหาตามชื่อ หรือรหัสพนักงาน..." />
        <select id="user-role-filter">
          <option value="">ทุกสิทธิ์การใช้งาน</option>
          <option value="admin">ผู้ดูแลระบบ (admin)</option>
          <option value="user">พนักงานทั่วไป (user)</option>
        </select>
        <button class="ghost-button" id="btn-refresh-users" type="button">↻ รีเฟรช</button>
      </div>

      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th style="width: 70px;">รูปโปรไฟล์</th>
              <th>รหัสพนักงาน</th>
              <th>ชื่อ-นามสกุล</th>
              <th>เบอร์โทรศัพท์</th>
              <th>สิทธิ์การใช้งาน</th>
              <th>วันที่สร้าง</th>
              <th style="text-align: center;">จัดการ</th>
            </tr>
          </thead>
          <tbody id="admin-users-table-body">
            <tr><td colspan="7" class="empty">กำลังโหลดข้อมูลพนักงาน...</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  `;

  await loadAndRenderUsersTable();

  document.querySelector('#user-search-input')?.addEventListener('input', filterUsersTable);
  document.querySelector('#user-role-filter')?.addEventListener('change', filterUsersTable);
  document.querySelector('#btn-refresh-users')?.addEventListener('click', loadAndRenderUsersTable);
  document.querySelector('#btn-add-user')?.addEventListener('click', () => openUserEditModal(null));
}

async function loadAndRenderUsersTable() {
  const tbody = document.querySelector('#admin-users-table-body');
  if (!tbody) return;

  try {
    if (!supabaseClient) throw new Error('ไม่ได้เชื่อมต่อ Supabase');

    const { data, error } = await supabaseClient
      .from('employees')
      .select('*')
      .order('employee_id', { ascending: true });

    if (error) throw error;

    cachedEmployees = data || [];
    renderUsersRows(cachedEmployees);
  } catch (err) {
    console.error('Fetch employees error:', err);
    tbody.innerHTML = `<tr><td colspan="7" class="empty" style="color:red;">โหลดข้อมูลไม่สำเร็จ: ${err.message}</td></tr>`;
  }
}

function renderUsersRows(list) {
  const tbody = document.querySelector('#admin-users-table-body');
  if (!tbody) return;

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty">ไม่พบข้อมูลพนักงาน</td></tr>`;
    return;
  }

  tbody.innerHTML = list
    .map((emp) => {
      const avatarHtml = avatarMarkup(
        emp.profile_image,
        emp.name,
        'width:36px;height:36px;border-radius:50%;object-fit:cover;display:inline-block;'
      );
      const roleBadge =
        emp.role === 'admin'
          ? '<span class="tag danger">ผู้ดูแลระบบ (admin)</span>'
          : '<span class="tag approved">พนักงาน (user)</span>';

      return `
        <tr>
          <td>
            <div class="avatar" style="width:36px;height:36px;font-size:0.8rem;">
              ${avatarHtml}
            </div>
          </td>
          <td class="fw-bold text-primary">${esc(emp.employee_id)}</td>
          <td class="fw-semibold">${esc(emp.name)}</td>
          <td>${esc(emp.phone || '-')}</td>
          <td>${roleBadge}</td>
          <td>${emp.created_at ? thaiDate(emp.created_at.slice(0, 10)) : '-'}</td>
          <td style="text-align: center;">
            <button class="ghost-button" data-edit-emp="${esc(emp.employee_id)}" type="button">
              แก้ไขข้อมูล
            </button>
          </td>
        </tr>
      `;
    })
    .join('');

  document.querySelectorAll('[data-edit-emp]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const empId = btn.dataset.editEmp;
      const targetEmp = cachedEmployees.find((e) => String(e.employee_id) === String(empId));
      if (targetEmp) openUserEditModal(targetEmp);
    });
  });
}

function filterUsersTable() {
  const query = (document.querySelector('#user-search-input')?.value || '').toLowerCase().trim();
  const role = document.querySelector('#user-role-filter')?.value || '';

  const filtered = cachedEmployees.filter((emp) => {
    const matchText =
      (emp.name || '').toLowerCase().includes(query) ||
      (emp.employee_id || '').toLowerCase().includes(query) ||
      (emp.phone || '').toLowerCase().includes(query);
    const matchRole = !role || emp.role === role;
    return matchText && matchRole;
  });

  renderUsersRows(filtered);
}

function openUserEditModal(emp) {
  const isNew = !emp;
  const modalId = 'user-edit-modal';
  document.getElementById(modalId)?.remove();

  const currentImg = emp?.profile_image ? `${emp.profile_image.split('?')[0]}?t=${Date.now()}` : '';

  const modalHtml = `
    <div class="modal" id="${modalId}" role="dialog" aria-modal="true">
      <div class="modal-panel" style="max-width: 520px;">
        <div class="modal-head">
          <div>
            <div class="eyebrow">${isNew ? 'เพิ่มผู้ใช้งานใหม่' : 'แก้ไขข้อมูลผู้ใช้งาน'}</div>
            <h3>${isNew ? 'เพิ่มพนักงานเข้าสู่ระบบ' : `รหัสพนักงาน: ${esc(emp.employee_id)}`}</h3>
          </div>
          <button class="icon-button icon-button-compact" id="close-user-modal" type="button">✕</button>
        </div>

        <form id="user-edit-form" style="margin-top: 15px;">
          <div style="display: flex; align-items: center; gap: 16px; margin-bottom: 18px; padding: 12px; background: var(--surface-subtle); border-radius: var(--radius);">
            <div id="modal-avatar-preview" class="avatar" style="width: 64px; height: 64px; font-size: 1.3rem; flex: 0 0 auto;">
              ${avatarMarkup(currentImg, emp?.name || 'U', 'width:100%;height:100%;object-fit:cover;border-radius:50%;')}
            </div>
            <div style="flex: 1; min-width: 0;">
              <label class="section-label" style="display:block; margin-bottom: 4px;">รูปภาพโปรไฟล์</label>
              <input type="file" id="modal-avatar-file" accept="image/jpeg,image/png,image/webp" style="font-size: 0.75rem;" />
              <div class="hint">รองรับไฟล์ JPG, PNG, WEBP (ไม่เกิน 3MB)</div>
            </div>
          </div>

          <div class="field">
            <label>รหัสพนักงาน (Employee ID)</label>
            <input name="employee_id" value="${esc(emp?.employee_id || '')}" required ${isNew ? '' : 'readonly style="opacity:0.75;cursor:not-allowed;"'} placeholder="เช่น 1001, 1004" />
          </div>

          <div class="field">
            <label>ชื่อ - นามสกุล</label>
            <input name="name" value="${esc(emp?.name || '')}" required placeholder="ระบุชื่อและนามสกุล" />
          </div>

          <div class="field">
            <label>เบอร์โทรศัพท์</label>
            <input name="phone" type="tel" value="${esc(emp?.phone || '')}" placeholder="เช่น 081-234-5678" />
          </div>

          <div class="field">
            <label>สิทธิ์การใช้งาน (Role)</label>
            <select name="role">
              <option value="user" ${emp?.role === 'user' ? 'selected' : ''}>พนักงานทั่วไป (user)</option>
              <option value="admin" ${emp?.role === 'admin' ? 'selected' : ''}>ผู้ดูแลระบบ (admin)</option>
            </select>
          </div>

          <div class="button-row" style="margin-top: 20px; justify-content: flex-end;">
            <button class="ghost-button" id="cancel-user-modal" type="button">ยกเลิก</button>
            <button class="button" id="submit-user-modal" type="submit">
              ${isNew ? 'สร้างพนักงาน' : 'บันทึกการเปลี่ยนแปลง'}
            </button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHtml);

  const fileInput = document.querySelector('#modal-avatar-file');
  fileInput?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) {
      const previewUrl = URL.createObjectURL(file);
      document.querySelector('#modal-avatar-preview').innerHTML = `
        <img src="${previewUrl}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" />
      `;
    }
  });

  const closeModal = () => document.getElementById(modalId)?.remove();
  document.querySelector('#close-user-modal')?.addEventListener('click', closeModal);
  document.querySelector('#cancel-user-modal')?.addEventListener('click', closeModal);

  document.querySelector('#user-edit-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.querySelector('#submit-user-modal');
    btn.disabled = true;
    btn.textContent = 'กำลังบันทึก...';

    try {
      const fd = new FormData(e.currentTarget);
      const employeeId = String(fd.get('employee_id') || '').trim();
      const name = String(fd.get('name') || '').trim();
      const phone = String(fd.get('phone') || '').trim();
      const role = String(fd.get('role') || 'user');
      const file = fileInput?.files?.[0];

      let newAvatarUrl = emp?.profile_image || null;

      if (file) {
        btn.textContent = 'กำลังอัปโหลดรูป...';
        const fileExt = file.name.split('.').pop() || 'jpg';
        const filePath = `${employeeId}/avatar_${Date.now()}.${fileExt}`;
        newAvatarUrl = await uploadFileToSupabase('profiles', filePath, file);
      }

      btn.textContent = 'กำลังอัปเดตฐานข้อมูล...';
      const payload = {
        employee_id: employeeId,
        name,
        role,
        phone,
        profile_image: newAvatarUrl ? newAvatarUrl.split('?')[0] : null,
      };

      if (isNew) {
        const { error } = await supabaseClient.from('employees').insert(payload);
        if (error) throw error;
        await addAudit('เพิ่มพนักงาน', `รหัส: ${employeeId} (${name})`);
        toast('เพิ่มพนักงานใหม่เรียบร้อยแล้ว');
      } else {
        const { error } = await supabaseClient.from('employees').update(payload).eq('employee_id', employeeId);
        if (error) throw error;
        await addAudit('แก้ไขข้อมูลพนักงาน', `รหัส: ${employeeId} (${name})`);
        toast('อัปเดตข้อมูลและรูปโปรไฟล์เรียบร้อย');
      }

      if (state.user?.employeeId === employeeId) {
        state.user.name = name;
        state.user.role = role;
        state.user.phone = phone;
        if (newAvatarUrl) {
          state.user.profileImage = newAvatarUrl;
        }
        localStorage.setItem('nt-fms-user', JSON.stringify(state.user));
        await renderApp();
      }

      closeModal();
      await loadAndRenderUsersTable();
    } catch (err) {
      console.error('Save employee error:', err);
      toast('เกิดข้อผิดพลาด: ' + (err.message || 'ไม่สามารถบันทึกได้'), 'error');
      btn.disabled = false;
      btn.textContent = isNew ? 'สร้างพนักงาน' : 'บันทึกการเปลี่ยนแปลง';
    }
  });
}

/* =========================================================
   RENDER VIEW ROUTER
   ========================================================= */
async function renderView() {
  if (state.view === 'user-entry') return await renderEntry('user');
  if (state.view === 'user-history') return userHistory();
  if (state.view === 'user-profile') return renderProfile();
  if (state.view === 'admin-dashboard') return renderDashboard(true);
  if (state.view === 'admin-entry') return await renderEntry('admin');
  if (state.view === 'admin-usage') return adminTable('usage');
  if (state.view === 'admin-fuel') return adminTable('fuel');
  if (state.view === 'admin-service') return adminServiceTable();
  if (state.view === 'admin-fleet-card') return renderAdminFleetCards();
  if (state.view === 'admin-reports') return renderReports();
  if (state.view === 'admin-users') return await renderAdminUsers();
  if (state.view === 'admin-audit') return renderAudit();
  if (state.view === 'admin-profile') return renderProfile();
  return await renderEntry('user');
}

/* =========================================================
   BOOTSTRAP
   ========================================================= */
async function bootstrap() {
  const vehicleId = vehicleFromUrl();

  // ถ้ามีการระบุ vehicleId ผ่าน URL (เช่น จากการสแกน QR Code)
  if (vehicleId) {
    renderLoadingVehicle();
    try {
      if (supabaseClient) {
        const { data } = await supabaseClient
          .from('vehicles')
          .select('*')
          .or(`plate.eq.${vehicleId},vehicle_id.eq.${vehicleId}`)
          .maybeSingle();

        if (data) {
          state.vehicle = normalizeVehicle(data);
          if (state.vehicle.status === 'กำลังซ่อมบำรุง') {
            return renderVehicleError(`รถ ${state.vehicle.plate} อยู่ระหว่างซ่อมบำรุง`);
          }
        }
      }
    } catch (error) {
      console.warn('โหลดข้อมูลรถจาก QR Code ไม่สำเร็จ:', error);
    }
  } else {
    // โหมดเข้าสู่ระบบทั่วไป ไม่ระบุเจาะจงรถ
    state.vehicle = null;
  }

  await syncRemoteData();

  const savedUser = localStorage.getItem('nt-fms-user');
  const savedSession = localStorage.getItem(SESSION_KEY);

  let restoredUser = null;
  if (savedUser && savedSession) {
    try {
      restoredUser = JSON.parse(savedUser);
    } catch (parseError) {
      localStorage.removeItem('nt-fms-user');
      localStorage.removeItem(SESSION_KEY);
      restoredUser = null;
    }
  }

  if (restoredUser?.employeeId) {
    state.user = restoredUser;
    state.sessionToken = savedSession;
    state.role = restoredUser.role || 'user';

    try {
      if (supabaseClient) {
        const { data: empData } = await supabaseClient
          .from('employees')
          .select('profile_image, name, role, phone')
          .eq('employee_id', restoredUser.employeeId)
          .maybeSingle();

        if (empData) {
          if (empData.profile_image) {
            state.user.profileImage = `${empData.profile_image.split('?')[0]}?t=${Date.now()}`;
          }
          if (empData.name) state.user.name = empData.name;
          if (empData.role) {
            state.user.role = empData.role;
            state.role = empData.role;
          }
          if (empData.phone !== undefined) state.user.phone = empData.phone || '';

          localStorage.setItem('nt-fms-user', JSON.stringify(state.user));
        }
      }
    } catch (e) {
      console.warn('Refresh user info warning:', e);
    }

    state.view = state.role === 'admin' ? 'admin-dashboard' : 'user-entry';
    await renderApp();
    return;
  }

  renderLogin();
}

/* =========================================================
   START
   ========================================================= */
applyTheme();
bootstrap();
