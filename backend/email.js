'use strict';
const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || 'smtp.sendgrid.net',
  port: parseInt(process.env.EMAIL_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER || 'apikey',
    pass: process.env.EMAIL_PASS
  }
});

const FROM = `"${process.env.EMAIL_FROM_NAME || 'Ineza Agencies'}" <${process.env.EMAIL_FROM || 'noreply@inezaagencies.rw'}>`;

// Base HTML wrapper
const wrap = (content) => `
<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',Arial,sans-serif;background:#03060D;color:#F0F6FF;line-height:1.6}
.email-wrap{max-width:580px;margin:40px auto;padding:0 20px}
.email-header{background:#070C18;border:1px solid rgba(0,229,153,.2);border-radius:16px 16px 0 0;padding:28px 32px;text-align:center}
.brand{font-size:22px;font-weight:800;letter-spacing:.08em;background:linear-gradient(135deg,#4DFFA6,#00E599);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.tagline{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#334155;margin-top:2px}
.email-body{background:#070C18;border-left:1px solid rgba(148,163,184,.1);border-right:1px solid rgba(148,163,184,.1);padding:32px}
.email-footer{background:#03060D;border:1px solid rgba(148,163,184,.08);border-radius:0 0 16px 16px;padding:20px 32px;text-align:center}
.email-footer p{font-size:12px;color:#334155}
.email-footer a{color:#00E599;text-decoration:none}
h2{font-size:22px;font-weight:800;margin-bottom:12px;color:#F0F6FF}
p{font-size:15px;color:#94A3B8;margin-bottom:16px}
.highlight{color:#F0F6FF;font-weight:600}
.btn-primary{display:inline-block;background:linear-gradient(135deg,#00E599,#00C97D);color:#020f08;font-weight:700;font-size:15px;padding:14px 32px;border-radius:10px;text-decoration:none;margin:20px 0}
.divider{height:1px;background:rgba(148,163,184,.1);margin:24px 0}
.info-box{background:#0C1525;border:1px solid rgba(0,229,153,.15);border-radius:10px;padding:16px 20px;margin:20px 0}
.info-box p{margin-bottom:8px;font-size:14px}
.info-box p:last-child{margin-bottom:0}
.info-row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid rgba(148,163,184,.08)}
.info-row:last-child{border-bottom:none}
.info-label{font-size:13px;color:#64748B}
.info-value{font-size:13px;font-weight:600;color:#F0F6FF}
.green{color:#00E599}
.gold{color:#FBBF24}
.alert{background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.2);border-radius:8px;padding:12px 16px;font-size:13px;color:#F87171}
</style></head>
<body><div class="email-wrap">
<div class="email-header">
  <div class="brand">INEZA</div>
  <div class="tagline">Company Ltd Agencies · Rwanda's #1 Employment Platform</div>
</div>
<div class="email-body">${content}</div>
<div class="email-footer">
  <p>KG 7 Ave, Kacyiru, Kigali, Rwanda · <a href="tel:+250788000000">+250 788 000 000</a><br>
  <a href="mailto:info@inezaagencies.rw">info@inezaagencies.rw</a> · <a href="${process.env.FRONTEND_URL || 'https://inezaagencies.rw'}">inezaagencies.rw</a></p>
  <p style="margin-top:8px">© ${new Date().getFullYear()} Ineza Company Ltd Agencies. All rights reserved.</p>
  <p style="margin-top:8px"><a href="${process.env.FRONTEND_URL}/unsubscribe">Unsubscribe</a> · <a href="${process.env.FRONTEND_URL}/privacy">Privacy Policy</a></p>
</div></div></body></html>
`;

const EmailService = {
  async send(to, subject, html) {
    try {
      const info = await transporter.sendMail({ from: FROM, to, subject, html });
      logger.info(`Email sent: ${subject} → ${to} (${info.messageId})`);
      return info;
    } catch (err) {
      logger.error(`Email send error: ${subject} → ${to}:`, err.message);
      if (process.env.NODE_ENV === 'development') {
        logger.info(`[DEV] Email preview:\nTO: ${to}\nSUBJECT: ${subject}`);
      }
    }
  },

  async sendVerificationEmail(email, firstName, token) {
    const url = `${process.env.FRONTEND_URL}/auth/verify.html?token=${token}`;
    return this.send(email, 'Verify your Ineza account ✅', wrap(`
      <h2>Welcome to Ineza, ${firstName}! 🎉</h2>
      <p>You're one step away from accessing Rwanda's best employment opportunities. Click below to verify your email address.</p>
      <div style="text-align:center"><a href="${url}" class="btn-primary">Verify My Email Address</a></div>
      <div class="divider"></div>
      <p style="font-size:13px">This link expires in 24 hours. If you didn't create an account, you can safely ignore this email.</p>
    `));
  },

  async sendPasswordResetEmail(email, token) {
    const url = `${process.env.FRONTEND_URL}/auth/reset-password.html?token=${token}`;
    return this.send(email, 'Reset your Ineza password 🔐', wrap(`
      <h2>Password Reset Request</h2>
      <p>We received a request to reset your password. Click the button below to create a new password. This link expires in 1 hour.</p>
      <div style="text-align:center"><a href="${url}" class="btn-primary">Reset My Password</a></div>
      <div class="divider"></div>
      <div class="alert">If you didn't request this, please ignore this email. Your password will not change.</div>
    `));
  },

  async sendPaymentConfirmation(email, { amount, currency, description, reference }) {
    return this.send(email, `Payment Confirmed — ${description} 💳`, wrap(`
      <h2>Payment Confirmed ✅</h2>
      <p>Your payment has been processed successfully. Here are your transaction details:</p>
      <div class="info-box">
        <div class="info-row"><span class="info-label">Description</span><span class="info-value">${description}</span></div>
        <div class="info-row"><span class="info-label">Amount</span><span class="info-value green">${currency} ${Number(amount).toLocaleString()}</span></div>
        <div class="info-row"><span class="info-label">Reference</span><span class="info-value">INEZA-${reference}</span></div>
        <div class="info-row"><span class="info-label">Date</span><span class="info-value">${new Date().toLocaleDateString('en-RW', { day:'numeric', month:'long', year:'numeric' })}</span></div>
      </div>
      <p>Your plan is now active. Go to your dashboard to start using your new features.</p>
      <div style="text-align:center"><a href="${process.env.FRONTEND_URL}/candidate/dashboard.html" class="btn-primary">Go to Dashboard →</a></div>
    `));
  },

  async sendApplicationNotification(email, { candidateName, jobTitle, companyName, applicationId }) {
    return this.send(email, `New Application: ${jobTitle} 📋`, wrap(`
      <h2>New Application Received</h2>
      <p><span class="highlight">${candidateName}</span> has applied for your <span class="highlight">${jobTitle}</span> position at ${companyName}.</p>
      <div class="info-box">
        <p>Our Ineza recruiter is currently reviewing this application and will update your pipeline shortly.</p>
      </div>
      <div style="text-align:center">
        <a href="${process.env.FRONTEND_URL}/employer/dashboard.html" class="btn-primary">View Application →</a>
      </div>
    `));
  },

  async sendStatusUpdateToCandidate(email, { firstName, status, jobTitle, company, message }) {
    const statusEmoji = { shortlisted:'🎉', interview_scheduled:'📅', offer_extended:'🏆', hired:'🎊', rejected:'📩' };
    return this.send(email, `Application Update: ${jobTitle} ${statusEmoji[status] || '📬'}`, wrap(`
      <h2>Application Update, ${firstName}</h2>
      <p>${message}</p>
      <div class="info-box">
        <div class="info-row"><span class="info-label">Role</span><span class="info-value">${jobTitle}</span></div>
        <div class="info-row"><span class="info-label">Company</span><span class="info-value">${company}</span></div>
        <div class="info-row"><span class="info-label">Status</span><span class="info-value green">${status.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase())}</span></div>
      </div>
      <div style="text-align:center">
        <a href="${process.env.FRONTEND_URL}/candidate/applications.html" class="btn-primary">View My Applications →</a>
      </div>
      <p style="font-size:13px">Your dedicated Ineza recruiter is supporting you throughout this process. Reply to this email or WhatsApp us at +250 788 000 000.</p>
    `));
  },

  async sendJobAlertEmail(email, firstName, jobs) {
    const jobList = jobs.slice(0, 5).map(j => `
      <div style="background:#0C1525;border:1px solid rgba(148,163,184,.1);border-radius:10px;padding:16px;margin-bottom:12px">
        <div style="font-size:15px;font-weight:700;color:#F0F6FF;margin-bottom:4px">${j.title}</div>
        <div style="font-size:13px;color:#94A3B8;margin-bottom:8px">${j.company_name} · ${j.location}</div>
        <div style="font-size:13px;font-weight:700;color:#00E599">${j.salary_hidden ? 'Competitive' : `RWF ${Number(j.salary_min).toLocaleString()} – ${Number(j.salary_max).toLocaleString()}/mo`}</div>
        <a href="${process.env.FRONTEND_URL}/jobs/board.html?id=${j.id}" style="display:inline-block;margin-top:10px;font-size:13px;color:#00E599;text-decoration:none;font-weight:600">View & Apply →</a>
      </div>
    `).join('');

    return this.send(email, `${jobs.length} New Jobs Match Your Profile — Ineza 🎯`, wrap(`
      <h2>Your Job Matches, ${firstName} 🎯</h2>
      <p>We found <span class="highlight">${jobs.length} new jobs</span> that match your profile. Here are the top picks:</p>
      ${jobList}
      <div style="text-align:center">
        <a href="${process.env.FRONTEND_URL}/jobs/board.html" class="btn-primary">View All ${jobs.length} Matches →</a>
      </div>
    `));
  },

  async sendWelcomeEmail(email, firstName, role) {
    const dashUrl = role === 'employer'
      ? `${process.env.FRONTEND_URL}/employer/dashboard.html`
      : `${process.env.FRONTEND_URL}/candidate/dashboard.html`;

    return this.send(email, `Welcome to Ineza, ${firstName}! Your account is ready 🚀`, wrap(`
      <h2>You're in, ${firstName}! 🎉</h2>
      <p>Welcome to Ineza — Rwanda's most trusted employment platform. Your account is ready and a specialist recruiter will be in touch within 24 hours.</p>
      ${role === 'candidate' ? `
      <div class="info-box">
        <p><strong>Your next steps:</strong></p>
        <p>✅ Complete your profile for better matches</p>
        <p>✅ Upload your CV for instant applications</p>
        <p>✅ Set your job alerts for automatic notifications</p>
      </div>` : `
      <div class="info-box">
        <p><strong>Your next steps:</strong></p>
        <p>✅ Post your first vacancy (reviewed in 2 hours)</p>
        <p>✅ Browse our 15,000+ pre-screened candidates</p>
        <p>✅ Contact your dedicated recruiter</p>
      </div>`}
      <div style="text-align:center">
        <a href="${dashUrl}" class="btn-primary">Go to My Dashboard →</a>
      </div>
      <div class="divider"></div>
      <p style="font-size:13px">Questions? WhatsApp us at <a href="https://wa.me/250788000000" style="color:#00E599">+250 788 000 000</a> or email <a href="mailto:info@inezaagencies.rw" style="color:#00E599">info@inezaagencies.rw</a></p>
    `));
  }
};

module.exports = EmailService;
