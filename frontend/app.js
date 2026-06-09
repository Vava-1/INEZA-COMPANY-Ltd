/* ============================================================
   INEZA PLATFORM — SHARED JAVASCRIPT
   ============================================================ */

'use strict';

/* ── NAVBAR ─────────────────────────────────────────────────── */
const Navbar = {
  init() {
    const nav = document.getElementById('navbar');
    if (!nav) return;
    window.addEventListener('scroll', () => {
      nav.classList.toggle('scrolled', window.scrollY > 40);
    });
    // Mobile toggle
    const toggle = document.getElementById('nav-toggle');
    const mobileMenu = document.getElementById('mobile-menu');
    if (toggle && mobileMenu) {
      toggle.addEventListener('click', () => {
        mobileMenu.classList.toggle('open');
        document.body.style.overflow = mobileMenu.classList.contains('open') ? 'hidden' : '';
      });
    }
    // Active link highlighting
    const path = window.location.pathname.split('/').pop();
    document.querySelectorAll('.nav-link').forEach(link => {
      const href = link.getAttribute('href');
      if (href && href.includes(path) && path !== '') link.classList.add('active');
    });
  }
};

/* ── SCROLL REVEAL ──────────────────────────────────────────── */
const Reveal = {
  init() {
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) { e.target.classList.add('visible'); io.unobserve(e.target); }
      });
    }, { threshold: 0.1 });
    document.querySelectorAll('.reveal').forEach(el => io.observe(el));
  }
};

/* ── COUNTER ANIMATION ──────────────────────────────────────── */
const Counter = {
  animate(el, target, suffix = '', duration = 2000) {
    const start = performance.now();
    const update = (now) => {
      const p = Math.min((now - start) / duration, 1);
      const ease = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(target * ease).toLocaleString() + suffix;
      if (p < 1) requestAnimationFrame(update);
    };
    requestAnimationFrame(update);
  },
  init() {
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (!e.isIntersecting) return;
        const el = e.target;
        const target = parseFloat(el.dataset.target);
        const suffix = el.dataset.suffix || '';
        const duration = parseInt(el.dataset.duration || '2000');
        this.animate(el, target, suffix, duration);
        io.unobserve(el);
      });
    }, { threshold: 0.5 });
    document.querySelectorAll('[data-counter]').forEach(el => io.observe(el));
  }
};

/* ── TOAST NOTIFICATIONS ────────────────────────────────────── */
const Toast = {
  container: null,
  init() {
    this.container = document.getElementById('toast-container');
    if (!this.container) {
      this.container = document.createElement('div');
      this.container.id = 'toast-container';
      document.body.appendChild(this.container);
    }
  },
  show(message, type = 'info', duration = 4000) {
    if (!this.container) this.init();
    const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<span class="toast-icon">${icons[type]||'ℹ️'}</span><span>${message}</span>`;
    this.container.appendChild(toast);
    setTimeout(() => {
      toast.style.animation = 'slideIn .35s ease reverse';
      setTimeout(() => toast.remove(), 340);
    }, duration);
    return toast;
  },
  success(msg, d) { return this.show(msg, 'success', d); },
  error(msg, d)   { return this.show(msg, 'error', d); },
  info(msg, d)    { return this.show(msg, 'info', d); },
  warning(msg, d) { return this.show(msg, 'warning', d); }
};

/* ── MODAL ──────────────────────────────────────────────────── */
const Modal = {
  open(id) {
    const overlay = document.getElementById(id);
    if (!overlay) return;
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.close(id);
    });
  },
  close(id) {
    const overlay = document.getElementById(id);
    if (!overlay) return;
    overlay.classList.remove('open');
    document.body.style.overflow = '';
  },
  closeAll() {
    document.querySelectorAll('.modal-overlay.open').forEach(m => {
      m.classList.remove('open');
    });
    document.body.style.overflow = '';
  }
};
document.addEventListener('keydown', e => { if (e.key === 'Escape') Modal.closeAll(); });

/* ── DROPDOWN ───────────────────────────────────────────────── */
const Dropdown = {
  init() {
    document.addEventListener('click', (e) => {
      const toggle = e.target.closest('[data-dropdown]');
      document.querySelectorAll('.dropdown.open').forEach(d => {
        if (!d.contains(e.target)) d.classList.remove('open');
      });
      if (toggle) {
        const parent = toggle.closest('.dropdown');
        if (parent) parent.classList.toggle('open');
      }
    });
  }
};

/* ── TABS ───────────────────────────────────────────────────── */
const Tabs = {
  init() {
    document.querySelectorAll('[data-tab]').forEach(tab => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.tab;
        const group = tab.dataset.group;
        // Deactivate all in group
        document.querySelectorAll(`[data-tab][data-group="${group}"]`).forEach(t => t.classList.remove('active'));
        document.querySelectorAll(`[data-panel][data-group="${group}"]`).forEach(p => p.style.display = 'none');
        // Activate target
        tab.classList.add('active');
        const panel = document.querySelector(`[data-panel="${target}"][data-group="${group}"]`);
        if (panel) panel.style.display = 'block';
      });
    });
  }
};

/* ── FORM VALIDATION ────────────────────────────────────────── */
const FormValidator = {
  rules: {
    required: v => v.trim().length > 0,
    email: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
    phone: v => /^\+?[\d\s\-]{8,}$/.test(v),
    minLength: (v, n) => v.trim().length >= n,
    maxLength: (v, n) => v.trim().length <= n,
    numeric: v => /^\d+$/.test(v),
    password: v => v.length >= 8,
  },
  validate(form) {
    let valid = true;
    form.querySelectorAll('[data-validate]').forEach(input => {
      const rules = input.dataset.validate.split('|');
      const group = input.closest('.form-group');
      const errEl = group?.querySelector('.form-error');
      let inputValid = true;
      for (const rule of rules) {
        const [name, param] = rule.split(':');
        if (!this.rules[name]) continue;
        if (!this.rules[name](input.value, param)) {
          inputValid = false;
          const msg = input.dataset[name + 'Msg'] || this.defaultMessages[name] || 'Invalid input';
          if (errEl) errEl.textContent = msg;
          break;
        }
      }
      if (group) group.classList.toggle('has-error', !inputValid);
      if (!inputValid) valid = false;
    });
    return valid;
  },
  defaultMessages: {
    required: 'This field is required',
    email: 'Please enter a valid email address',
    phone: 'Please enter a valid phone number',
    password: 'Password must be at least 8 characters',
    minLength: 'This field is too short',
    maxLength: 'This field is too long',
  }
};

/* ── PAYMENT SIMULATION ─────────────────────────────────────── */
const Payment = {
  plans: {
    // Candidate plans
    candidate_free:    { id:'candidate_free',    name:'Free',       price:0,    currency:'RWF', period:'forever' },
    candidate_pro:     { id:'candidate_pro',     name:'Pro Seeker', price:5000, currency:'RWF', period:'month'  },
    candidate_premium: { id:'candidate_premium', name:'Premium',    price:9900, currency:'RWF', period:'month'  },
    // Employer plans
    employer_starter:  { id:'employer_starter',  name:'Starter',   price:49000,  currency:'RWF', period:'month', jobs:3 },
    employer_business: { id:'employer_business', name:'Business',  price:120000, currency:'RWF', period:'month', jobs:15 },
    employer_enterprise:{ id:'employer_enterprise',name:'Enterprise',price:290000,currency:'RWF', period:'month', jobs:-1 },
  },

  formatPrice(amount, currency) {
    if (amount === 0) return 'Free';
    if (currency === 'RWF') return `RWF ${amount.toLocaleString()}`;
    return `$${amount}`;
  },

  async processPayment(planId, paymentData) {
    // Simulate payment gateway (MTN MoMo, Airtel Money, Card)
    return new Promise((resolve, reject) => {
      Toast.info('Processing payment…');
      setTimeout(() => {
        // Simulate 95% success rate
        if (Math.random() > 0.05) {
          resolve({
            success: true,
            transactionId: 'INA-' + Date.now(),
            plan: this.plans[planId],
            timestamp: new Date().toISOString()
          });
        } else {
          reject({ success: false, error: 'Payment declined. Please try again.' });
        }
      }, 2000);
    });
  },

  showCheckout(planId) {
    const plan = this.plans[planId];
    if (!plan) return;
    const overlay = document.getElementById('payment-modal');
    if (!overlay) return;
    document.getElementById('pm-plan-name').textContent = plan.name;
    document.getElementById('pm-plan-price').textContent = this.formatPrice(plan.price, plan.currency);
    document.getElementById('pm-plan-period').textContent = plan.period;
    document.getElementById('pm-plan-id').value = planId;
    Modal.open('payment-modal');
  }
};

/* ── AUTH STATE ─────────────────────────────────────────────── */
const Auth = {
  getUser() {
    const raw = localStorage.getItem('ineza_user');
    return raw ? JSON.parse(raw) : null;
  },
  setUser(user) {
    localStorage.setItem('ineza_user', JSON.stringify(user));
  },
  logout() {
    localStorage.removeItem('ineza_user');
    window.location.href = '../index.html';
  },
  requireAuth(role) {
    const user = this.getUser();
    if (!user) { window.location.href = '../auth/signin.html'; return false; }
    if (role && user.role !== role) { window.location.href = '../index.html'; return false; }
    return user;
  },
  updateNavForUser() {
    const user = this.getUser();
    const authArea = document.getElementById('nav-auth');
    if (!authArea) return;
    if (user) {
      authArea.innerHTML = `
        <div class="dropdown">
          <button class="btn btn-secondary btn-sm" data-dropdown style="gap:.5rem">
            <div class="avatar avatar-sm" style="background:var(--em-glow);color:var(--em-400);border-color:var(--em-400)">${user.name[0]}</div>
            ${user.name.split(' ')[0]} ▾
          </button>
          <div class="dropdown-menu">
            <div class="dropdown-item" onclick="window.location.href='/${user.role}/dashboard.html'">🏠 Dashboard</div>
            <div class="dropdown-item" onclick="window.location.href='/${user.role}/profile.html'">👤 My Profile</div>
            <div class="dropdown-item" onclick="window.location.href='/${user.role}/settings.html'">⚙️ Settings</div>
            <div class="dropdown-divider"></div>
            <div class="dropdown-item danger" onclick="Auth.logout()">🚪 Sign Out</div>
          </div>
        </div>`;
    } else {
      authArea.innerHTML = `
        <a href="auth/signin.html" class="btn btn-secondary btn-sm">Sign In</a>
        <a href="auth/signup.html" class="btn btn-primary btn-sm">Get Started Free</a>`;
    }
  }
};

/* ── SEARCH ─────────────────────────────────────────────────── */
const Search = {
  init() {
    const input = document.getElementById('hero-search');
    if (!input) return;
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const q = input.value.trim();
        const loc = document.getElementById('hero-location')?.value || '';
        if (q) window.location.href = `jobs/board.html?q=${encodeURIComponent(q)}&loc=${encodeURIComponent(loc)}`;
      }
    });
  }
};

/* ── GLOBE CANVAS ───────────────────────────────────────────── */
const Globe = {
  init(canvasId) {
    const cv = document.getElementById(canvasId);
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    const W = 480, H = 480;
    cv.width = W * DPR; cv.height = H * DPR;
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    ctx.scale(DPR, DPR);
    const CX = W/2, CY = H/2, R = 175;
    let rot = 0;

    const cities = [
      {lat:1.94,lon:30.06,main:true},  // Kigali
      {lat:51.5,lon:-0.1},{lat:40.7,lon:-74},
      {lat:35.7,lon:139.7},{lat:-33.9,lon:18.4},
      {lat:1.3,lon:103.8},{lat:48.8,lon:2.3},
      {lat:25.2,lon:55.3},{lat:-1.3,lon:36.8},
      {lat:6.5,lon:3.4},{lat:30.0,lon:31.2},
      {lat:52.5,lon:13.4},{lat:-0.3,lon:36.1},
      {lat:-6.8,lon:39.3},{lat:43.7,lon:-79.4},
      {lat:-3.4,lon:29.4},{lat:55.7,lon:37.6}
    ].map(c => ({lat:c.lat*Math.PI/180, lon:c.lon*Math.PI/180, main:!!c.main}));

    function proj(lat, lon) {
      const rl = lon + rot;
      return {
        x: CX + R * Math.cos(lat) * Math.sin(rl),
        y: CY - R * Math.sin(lat),
        z: R * Math.cos(lat) * Math.cos(rl)
      };
    }

    function drawLine(pts, alpha, lw) {
      ctx.beginPath(); let d = false;
      for (const p of pts) {
        if (p.z >= 0) { if (!d) { ctx.moveTo(p.x,p.y); d=true; } else ctx.lineTo(p.x,p.y); }
        else d = false;
      }
      ctx.strokeStyle = `rgba(0,229,153,${alpha})`; ctx.lineWidth = lw; ctx.stroke();
    }

    function frame() {
      ctx.clearRect(0, 0, W, H);
      // Glow sphere background
      const grd = ctx.createRadialGradient(CX,CY,0,CX,CY,R);
      grd.addColorStop(0,'rgba(0,229,153,.04)');
      grd.addColorStop(1,'rgba(59,130,246,.02)');
      ctx.beginPath(); ctx.arc(CX,CY,R,0,Math.PI*2);
      ctx.fillStyle = grd; ctx.fill();

      // Latitude lines
      for (let lat=-75; lat<=75; lat+=15) {
        const lr = lat*Math.PI/180, pts=[];
        for (let i=0;i<=120;i++) pts.push(proj(lr,(i/120)*Math.PI*2));
        drawLine(pts, lat===0?.18:.08, lat===0?1:.5);
      }
      // Longitude lines
      for (let lon=0;lon<360;lon+=15) {
        const lr=lon*Math.PI/180, pts=[];
        for (let i=0;i<=120;i++) pts.push(proj((i/120)*Math.PI-Math.PI/2,lr));
        drawLine(pts, .08, .5);
      }
      // Sphere edge
      ctx.beginPath(); ctx.arc(CX,CY,R,0,Math.PI*2);
      ctx.strokeStyle='rgba(0,229,153,.3)'; ctx.lineWidth=1.5; ctx.stroke();

      // Orbit rings
      for (const [angle, rx, ry, alpha] of [[-20,R*1.5,R*.22,.5],[15,R*1.3,R*.18,.3]]) {
        ctx.save(); ctx.translate(CX,CY); ctx.rotate(angle*Math.PI/180);
        ctx.beginPath(); ctx.ellipse(0,0,rx,ry,0,0,Math.PI*2);
        ctx.strokeStyle=`rgba(0,229,153,${alpha})`; ctx.lineWidth=1.5; ctx.stroke();
        // Satellite dot
        const sa = rot*2.2+angle;
        ctx.beginPath(); ctx.arc(rx*Math.cos(sa),ry*Math.sin(sa),3,0,Math.PI*2);
        ctx.fillStyle='rgba(0,229,153,.9)'; ctx.fill();
        ctx.restore();
      }

      // Cities
      for (const c of cities) {
        const p = proj(c.lat,c.lon);
        if (p.z < -R*.2) continue;
        const b = Math.max(0,(p.z+R)/(2*R));
        if (c.main && p.z>0) {
          // Kigali pulse
          const ph=(Date.now()/900)%1;
          ctx.beginPath(); ctx.arc(p.x,p.y,7+ph*15,0,Math.PI*2);
          ctx.strokeStyle=`rgba(0,229,153,${.6-ph*.6})`; ctx.lineWidth=1; ctx.stroke();
          ctx.beginPath(); ctx.arc(p.x,p.y,5,0,Math.PI*2);
          ctx.fillStyle='rgba(0,229,153,.95)'; ctx.fill();
        } else {
          ctx.beginPath(); ctx.arc(p.x,p.y,1.8+b*1.2,0,Math.PI*2);
          ctx.fillStyle=`rgba(96,165,250,${.25+.5*b})`; ctx.fill();
        }
      }
      rot += .003;
      requestAnimationFrame(frame);
    }
    frame();
  }
};

/* ── SKILLS TAG INPUT ───────────────────────────────────────── */
const TagInput = {
  init(wrapperId, inputId, maxTags = 20) {
    const wrap = document.getElementById(wrapperId);
    const input = document.getElementById(inputId);
    if (!wrap || !input) return;
    wrap.addEventListener('click', () => input.focus());
    input.addEventListener('keydown', (e) => {
      if (['Enter',','].includes(e.key)) {
        e.preventDefault();
        const val = input.value.trim().replace(/,$/, '');
        if (val) this.addTag(wrap, input, val, maxTags);
        input.value = '';
      }
      if (e.key === 'Backspace' && !input.value) {
        const tags = wrap.querySelectorAll('.skill-tag');
        if (tags.length) tags[tags.length-1].remove();
      }
    });
  },
  addTag(wrap, input, name, maxTags) {
    const existing = wrap.querySelectorAll('.skill-tag');
    if (existing.length >= maxTags) { Toast.warning(`Maximum ${maxTags} skills`); return; }
    for (const t of existing) { if (t.dataset.value === name) return; }
    const tag = document.createElement('span');
    tag.className = 'skill-tag tag tag-active';
    tag.dataset.value = name;
    tag.innerHTML = `${name} <button type="button" onclick="this.parentElement.remove()" style="background:none;border:none;color:var(--em-600);font-size:.9rem;cursor:pointer;margin-left:.1rem;line-height:1">×</button>`;
    wrap.insertBefore(tag, input);
  },
  addTagByName(wrapperId, inputId, name, maxTags = 20) {
    const wrap = document.getElementById(wrapperId);
    const input = document.getElementById(inputId);
    if (wrap && input) this.addTag(wrap, input, name, maxTags);
  }
};

/* ── COPY TO CLIPBOARD ──────────────────────────────────────── */
function copyToClipboard(text, msg = 'Copied!') {
  navigator.clipboard.writeText(text).then(() => Toast.success(msg));
}

/* ── FORMAT UTILITIES ───────────────────────────────────────── */
const Format = {
  currency(n, currency='RWF') {
    if (currency==='RWF') return `RWF ${Number(n).toLocaleString()}`;
    return `$${Number(n).toLocaleString()}`;
  },
  date(iso) {
    return new Date(iso).toLocaleDateString('en-RW',{day:'numeric',month:'short',year:'numeric'});
  },
  timeAgo(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const min=60000,hr=3600000,day=86400000;
    if (diff<min)  return 'Just now';
    if (diff<hr)   return `${Math.floor(diff/min)}m ago`;
    if (diff<day)  return `${Math.floor(diff/hr)}h ago`;
    if (diff<day*7) return `${Math.floor(diff/day)}d ago`;
    return this.date(iso);
  },
  initials(name) {
    return name.split(' ').map(n=>n[0]).slice(0,2).join('').toUpperCase();
  }
};

/* ── INITIALISE ALL ─────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  Navbar.init();
  Reveal.init();
  Counter.init();
  Dropdown.init();
  Tabs.init();
  Search.init();
  Auth.updateNavForUser();
  Toast.init();
});
