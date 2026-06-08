/* ============================================================
   INEZA PLATFORM — FRONTEND API CLIENT
   Connects all HTML pages to the Node.js backend
   Include after app.js on every page:
   <script src="/js/api.js"></script>
   ============================================================ */

'use strict';

const API_BASE = window.location.hostname === 'localhost'
  ? 'http://localhost:5000/api/v1'
  : '/api/v1';

/* ── TOKEN MANAGEMENT ────────────────────────────────────────── */
const Token = {
  get()        { return localStorage.getItem('ineza_access_token'); },
  set(t)       { localStorage.setItem('ineza_access_token', t); },
  remove()     { localStorage.removeItem('ineza_access_token'); localStorage.removeItem('ineza_refresh_token'); },
  getRefresh() { return localStorage.getItem('ineza_refresh_token'); },
  setRefresh(t){ localStorage.setItem('ineza_refresh_token', t); }
};

/* ── CORE HTTP CLIENT ────────────────────────────────────────── */
let _refreshing = false;

async function http(method, path, body = null, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = Token.get();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const config = {
    method,
    headers,
    credentials: 'include',
    ...(body && method !== 'GET' ? { body: JSON.stringify(body) } : {})
  };

  let res = await fetch(`${API_BASE}${path}`, config);

  // Auto-refresh token on 401
  if (res.status === 401 && !opts.noRetry) {
    const data = await res.json().catch(() => ({}));
    if (data.code === 'TOKEN_EXPIRED' && !_refreshing) {
      _refreshing = true;
      try {
        const refresh = await fetch(`${API_BASE}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ refresh_token: Token.getRefresh() })
        });
        if (refresh.ok) {
          const { accessToken, refreshToken } = await refresh.json();
          Token.set(accessToken);
          Token.setRefresh(refreshToken);
          headers['Authorization'] = `Bearer ${accessToken}`;
          res = await fetch(`${API_BASE}${path}`, config);
        } else {
          // Refresh failed → logout
          API.auth.logout();
          return null;
        }
      } finally { _refreshing = false; }
    } else if (!data.code) {
      API.auth.logout();
      return null;
    }
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw Object.assign(new Error(err.error || 'Request failed'), { status: res.status, data: err });
  }

  return res.status === 204 ? null : res.json();
}

const get    = (p, opts)    => http('GET',    p, null, opts);
const post   = (p, b, opts) => http('POST',   p, b, opts);
const put    = (p, b, opts) => http('PUT',    p, b, opts);
const patch  = (p, b, opts) => http('PATCH',  p, b, opts);
const del    = (p, opts)    => http('DELETE', p, null, opts);

/* ── UPLOAD HELPER ───────────────────────────────────────────── */
async function upload(path, formData) {
  const token = Token.get();
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: token ? { 'Authorization': `Bearer ${token}` } : {},
    credentials: 'include',
    body: formData
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Upload failed' }));
    throw new Error(err.error);
  }
  return res.json();
}

/* ============================================================
   API NAMESPACE — All endpoints
   ============================================================ */
const API = {

  /* ── AUTH ───────────────────────────────────────────────── */
  auth: {
    async signup(data) {
      const res = await post('/auth/signup', data);
      if (res.accessToken)  { Token.set(res.accessToken); Token.setRefresh(res.refreshToken); }
      if (res.user)         Auth.setUser(res.user);
      return res;
    },
    async signin(email, password, remember_me = true) {
      const res = await post('/auth/signin', { email, password, remember_me });
      if (res.accessToken)  { Token.set(res.accessToken); Token.setRefresh(res.refreshToken); }
      if (res.user)         Auth.setUser(res.user);
      return res;
    },
    async me()             { return get('/auth/me'); },
    async signout() {
      try { await post('/auth/signout'); } catch {}
      Token.remove();
      Auth.setUser(null);
      window.location.href = '/index.html';
    },
    logout() { return this.signout(); },
    async refresh()        { return post('/auth/refresh'); },
    async verifyEmail(token) { return get(`/auth/verify-email/${token}`); },
    async forgotPassword(email) { return post('/auth/forgot-password', { email }); },
    async resetPassword(token, password) { return post('/auth/reset-password', { token, password }); },
    async changePassword(current_password, new_password) { return post('/auth/change-password', { current_password, new_password }); }
  },

  /* ── JOBS ───────────────────────────────────────────────── */
  jobs: {
    list(params = {})         { return get('/jobs?' + new URLSearchParams(params).toString()); },
    get(id)                   { return get(`/jobs/${id}`); },
    create(data)              { return post('/jobs', data); },
    update(id, data)          { return put(`/jobs/${id}`, data); },
    setStatus(id, status)     { return patch(`/jobs/${id}/status`, { status }); },
    delete(id)                { return del(`/jobs/${id}`); },
    applications(id, params)  { return get(`/jobs/${id}/applications?${new URLSearchParams(params || {})}`); },
    recommended(candidateId)  { return get(`/jobs/recommended/${candidateId}`); }
  },

  /* ── APPLICATIONS ───────────────────────────────────────── */
  applications: {
    apply(job_id, data)         { return post('/applications', { job_id, ...data }); },
    mine(params = {})           { return get('/applications/mine?' + new URLSearchParams(params)); },
    get(id)                     { return get(`/applications/${id}`); },
    updateStatus(id, data)      { return patch(`/applications/${id}/status`, data); },
    withdraw(id)                { return del(`/applications/${id}`); },
    saveNotes(id, notes, score) { return post(`/applications/${id}/notes`, { notes, score }); }
  },

  /* ── CANDIDATES ─────────────────────────────────────────── */
  candidates: {
    getProfile()              { return get('/candidates/profile'); },
    updateProfile(data)       { return put('/candidates/profile', data); },
    updateSkills(skills)      { return post('/candidates/skills', { skills }); },
    addExperience(data)       { return post('/candidates/experience', data); },
    deleteExperience(id)      { return del(`/candidates/experience/${id}`); },
    getSavedJobs()            { return get('/candidates/saved-jobs'); },
    toggleSaveJob(jobId)      { return post(`/candidates/saved-jobs/${jobId}`); },
    getAlerts()               { return get('/candidates/alerts'); },
    createAlert(data)         { return post('/candidates/alerts', data); },
    updateAlert(id, data)     { return patch(`/candidates/alerts/${id}`, data); },
    deleteAlert(id)           { return del(`/candidates/alerts/${id}`); },
    getDashboard()            { return get('/candidates/dashboard'); }
  },

  /* ── EMPLOYERS ──────────────────────────────────────────── */
  employers: {
    getProfile()              { return get('/employers/profile'); },
    updateProfile(data)       { return put('/employers/profile', data); },
    getDashboard()            { return get('/employers/dashboard'); },
    getBySlug(slug)           { return get(`/employers/${slug}`); }
  },

  /* ── PAYMENTS ───────────────────────────────────────────── */
  payments: {
    initiate(data)            { return post('/payments/initiate', data); },
    verify(id)                { return get(`/payments/verify/${id}`); },
    history()                 { return get('/payments/history'); },
    getSubscription()         { return get('/payments/subscription'); },
    cancelSubscription(reason){ return post('/payments/subscription/cancel', { reason }); }
  },

  /* ── MESSAGES ───────────────────────────────────────────── */
  messages: {
    conversations()           { return get('/messages/conversations'); },
    getConversation(id)       { return get(`/messages/conversations/${id}`); },
    startConversation(recipientId, body, jobId) {
      return post('/messages/conversations', { recipient_id: recipientId, body, job_id: jobId });
    },
    reply(convId, body)       { return post(`/messages/conversations/${convId}/reply`, { body }); }
  },

  /* ── NOTIFICATIONS ──────────────────────────────────────── */
  notifications: {
    list(params = {})         { return get('/notifications?' + new URLSearchParams(params)); },
    markRead(id)              { return patch(`/notifications/${id}/read`); },
    markAllRead()             { return patch('/notifications/read-all'); },
    delete(id)                { return del(`/notifications/${id}`); }
  },

  /* ── UPLOADS ────────────────────────────────────────────── */
  uploads: {
    cv(file) {
      const fd = new FormData(); fd.append('cv', file);
      return upload('/uploads/cv', fd);
    },
    photo(file) {
      const fd = new FormData(); fd.append('photo', file);
      return upload('/uploads/photo', fd);
    },
    logo(file) {
      const fd = new FormData(); fd.append('logo', file);
      return upload('/uploads/company-logo', fd);
    }
  },

  /* ── ANALYTICS ──────────────────────────────────────────── */
  analytics: {
    track(event_type, job_id, data) { return post('/analytics/track', { event_type, job_id, data }); },
    overview(days = 30)             { return get(`/analytics/overview?days=${days}`); },
    job(id)                         { return get(`/analytics/jobs/${id}`); }
  },

  /* ── ADMIN ──────────────────────────────────────────────── */
  admin: {
    stats()                   { return get('/admin/stats'); },
    users(params = {})        { return get('/admin/users?' + new URLSearchParams(params)); },
    getUser(id)               { return get(`/admin/users/${id}`); },
    updateUser(id, data)      { return patch(`/admin/users/${id}`, data); },
    deleteUser(id)            { return del(`/admin/users/${id}`); },
    pendingJobs()             { return get('/admin/jobs/pending'); },
    approveJob(id, data)      { return patch(`/admin/jobs/${id}/approve`, data); },
    rejectJob(id, reason)     { return patch(`/admin/jobs/${id}/reject`, { reason }); },
    revenue()                 { return get('/admin/revenue'); },
    payments(params = {})     { return get('/admin/payments?' + new URLSearchParams(params)); },
    refundPayment(id, reason) { return post(`/admin/payments/${id}/refund`, { reason }); },
    verifications()           { return get('/admin/verifications'); },
    verifyEmployer(id)        { return patch(`/admin/verify-employer/${id}`); },
    broadcast(data)           { return post('/admin/broadcast', data); },
    auditLogs(params = {})    { return get('/admin/audit-logs?' + new URLSearchParams(params)); }
  }
};

/* ── SOCKET.IO REAL-TIME CONNECTION ─────────────────────────── */
const RealTime = {
  socket: null,
  init() {
    const token = Token.get();
    if (!token || typeof io === 'undefined') return;

    this.socket = io(window.location.origin, {
      auth: { token },
      transports: ['websocket', 'polling']
    });

    this.socket.on('connect', () => console.log('[Ineza] Real-time connected'));
    this.socket.on('disconnect', () => console.log('[Ineza] Real-time disconnected'));

    this.socket.on('new_application', (data) => {
      Toast.info(`New application for: ${data.jobTitle}`);
      document.dispatchEvent(new CustomEvent('ineza:new_application', { detail: data }));
    });

    this.socket.on('application_update', (data) => {
      Toast.success(data.message);
      document.dispatchEvent(new CustomEvent('ineza:application_update', { detail: data }));
    });

    this.socket.on('new_message', (data) => {
      document.dispatchEvent(new CustomEvent('ineza:new_message', { detail: data }));
      // Update unread badge
      const badge = document.querySelector('[data-unread-messages]');
      if (badge) badge.textContent = parseInt(badge.textContent || '0') + 1;
    });

    this.socket.on('message_notification', (data) => {
      Toast.info(`New message: "${data.preview}"`);
    });

    this.socket.on('admin:new_job', (data) => {
      Toast.info(`New job submitted: ${data.title} by ${data.company}`);
    });
  },

  joinConversation(convId) {
    if (this.socket) this.socket.emit('join_conversation', convId);
  },

  sendMessage(convId, recipientId, body) {
    if (this.socket) this.socket.emit('send_message', { conversationId: convId, recipientId, body });
  },

  sendTyping(convId) {
    if (this.socket) this.socket.emit('typing', { conversationId: convId });
  }
};

/* ── PAGE HELPERS ────────────────────────────────────────────── */

// Auto-load user data into nav on page load
async function initPage() {
  const user = Auth.getUser();
  if (!user && Token.get()) {
    try {
      const data = await API.auth.me();
      if (data?.user) Auth.setUser(data.user);
    } catch { Token.remove(); }
  }
  Auth.updateNavForUser();
  RealTime.init();

  // Unread notification badge
  if (Auth.getUser()) {
    try {
      const notifs = await API.notifications.list({ unread: 'true', limit: 1 });
      const count = notifs?.unread_count || 0;
      document.querySelectorAll('[data-notif-count]').forEach(el => {
        el.textContent = count;
        el.style.display = count > 0 ? '' : 'none';
      });
    } catch {}
  }
}

// Redirect helpers
function requireLogin(role) {
  const user = Auth.getUser();
  if (!user) {
    window.location.href = `/auth/signin.html?redirect=${encodeURIComponent(window.location.pathname)}`;
    return false;
  }
  if (role && user.role !== role && user.role !== 'admin') {
    window.location.href = '/index.html';
    return false;
  }
  return user;
}

// Form serialiser
function formToObject(formEl) {
  const fd = new FormData(formEl);
  const obj = {};
  for (const [k, v] of fd.entries()) {
    if (obj[k] !== undefined) {
      obj[k] = Array.isArray(obj[k]) ? [...obj[k], v] : [obj[k], v];
    } else { obj[k] = v; }
  }
  return obj;
}

// Initialise on every page
document.addEventListener('DOMContentLoaded', initPage);

// Export for module usage
if (typeof module !== 'undefined') module.exports = { API, Token, RealTime, requireLogin, formToObject };
