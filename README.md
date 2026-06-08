# INEZA COMPANY LTD AGENCIES — FULL PLATFORM
## Rwanda's #1 Employment Platform | Complete Web Application

---

## 📁 PROJECT STRUCTURE

```
ineza-platform/
│
├── index.html                    ← Homepage / Landing Page
├── contact.html                  ← Contact page with map, team, FAQ
│
├── css/
│   ├── variables.css             ← Complete design token system
│   └── base.css                  ← Global styles, components, utilities
│
├── js/
│   └── app.js                    ← Shared JS: auth, payments, toasts, globe, forms
│
├── auth/
│   ├── signin.html               ← Sign In page (social + email)
│   └── signup.html               ← Multi-step registration (5 steps)
│
├── jobs/
│   └── board.html                ← Full job board with filters, search, modal
│
├── candidate/
│   └── dashboard.html            ← Candidate dashboard (applications, matches, alerts)
│
├── employer/
│   ├── dashboard.html            ← Employer dashboard (pipeline, analytics, jobs)
│   └── post-job.html             ← Post a job (full form with payment)
│
└── assets/                       ← (Add your images, logos, icons here)
```

---

## 🎨 DESIGN SYSTEM

### Color Palette
| Token | Hex | Use |
|-------|-----|-----|
| `--em-400` | `#00E599` | Primary — Emerald Green (Rwanda hills) |
| `--bl-500` | `#3B82F6` | Secondary — Electric Blue (trust, tech) |
| `--gd-400` | `#FBBF24` | Accent — Warm Gold (premium, employer) |
| `--bg-deep` | `#03060D` | Deepest background |
| `--bg-surface` | `#0C1525` | Cards and panels |
| `--tx-100` | `#F0F6FF` | Primary text |

### Typography
- **Display / Headings**: Playfair Display (Google Fonts)
- **Body / UI**: Inter (Google Fonts)
- Loaded via `<link>` in each HTML file — no build step needed

### Key CSS Classes
```css
/* Text gradients */
.text-em        /* Emerald gradient text */
.text-gd        /* Gold gradient text */
.text-hero      /* Full hero gradient */

/* Buttons */
.btn.btn-primary    /* Emerald CTA */
.btn.btn-secondary  /* Outlined secondary */
.btn.btn-gold       /* Gold employer CTA */
.btn.btn-sm/lg/xl   /* Size modifiers */
.btn.btn-block      /* Full width */
.btn.loading        /* Loading spinner state */

/* Cards */
.card               /* Base card with hover glow */
.card-glass         /* Glassmorphism card */

/* Forms */
.form-group         /* Wrapper with label/hint/error */
.form-control       /* Input, select, textarea */
.form-row           /* 2-column form grid */

/* Badges */
.badge.badge-em/bl/gd/gray    /* Color variants */

/* Animations */
.reveal             /* Scroll-triggered fade-in */
.reveal.d1-d6       /* Stagger delays */
```

---

## ⚡ JAVASCRIPT MODULES (js/app.js)

All modules are globally available:

```javascript
// Toast notifications
Toast.success('Message here');
Toast.error('Something went wrong');
Toast.info('Information');
Toast.warning('Be careful');

// Modal control
Modal.open('modal-id');
Modal.close('modal-id');

// Auth state
Auth.getUser()          // Returns user object or null
Auth.setUser(obj)       // Save user to localStorage
Auth.logout()           // Clear and redirect
Auth.requireAuth('candidate')   // Guard pages by role

// Payment simulation
Payment.showCheckout('candidate_pro');
await Payment.processPayment('planId', data);
// Plans: candidate_free, candidate_pro, candidate_premium
//        employer_starter, employer_business, employer_enterprise

// Format utilities
Format.currency(amount, 'RWF');
Format.date('2025-01-01');
Format.timeAgo('2025-01-01');
Format.initials('Jean-Paul Habimana');  // → 'JH'

// Skills tag input
TagInput.init('wrap-id', 'input-id');

// Globe animation (Canvas)
Globe.init('canvas-id');

// Counter animations (data-counter attribute)
// <span data-counter data-target="4200" data-suffix="+">
Counter.init();

// Scroll reveal (.reveal class)
Reveal.init();

// Dropdown menus (.dropdown + data-dropdown)
Dropdown.init();

// Form validation
FormValidator.validate(formElement);
// Use data-validate="required|email" on inputs
```

---

## 💳 PAYMENT SYSTEM

The platform supports 4 payment methods (simulated — ready for real gateway integration):

| Method | Notes |
|--------|-------|
| MTN MoMo | Primary mobile money — most popular |
| Airtel Money | Secondary mobile money |
| Visa/Mastercard | Card payments |
| Bank Transfer | Direct deposit |

### Pricing Plans
**Candidates:**
- Free — RWF 0 (5 applications/month)
- Pro Seeker — RWF 5,000/month
- Premium — RWF 9,900/month

**Employers:**
- Starter — RWF 49,000/month (3 jobs)
- Business — RWF 120,000/month (15 jobs + recruiter)
- Enterprise — RWF 290,000/month (unlimited)

**Job Posting Upgrades:**
- Featured Post — +RWF 15,000
- Urgent + Featured — +RWF 28,000

### Connecting a Real Payment Gateway
Replace the `Payment.processPayment()` method in `js/app.js` with your real gateway:

```javascript
// Example: MTN MoMo API integration
async processPayment(planId, paymentData) {
  const response = await fetch('https://sandbox.momodeveloper.mtn.com/collection/v1_0/requesttopay', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + YOUR_TOKEN,
      'X-Reference-Id': uuid(),
      'X-Target-Environment': 'sandbox',
      'Ocp-Apim-Subscription-Key': YOUR_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      amount: this.plans[planId].price.toString(),
      currency: 'RWF',
      externalId: 'INA-' + Date.now(),
      payer: { partyIdType: 'MSISDN', partyId: paymentData.phone },
      payerMessage: 'Ineza Platform - ' + this.plans[planId].name,
      payeeNote: 'Subscription payment'
    })
  });
  // ... handle response
}
```

---

## 🔐 AUTHENTICATION

Currently uses `localStorage` for demo purposes. For production, replace with:

1. **JWT tokens** — Store access token, use refresh token pattern
2. **Backend API** — Node.js/Express or Django REST Framework
3. **OAuth** — Google and LinkedIn buttons are wired up (add client IDs)

```javascript
// Current (demo) — localStorage
Auth.setUser({ name:'Jean-Paul', email:'jp@email.com', role:'candidate', plan:'pro' });

// Production — replace with
const response = await fetch('/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password })
});
const { token, user } = await response.json();
localStorage.setItem('ineza_token', token);
```

---

## 🌐 DEPLOYMENT

### Option 1: Static Hosting (Netlify / Vercel — Recommended)
```bash
# Drag and drop the entire ineza-platform/ folder to:
# netlify.com/drop   OR   vercel.com/new
```

### Option 2: GitHub Pages
```bash
git init
git add .
git commit -m "Initial platform deploy"
git remote add origin https://github.com/YOUR_USER/ineza-platform
git push -u origin main
# Enable GitHub Pages in repository Settings → Pages → Deploy from main
```

### Option 3: cPanel / Shared Hosting (most Rwandan hosts)
```
Upload the entire ineza-platform/ folder to public_html/
Point your domain to public_html/index.html
```

### Option 4: Self-Hosted (Ubuntu VPS)
```bash
sudo apt install nginx
sudo cp -r ineza-platform /var/www/ineza
sudo nano /etc/nginx/sites-available/ineza
# Add: root /var/www/ineza; index index.html; location / { try_files $uri $uri/ =404; }
sudo systemctl reload nginx
```

### Custom Domain
```
Domain: www.inezaagencies.rw
CNAME Record: → your-netlify-app.netlify.app
SSL: Netlify provides free Let's Encrypt SSL automatically
```

---

## 📈 REVENUE STREAMS BUILT INTO THE PLATFORM

| Stream | Model | Est. Monthly Revenue |
|--------|-------|---------------------|
| Candidate Pro subscriptions | RWF 5,000/mo per user | Scales with users |
| Candidate Premium subscriptions | RWF 9,900/mo per user | High-margin |
| Employer Starter plans | RWF 49,000/mo | Easy entry |
| Employer Business plans | RWF 120,000/mo | Core revenue |
| Employer Enterprise plans | RWF 290,000/mo | Anchor clients |
| Featured job postings | RWF 15,000/post | High frequency |
| Urgent + Featured posts | RWF 28,000/post | Urgency premium |
| Placement commissions | 15–22% of first-year salary | Major revenue |
| Executive search retainers | Negotiated | High-ticket |

**Example: 100 Pro candidates + 10 Business employers + 20 featured posts/mo**
= RWF 500,000 + RWF 1,200,000 + RWF 300,000
= **RWF 2,000,000/month from subscriptions alone**
Plus placement commissions which at even 5 placements/month at avg RWF 600K salary
= 18% × RWF 600K × 5 = **RWF 540,000 additional per month**

---

## 🛠️ NEXT STEPS FOR FULL PRODUCTION

### Backend (Required for live launch)
- [ ] REST API (Node.js/Express or Python/Django)
- [ ] PostgreSQL database (jobs, users, applications, payments)
- [ ] JWT authentication with refresh tokens
- [ ] File upload service (AWS S3 or Cloudinary for CVs/photos)
- [ ] Email service (SendGrid or Mailchimp for alerts)
- [ ] SMS/WhatsApp integration (Twilio or Africa's Talking)
- [ ] Real MTN MoMo + Airtel Money API integration
- [ ] Stripe for card payments (international)

### Features to Add
- [ ] Admin dashboard (approve jobs, manage users, view revenue)
- [ ] Real-time messaging (Socket.io or Pusher)
- [ ] Video interview scheduling (Calendly integration)
- [ ] AI-powered job matching (skills vector matching)
- [ ] Mobile app (React Native — reuse all API logic)
- [ ] Employer analytics (time-to-fill, source tracking)
- [ ] Salary comparison tool (public benchmark data)
- [ ] Blog / career advice section (SEO traffic)

### SEO Quick Wins
- Add `sitemap.xml` and `robots.txt`
- Submit to Google Search Console
- Register on Google My Business (Kigali office)
- Add structured data (JobPosting schema for Google Jobs)
- Target keywords: "jobs in Rwanda", "employment agencies Kigali", "IT jobs Rwanda"

---

## 📞 SUPPORT & CUSTOMISATION

This platform was built by Ineza Company Ltd Agencies.

For customisation, backend development, or deployment support:
- **Email**: info@inezaagencies.rw
- **Phone**: +250 788 000 000
- **WhatsApp**: +250 788 000 000
- **Office**: KG 7 Ave, Kacyiru, Kigali, Rwanda

---

*Built with pure HTML, CSS and Vanilla JavaScript — no framework dependencies. Loads fast everywhere, works on any device, deployable in 5 minutes.*
