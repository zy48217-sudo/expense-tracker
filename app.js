'use strict';

/* ============================================================
 *  记账本 - Personal Expense Tracker PWA
 *  IndexedDB storage | Email auth | Statistics | Budget alerts
 * ============================================================ */

// ===== Default Categories =====
const DEFAULT_CATEGORIES = [
  { id: 'food',          name: '餐饮',   icon: '🍽️', color: '#F97316' },
  { id: 'transport',     name: '交通',   icon: '🚌', color: '#3B82F6' },
  { id: 'shopping',      name: '购物',   icon: '🛍️', color: '#EC4899' },
  { id: 'entertainment', name: '娱乐',   icon: '🎬', color: '#8B5CF6' },
  { id: 'housing',       name: '居住',   icon: '🏠', color: '#10B981' },
  { id: 'medical',       name: '医疗',   icon: '💊', color: '#EF4444' },
  { id: 'education',     name: '教育',   icon: '📚', color: '#F59E0B' },
  { id: 'other',         name: '其他',   icon: '📦', color: '#6B7280' },
];

// ===== Avatar Options =====
const AVATAR_OPTIONS = [
  '🧑', '👩', '👨', '👧', '👦', '🧒',
  '😎', '🤓', '😊', '🥳', '🧘', '💪',
  '🐱', '🐶', '🦊', '🐼', '🦁', '🐸',
  '🌸', '🍀', '⭐', '🔥', '💎', '🎵',
  '💰', '🎯', '🏆', '🎨', '🌈', '☀️',
];

// ===== IndexedDB Wrapper =====
const DB_NAME = 'ExpenseTrackerDB';
const DB_VERSION = 2;

const db = {
  _db: null,

  async init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onupgradeneeded = (e) => {
        const idb = e.target.result;
        if (!idb.objectStoreNames.contains('users')) {
          idb.createObjectStore('users', { keyPath: 'email' });
        }
        if (!idb.objectStoreNames.contains('expenses')) {
          const store = idb.createObjectStore('expenses', { keyPath: 'id', autoIncrement: true });
          store.createIndex('userId', 'userId', { unique: false });
          store.createIndex('date', 'date', { unique: false });
          store.createIndex('userId_date', ['userId', 'date'], { unique: false });
        }
        if (!idb.objectStoreNames.contains('settings')) {
          idb.createObjectStore('settings', { keyPath: 'key' });
        }
        // v2: add nickname/avatar fields to existing users (handled in code, not schema)
      };
    });
  },

  _tx(storeName, mode = 'readonly') {
    return this._db.transaction(storeName, mode).objectStore(storeName);
  },

  _wrap(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },

  // Users
  async getUser(email) {
    return this._wrap(this._tx('users').get(email));
  },
  async putUser(user) {
    return this._wrap(this._tx('users', 'readwrite').put(user));
  },

  // Expenses
  async addExpense(expense) {
    return this._wrap(this._tx('expenses', 'readwrite').add(expense));
  },
  async deleteExpense(id) {
    return this._wrap(this._tx('expenses', 'readwrite').delete(id));
  },
  async getAllExpenses(userId) {
    const idx = this._tx('expenses').index('userId');
    return this._wrap(idx.getAll(userId));
  },
  async clearExpenses(userId) {
    const all = await this.getAllExpenses(userId);
    const tx = this._db.transaction('expenses', 'readwrite');
    const store = tx.objectStore('expenses');
    for (const e of all) { store.delete(e.id); }
    return this._wrap(tx.done);
  },

  // Settings
  async getSetting(key) {
    const result = await this._wrap(this._tx('settings').get(key));
    return result ? result.value : null;
  },
  async setSetting(key, value) {
    return this._wrap(this._tx('settings', 'readwrite').put({ key, value }));
  },
};

// ===== Simple Hash =====
function simpleHash(str) {
  let hash = 0;
  const salted = 'et_salt_2024!' + str;
  for (let i = 0; i < salted.length; i++) {
    const ch = salted.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0') + '_' + salted.length;
}

// ===== Cookie helpers =====
// Cookie 是 iOS Safari ↔ PWA 之间唯一共享的存储，用作跨环境 session 桥接
function setCookie(name, value, days) {
  const d = new Date();
  d.setTime(d.getTime() + (days || 365) * 86400000);
  document.cookie = name + '=' + encodeURIComponent(value) + ';expires=' + d.toUTCString() + ';path=/;SameSite=Lax;Secure';
}
function getCookie(name) {
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[2]) : null;
}
function deleteCookie(name) {
  document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 UTC;path=/;SameSite=Lax;Secure';
}

// ===== Auth（Cookie + localStorage + IndexedDB 三重持久化）=====
const auth = {
  currentUser: null,

  async register(email, password) {
    email = email.trim().toLowerCase();
    const existing = await db.getUser(email);
    if (existing) throw new Error('该邮箱已注册，请先登录');

    const user = {
      email,
      passwordHash: simpleHash(password),
      nickname: '',
      avatar: '🧑',
      createdAt: new Date().toISOString(),
    };
    await db.putUser(user);
    return user;
  },

  async login(email, password) {
    email = email.trim().toLowerCase();
    const user = await db.getUser(email);
    if (!user) throw new Error('账号不存在，请先注册');
    if (user.passwordHash !== simpleHash(password)) throw new Error('密码错误');
    // 确保 v1 用户也有 nickname/avatar 字段
    if (!user.nickname) user.nickname = '';
    if (!user.avatar) user.avatar = '🧑';
    await db.putUser(user);
    return user;
  },

  setSession(user) {
    this.currentUser = user;
    // 三重持久化：localStorage + IndexedDB + Cookie
    // Cookie 是 iOS Safari ↔ PWA 唯一共享的存储，解决"浏览器注册后 PWA 还得再注册"的问题
    localStorage.setItem('et_user', JSON.stringify(user));
    db.setSetting('session_user', user.email);
    setCookie('et_sid', user.email, 365);
  },

  getSession() {
    if (this.currentUser) return this.currentUser;
    // 主力查 localStorage
    const saved = localStorage.getItem('et_user');
    if (saved) {
      try {
        this.currentUser = JSON.parse(saved);
        return this.currentUser;
      } catch (e) {
        localStorage.removeItem('et_user');
      }
    }
    return null;
  },

  async restoreSessionFromDB() {
    // 优先查 localStorage（最快）
    const ls = localStorage.getItem('et_user');
    if (ls) {
      try { this.currentUser = JSON.parse(ls); return this.currentUser; } catch (e) {}
    }
    // 然后查 Cookie（iOS Safari ↔ PWA 桥接）
    const cookieEmail = getCookie('et_sid');
    if (cookieEmail) {
      const user = await db.getUser(cookieEmail);
      if (user) {
        this.currentUser = user;
        localStorage.setItem('et_user', JSON.stringify(user));
        return user;
      }
    }
    // 最后查 IndexedDB（兜底）
    const sessionEmail = await db.getSetting('session_user');
    if (sessionEmail) {
      const user = await db.getUser(sessionEmail);
      if (user) {
        this.currentUser = user;
        localStorage.setItem('et_user', JSON.stringify(user));
        setCookie('et_sid', user.email, 365);
        return user;
      }
    }
    return null;
  },

  clearSession() {
    this.currentUser = null;
    localStorage.removeItem('et_user');
    db.setSetting('session_user', null);
    deleteCookie('et_sid');
  },

  async updateProfile(nickname, avatar) {
    const user = this.getSession();
    if (!user) return;
    user.nickname = nickname;
    user.avatar = avatar;
    await db.putUser(user);
    this.setSession(user);
  },
};

// ===== App State =====
const state = {
  categories: [...DEFAULT_CATEGORIES],
  selectedCategoryId: null,
  selectedAvatar: null,
  expenses: [],
  settings: { dailyLimit: 0, monthlyLimit: 0 },
  statsRange: 'week',
};

// ===== Utility =====
function fmt(amount) {
  return '¥' + Number(amount).toFixed(2);
}

function fmtDate(d) {
  const dt = new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayStr() {
  return fmtDate(new Date());
}

function getWeekRange() {
  const now = new Date();
  const day = now.getDay() || 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - day + 1);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { start: monday, end: sunday };
}

function getMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  return { start, end };
}

function getDaysArray(start, end) {
  const days = [];
  const d = new Date(start);
  while (d <= end) {
    days.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

function getCategoryById(id) {
  return state.categories.find(c => c.id === id) || state.categories.find(c => c.id === 'other');
}

function showToast(msg, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'toast show ' + type;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.className = 'toast hidden'; }, 2500);
}

// ===== UI: Auth Screen =====
let authMode = 'login';

function initAuth() {
  const form = document.getElementById('auth-form');
  const switchEl = document.getElementById('auth-switch');
  const submitBtn = document.getElementById('auth-submit');
  const hintEl = document.getElementById('auth-hint');

  // 用事件委托代替直接绑定 span，避免 innerHTML 替换后事件丢失
  switchEl.addEventListener('click', () => {
    authMode = authMode === 'login' ? 'register' : 'login';
    submitBtn.textContent = authMode === 'login' ? '登录' : '注册';
    switchEl.innerHTML = authMode === 'login'
      ? '还没有账号？<span>注册</span>'
      : '已有账号？<span>登录</span>';
    hintEl.textContent = '';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('auth-email').value;
    const password = document.getElementById('auth-password').value;
    hintEl.textContent = '';

    try {
      if (authMode === 'register') {
        const user = await auth.register(email, password);
        auth.setSession(user);
        showToast('注册成功，欢迎使用！', 'success');
        await enterApp();
      } else {
        const user = await auth.login(email, password);
        auth.setSession(user);
        showToast('登录成功', 'success');
        await enterApp();
      }
    } catch (err) {
      hintEl.textContent = err.message;
    }
  });
}

// ===== Enter App =====
async function enterApp() {
  const user = auth.getSession();
  if (!user) return;

  const authScreen = document.getElementById('auth-screen');
  const mainApp = document.getElementById('main-app');

  authScreen.classList.remove('active');
  authScreen.style.display = 'none';
  authScreen.style.visibility = 'hidden';
  authScreen.style.pointerEvents = 'none';

  mainApp.classList.remove('hidden');
  mainApp.style.display = '';
  mainApp.style.visibility = '';
  mainApp.style.pointerEvents = '';

  // 设置头像和昵称
  const displayName = user.nickname || user.email;
  const displayAvatar = user.avatar || user.email[0].toUpperCase();
  document.getElementById('settings-avatar').textContent = displayAvatar;
  document.getElementById('settings-nickname').textContent = displayName;
  document.getElementById('settings-email').textContent = user.email;
  document.getElementById('settings-since').textContent = '注册于 ' + new Date(user.createdAt).toLocaleDateString('zh-CN');

  // Load data
  await loadData();
  renderHome();
}

function logout() {
  auth.clearSession();
  const mainApp = document.getElementById('main-app');
  const authScreen = document.getElementById('auth-screen');

  mainApp.classList.add('hidden');
  mainApp.style.display = 'none';
  mainApp.style.visibility = 'hidden';

  authScreen.classList.add('active');
  authScreen.style.display = '';
  authScreen.style.visibility = '';
  authScreen.style.pointerEvents = '';

  document.getElementById('auth-email').value = '';
  document.getElementById('auth-password').value = '';
  document.getElementById('auth-hint').textContent = '';
}

// ===== Load Data =====
async function loadData() {
  const user = auth.getSession();
  state.expenses = await db.getAllExpenses(user.email);
  state.expenses.sort((a, b) => new Date(b.date + 'T' + (b.time || '00:00')) - new Date(a.date + 'T' + (a.time || '00:00')));

  const dailyLimit = await db.getSetting('dailyLimit_' + user.email);
  const monthlyLimit = await db.getSetting('monthlyLimit_' + user.email);
  state.settings.dailyLimit = dailyLimit || 0;
  state.settings.monthlyLimit = monthlyLimit || 0;
}

// ===== Render: Home =====
function renderHome() {
  const today = todayStr();
  const todayExpenses = state.expenses.filter(e => e.date === today);
  const todayTotal = todayExpenses.reduce((s, e) => s + e.amount, 0);
  document.getElementById('today-amount').textContent = fmt(todayTotal);

  // 剩余额度
  const remainingEl = document.getElementById('remaining-amount');
  const limit = state.settings.dailyLimit;

  if (limit > 0) {
    const remaining = limit - todayTotal;
    if (remaining >= 0) {
      remainingEl.textContent = fmt(remaining);
      remainingEl.className = 'remaining-amount';
    } else {
      remainingEl.textContent = '超支 ' + fmt(Math.abs(remaining));
      remainingEl.className = 'remaining-amount over-budget';
    }
  } else {
    remainingEl.textContent = '未设额度';
    remainingEl.className = 'remaining-amount no-limit';
  }

  // Budget bar (复用上面的 limit 变量)
  const barFill = document.getElementById('budget-bar-fill');
  const budgetText = document.getElementById('budget-text');
  const budgetPercent = document.getElementById('budget-percent');
  const budgetWarning = document.getElementById('budget-warning');

  if (limit > 0) {
    const pct = Math.min(todayTotal / limit * 100, 100);
    barFill.style.width = pct + '%';
    budgetText.textContent = fmt(todayTotal) + ' / ' + fmt(limit);
    budgetPercent.textContent = Math.round(todayTotal / limit * 100) + '%';

    if (todayTotal > limit) {
      barFill.classList.add('over');
      budgetWarning.classList.remove('hidden');
      budgetWarning.style.display = '';
      const over = todayTotal - limit;
      budgetWarning.querySelector('span').textContent = '⚠️ 已超支 ' + fmt(over) + '，请控制消费！';
    } else {
      barFill.classList.remove('over');
      if (pct >= 80) {
        budgetWarning.classList.remove('hidden');
        budgetWarning.style.display = '';
        budgetWarning.querySelector('span').textContent = '⚠️ 已用 ' + Math.round(pct) + '%，注意控制';
      } else {
        budgetWarning.classList.add('hidden');
        budgetWarning.style.display = 'none';
      }
    }
  } else {
    barFill.style.width = '0%';
    budgetText.textContent = '未设置每日额度';
    budgetPercent.textContent = '';
    budgetWarning.classList.add('hidden');
    budgetWarning.style.display = 'none';
    barFill.classList.remove('over');
  }

  // Recent expenses
  const recent = state.expenses.slice(0, 20);
  const listEl = document.getElementById('recent-list');
  document.getElementById('recent-count').textContent = state.expenses.length + ' 笔记录';

  if (recent.length === 0) {
    listEl.innerHTML = '<div class="empty-state"><div class="empty-icon">📝</div><p>还没有记录，点击上方按钮开始记账</p></div>';
    return;
  }

  listEl.innerHTML = recent.map(e => {
    const cat = getCategoryById(e.categoryId);
    return `
      <div class="expense-item" data-id="${e.id}">
        <div class="expense-icon" style="background:${cat.color}22">${cat.icon}</div>
        <div class="expense-detail">
          <div class="expense-category">${cat.name}</div>
          ${e.note ? `<div class="expense-note">${escapeHtml(e.note)}</div>` : ''}
          <div class="expense-time">${e.date}${e.time ? ' ' + e.time : ''}</div>
        </div>
        <div class="expense-amount">${fmt(e.amount)}</div>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('.expense-item').forEach(item => {
    item.addEventListener('click', async () => {
      const id = parseInt(item.dataset.id);
      if (confirm('确定删除这条记录？')) {
        await db.deleteExpense(id);
        state.expenses = state.expenses.filter(e => e.id !== id);
        renderHome();
        showToast('已删除', 'success');
      }
    });
  });
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ===== Render: Stats =====
function renderStats() {
  const range = state.statsRange;
  const { start, end } = range === 'week' ? getWeekRange() : getMonthRange();

  const periodExpenses = state.expenses.filter(e => {
    const d = new Date(e.date + 'T00:00:00');
    return d >= start && d <= end;
  });

  const total = periodExpenses.reduce((s, e) => s + e.amount, 0);
  document.getElementById('stats-period-label').textContent = range === 'week' ? '本周消费' : '本月消费';
  document.getElementById('stats-total').textContent = fmt(total);
  document.getElementById('stats-count').textContent = periodExpenses.length + ' 笔';

  if (periodExpenses.length === 0) {
    document.getElementById('stats-avg').textContent = '¥0.00';
    document.getElementById('stats-max').textContent = '¥0.00';
    document.getElementById('category-chart').innerHTML = '<div class="empty-state small"><p>暂无数据</p></div>';
    document.getElementById('trend-chart').innerHTML = '<div class="empty-state small"><p>暂无数据</p></div>';
    return;
  }

  const days = getDaysArray(start, end);
  const dayCount = days.length;
  document.getElementById('stats-avg').textContent = fmt(total / dayCount);

  const maxExpense = Math.max(...periodExpenses.map(e => e.amount));
  document.getElementById('stats-max').textContent = fmt(maxExpense);

  // Category breakdown
  const categoryTotals = {};
  for (const e of periodExpenses) {
    categoryTotals[e.categoryId] = (categoryTotals[e.categoryId] || 0) + e.amount;
  }
  const sortedCats = Object.entries(categoryTotals)
    .sort((a, b) => b[1] - a[1])
    .map(([id, amt]) => ({ ...getCategoryById(id), amount: amt, pct: amt / total * 100 }));

  const catChart = document.getElementById('category-chart');
  catChart.innerHTML = sortedCats.map(c => `
    <div class="category-bar-item">
      <div class="category-bar-icon">${c.icon}</div>
      <div class="category-bar-info">
        <div class="category-bar-top">
          <span class="category-bar-name">${c.name}</span>
          <span class="category-bar-amount">${fmt(c.amount)} · ${c.pct.toFixed(0)}%</span>
        </div>
        <div class="category-bar-track">
          <div class="category-bar-fill" style="width:${c.pct}%;background:${c.color}"></div>
        </div>
      </div>
    </div>
  `).join('');

  // Daily trend
  const trendChart = document.getElementById('trend-chart');
  const todayDateStr = todayStr();

  const dailyTotals = {};
  for (const d of days) {
    dailyTotals[fmtDate(d)] = 0;
  }
  for (const e of periodExpenses) {
    dailyTotals[e.date] = (dailyTotals[e.date] || 0) + e.amount;
  }

  const maxDaily = Math.max(...Object.values(dailyTotals), 1);

  let trendHtml = '';
  for (const d of days) {
    const ds = fmtDate(d);
    const amt = dailyTotals[ds] || 0;
    const heightPct = (amt / maxDaily) * 100;
    const isToday = ds === todayDateStr;
    const label = range === 'week'
      ? ['日','一','二','三','四','五','六'][d.getDay()]
      : d.getDate().toString();
    const showValue = amt > 0 ? fmt(amt).replace('¥','') : '';

    const showLabel = range === 'week' || d.getDate() === 1 || d.getDate() % 5 === 0 || isToday;

    trendHtml += `
      <div class="trend-bar-wrapper">
        ${showValue ? `<div class="trend-bar-value">${showValue}</div>` : '<div class="trend-bar-value">&nbsp;</div>'}
        <div class="trend-bar ${isToday ? 'today' : ''}" style="height:${Math.max(heightPct, 2)}%"></div>
        <div class="trend-bar-label">${showLabel ? label : ''}</div>
      </div>
    `;
  }
  trendChart.innerHTML = trendHtml;
}

// ===== Render: Settings =====
function renderSettings() {
  const user = auth.getSession();
  const displayName = user.nickname || user.email;
  const displayAvatar = user.avatar || user.email[0].toUpperCase();
  document.getElementById('settings-avatar').textContent = displayAvatar;
  document.getElementById('settings-nickname').textContent = displayName;
  document.getElementById('settings-email').textContent = user.email;

  document.getElementById('daily-limit-input').value = state.settings.dailyLimit || '';
  document.getElementById('monthly-limit-input').value = state.settings.monthlyLimit || '';

  // Category list
  const catList = document.getElementById('category-list');
  const catCounts = {};
  for (const e of state.expenses) {
    catCounts[e.categoryId] = (catCounts[e.categoryId] || 0) + 1;
  }
  catList.innerHTML = state.categories.map(c => `
    <div class="category-setting-item">
      <div class="category-setting-icon" style="background:${c.color}22">${c.icon}</div>
      <div class="category-setting-name">${c.name}</div>
      <div class="category-setting-count">${catCounts[c.id] || 0} 笔</div>
    </div>
  `).join('');
}

// ===== Profile Edit Modal =====
function openProfileModal() {
  const modal = document.getElementById('profile-modal');
  modal.classList.remove('hidden');
  modal.style.display = 'flex';

  const user = auth.getSession();
  state.selectedAvatar = user.avatar || '🧑';

  // 渲染头像选择网格
  const grid = document.getElementById('avatar-grid');
  grid.innerHTML = AVATAR_OPTIONS.map(a => `
    <button type="button" class="avatar-option ${a === state.selectedAvatar ? 'selected' : ''}" data-avatar="${a}">
      ${a}
    </button>
  `).join('');

  grid.querySelectorAll('.avatar-option').forEach(opt => {
    opt.addEventListener('click', () => {
      grid.querySelectorAll('.avatar-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      state.selectedAvatar = opt.dataset.avatar;
    });
  });

  // 设置当前昵称
  document.getElementById('nickname-input').value = user.nickname || '';
}

function closeProfileModal() {
  const modal = document.getElementById('profile-modal');
  modal.classList.add('hidden');
  modal.style.display = 'none';
}

async function saveProfile() {
  const nickname = document.getElementById('nickname-input').value.trim();
  const avatar = state.selectedAvatar || auth.getSession().avatar;
  await auth.updateProfile(nickname, avatar);
  renderSettings();
  closeProfileModal();
  showToast('个人信息已更新', 'success');
}

// ===== Add Expense Modal =====
function openAddModal() {
  const modal = document.getElementById('add-modal');
  modal.classList.remove('hidden');
  modal.style.display = 'flex';
  document.getElementById('expense-amount').value = '';
  document.getElementById('expense-note').value = '';
  document.getElementById('expense-date').value = todayStr();
  state.selectedCategoryId = null;

  const grid = document.getElementById('category-grid');
  grid.innerHTML = state.categories.map(c => `
    <button type="button" class="category-option" data-id="${c.id}">
      <div class="category-option-icon">${c.icon}</div>
      <div class="category-option-name">${c.name}</div>
    </button>
  `).join('');

  grid.querySelectorAll('.category-option').forEach(opt => {
    opt.addEventListener('click', () => {
      grid.querySelectorAll('.category-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      state.selectedCategoryId = opt.dataset.id;
    });
  });

  setTimeout(() => document.getElementById('expense-amount').focus(), 300);
}

function closeAddModal() {
  const modal = document.getElementById('add-modal');
  modal.classList.add('hidden');
  modal.style.display = 'none';
}

async function submitExpense(e) {
  e.preventDefault();
  const amount = parseFloat(document.getElementById('expense-amount').value);
  const note = document.getElementById('expense-note').value.trim();
  const date = document.getElementById('expense-date').value;

  if (!amount || amount <= 0) { showToast('请输入有效金额', 'error'); return; }
  if (!state.selectedCategoryId) { showToast('请选择分类', 'error'); return; }
  if (!date) { showToast('请选择日期', 'error'); return; }

  const user = auth.getSession();
  const now = new Date();
  const expense = {
    userId: user.email,
    amount: Math.round(amount * 100) / 100,
    categoryId: state.selectedCategoryId,
    note,
    date,
    time: now.toTimeString().slice(0, 5),
    createdAt: now.toISOString(),
  };

  await db.addExpense(expense);
  state.expenses.unshift({ ...expense, id: Date.now() });
  state.expenses.sort((a, b) => new Date(b.date + 'T' + (b.time || '00:00')) - new Date(a.date + 'T' + (a.time || '00:00')));

  closeAddModal();
  renderHome();

  if (state.settings.dailyLimit > 0) {
    const todayTotal = state.expenses
      .filter(e => e.date === todayStr())
      .reduce((s, e) => s + e.amount, 0);
    if (todayTotal > state.settings.dailyLimit) {
      const over = todayTotal - state.settings.dailyLimit;
      showToast('⚠️ 今日已超支 ' + fmt(over) + '！', 'warning');
    } else if (todayTotal >= state.settings.dailyLimit * 0.8) {
      showToast('今日已用 ' + Math.round(todayTotal / state.settings.dailyLimit * 100) + '%，注意控制', 'warning');
    } else {
      showToast('记录成功', 'success');
    }
  } else {
    showToast('记录成功', 'success');
  }
}

// ===== Save Limits =====
async function saveLimits() {
  const user = auth.getSession();
  const daily = parseFloat(document.getElementById('daily-limit-input').value) || 0;
  const monthly = parseFloat(document.getElementById('monthly-limit-input').value) || 0;

  await db.setSetting('dailyLimit_' + user.email, daily);
  await db.setSetting('monthlyLimit_' + user.email, monthly);
  state.settings.dailyLimit = daily;
  state.settings.monthlyLimit = monthly;

  showToast('额度已保存', 'success');
  renderHome();
}

// ===== Export Data =====
function exportData() {
  const user = auth.getSession();
  const data = {
    user: { email: user.email, nickname: user.nickname, avatar: user.avatar, createdAt: user.createdAt },
    expenses: state.expenses,
    settings: state.settings,
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '记账本_导出_' + todayStr() + '.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('数据已导出', 'success');
}

// ===== Clear Data =====
async function clearData() {
  if (!confirm('确定要清空所有记录吗？此操作不可撤销！')) return;
  if (!confirm('再次确认：所有消费记录将被永久删除！')) return;
  const user = auth.getSession();
  await db.clearExpenses(user.email);
  state.expenses = [];
  renderHome();
  renderSettings();
  showToast('所有记录已清空', 'success');
}

// ===== Navigation =====
function switchPage(pageName) {
  document.querySelectorAll('.page').forEach(p => {
    p.classList.remove('active');
    p.style.display = 'none';
  });
  const targetPage = document.getElementById('page-' + pageName);
  targetPage.classList.add('active');
  targetPage.style.display = 'block';
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navItem = document.querySelector(`.nav-item[data-page="${pageName}"]`);
  if (navItem) navItem.classList.add('active');

  if (pageName === 'home') renderHome();
  if (pageName === 'stats') renderStats();
  if (pageName === 'settings') renderSettings();
}

// ===== Init =====
async function init() {
  await db.init();

  initAuth();

  // Navigation
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => switchPage(item.dataset.page));
  });

  // Add expense
  document.getElementById('fab-add').addEventListener('click', openAddModal);
  document.getElementById('modal-close').addEventListener('click', closeAddModal);
  document.querySelector('#add-modal .modal-overlay').addEventListener('click', closeAddModal);
  document.getElementById('expense-form').addEventListener('submit', submitExpense);

  // Profile edit
  document.getElementById('edit-profile-btn').addEventListener('click', openProfileModal);
  document.getElementById('profile-modal-close').addEventListener('click', closeProfileModal);
  document.querySelector('#profile-modal .modal-overlay').addEventListener('click', closeProfileModal);
  document.getElementById('save-profile').addEventListener('click', saveProfile);

  // Settings
  document.getElementById('save-limits').addEventListener('click', saveLimits);
  document.getElementById('export-data').addEventListener('click', exportData);
  document.getElementById('clear-data').addEventListener('click', clearData);
  document.getElementById('logout-btn').addEventListener('click', logout);

  // Stats tabs
  document.querySelectorAll('#stats-tabs .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#stats-tabs .tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state.statsRange = tab.dataset.range;
      renderStats();
    });
  });

  // Check existing session
  // 先查 localStorage（快速），如果没找到再从 IndexedDB 恢复（iOS PWA 杀后台后 localStorage 可能被清）
  let user = auth.getSession();
  if (!user) {
    user = await auth.restoreSessionFromDB();
  }
  if (user) {
    await enterApp();
  }

  // Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
