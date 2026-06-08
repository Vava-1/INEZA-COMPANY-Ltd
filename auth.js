'use strict';
const router   = require('express').Router();
const bcrypt   = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');

const { query, withTransaction } = require('../models/db');
const { generateTokens, setTokenCookies, authenticate } = require('../middleware/auth');
const emailService = require('../services/email');
const logger = require('../utils/logger');

// ── Validation rules ─────────────────────────────────────────
const signupValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be 8+ characters')
    .matches(/^(?=.*[A-Za-z])(?=.*\d)/).withMessage('Password must contain letters and numbers'),
  body('role').isIn(['candidate','employer']).withMessage('Role must be candidate or employer'),
  body('first_name').trim().isLength({ min:2, max:100 }).withMessage('First name required'),
  body('last_name').trim().isLength({ min:2, max:100 }).withMessage('Last name required'),
];

const signinValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').notEmpty().withMessage('Password required'),
];

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  next();
};

// ── POST /signup ──────────────────────────────────────────────
router.post('/signup', signupValidation, validate, async (req, res) => {
  const { email, password, role, first_name, last_name, phone, company_name, plan } = req.body;

  await withTransaction(async (client) => {
    // Check existing user
    const existing = await client.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );
    if (existing.rows[0]) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const verificationToken = uuidv4();
    const selectedPlan = plan || (role === 'candidate' ? 'candidate_free' : 'employer_starter');

    // Create user
    const { rows: [user] } = await client.query(`
      INSERT INTO users (email, password_hash, role, status, plan, email_verification_token)
      VALUES ($1, $2, $3, 'pending_verification', $4, $5)
      RETURNING id, email, role, plan, status
    `, [email, passwordHash, role, selectedPlan, verificationToken]);

    // Create profile
    if (role === 'candidate') {
      await client.query(`
        INSERT INTO candidate_profiles (user_id, first_name, last_name, phone)
        VALUES ($1, $2, $3, $4)
      `, [user.id, first_name, last_name, phone || null]);
    } else {
      const slug = (company_name || `company-${user.id}`)
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      await client.query(`
        INSERT INTO employer_profiles (user_id, company_name, company_slug, contact_name)
        VALUES ($1, $2, $3, $4)
      `, [user.id, company_name || `${first_name} ${last_name}'s Company`, slug, `${first_name} ${last_name}`]);
    }

    // Send verification email (non-blocking)
    emailService.sendVerificationEmail(email, first_name, verificationToken).catch(logger.error);

    const { accessToken, refreshToken } = generateTokens(user);

    // Store refresh token hash
    const { createHash } = require('crypto');
    const refreshHash = createHash('sha256').update(refreshToken).digest('hex');
    await client.query(
      'UPDATE users SET refresh_token_hash = $1, last_login_at = NOW(), login_count = login_count + 1 WHERE id = $2',
      [refreshHash, user.id]
    );

    setTokenCookies(res, accessToken, refreshToken);
    res.status(201).json({
      message: 'Account created successfully. Please verify your email.',
      user: { id: user.id, email: user.email, role: user.role, plan: user.plan, status: user.status },
      accessToken,
      refreshToken
    });
  });
});

// ── POST /signin ──────────────────────────────────────────────
router.post('/signin', signinValidation, validate, async (req, res) => {
  const { email, password, remember_me } = req.body;

  const { rows } = await query(
    `SELECT u.id, u.email, u.password_hash, u.role, u.status, u.plan,
            u.email_verified_at,
            cp.first_name, cp.last_name,
            ep.company_name
     FROM users u
     LEFT JOIN candidate_profiles cp ON u.id = cp.user_id
     LEFT JOIN employer_profiles ep ON u.id = ep.user_id
     WHERE u.email = $1 AND u.deleted_at IS NULL`,
    [email]
  );

  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash || ''))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  if (user.status === 'suspended') {
    return res.status(403).json({ error: 'Account suspended. Contact support@inezaagencies.rw' });
  }

  const { accessToken, refreshToken } = generateTokens(user);

  const { createHash } = require('crypto');
  const refreshHash = createHash('sha256').update(refreshToken).digest('hex');

  await query(
    'UPDATE users SET refresh_token_hash=$1, last_login_at=NOW(), login_count=login_count+1, status=CASE WHEN status=\'pending_verification\' THEN status ELSE \'active\' END WHERE id=$2',
    [refreshHash, user.id]
  );

  setTokenCookies(res, accessToken, refreshToken);

  const name = user.first_name
    ? `${user.first_name} ${user.last_name}`
    : user.company_name || 'User';

  res.json({
    message: 'Signed in successfully',
    user: {
      id: user.id, email: user.email, role: user.role,
      plan: user.plan, status: user.status, name,
      emailVerified: !!user.email_verified_at
    },
    accessToken,
    refreshToken
  });
});

// ── POST /refresh ─────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  const token = req.cookies?.refresh_token || req.body.refresh_token;
  if (!token) return res.status(401).json({ error: 'Refresh token required' });

  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);

    const { createHash } = require('crypto');
    const tokenHash = createHash('sha256').update(token).digest('hex');

    const { rows } = await query(
      'SELECT id, email, role, plan, status, refresh_token_hash FROM users WHERE id = $1',
      [decoded.id]
    );

    const user = rows[0];
    if (!user || user.refresh_token_hash !== tokenHash) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    const { accessToken, refreshToken: newRefresh } = generateTokens(user);
    const newHash = createHash('sha256').update(newRefresh).digest('hex');
    await query('UPDATE users SET refresh_token_hash=$1 WHERE id=$2', [newHash, user.id]);

    setTokenCookies(res, accessToken, newRefresh);
    res.json({ accessToken, refreshToken: newRefresh });
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

// ── GET /me ───────────────────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  const { id, role } = req.user;
  let profile = null;

  if (role === 'candidate') {
    const { rows } = await query(
      `SELECT cp.*, array_agg(DISTINCT cs.skill_name) FILTER (WHERE cs.skill_name IS NOT NULL) AS skills
       FROM candidate_profiles cp
       LEFT JOIN candidate_skills cs ON cp.id = cs.candidate_id
       WHERE cp.user_id = $1 GROUP BY cp.id`,
      [id]
    );
    profile = rows[0];
  } else if (role === 'employer') {
    const { rows } = await query(
      'SELECT * FROM employer_profiles WHERE user_id = $1',
      [id]
    );
    profile = rows[0];
  }

  res.json({ user: req.user, profile });
});

// ── POST /signout ─────────────────────────────────────────────
router.post('/signout', authenticate, async (req, res) => {
  await query('UPDATE users SET refresh_token_hash=NULL WHERE id=$1', [req.user.id]);
  res.clearCookie('access_token');
  res.clearCookie('refresh_token');
  res.json({ message: 'Signed out successfully' });
});

// ── GET /verify-email/:token ──────────────────────────────────
router.get('/verify-email/:token', async (req, res) => {
  const { token } = req.params;
  const { rows } = await query(
    `UPDATE users SET email_verified_at=NOW(), status='active', email_verification_token=NULL
     WHERE email_verification_token=$1 AND email_verified_at IS NULL
     RETURNING id, email`,
    [token]
  );
  if (!rows[0]) {
    return res.status(400).json({ error: 'Invalid or already used verification token' });
  }
  res.json({ message: 'Email verified successfully. You can now sign in.' });
});

// ── POST /forgot-password ─────────────────────────────────────
router.post('/forgot-password',
  body('email').isEmail().normalizeEmail(),
  validate,
  async (req, res) => {
    const { email } = req.body;
    const resetToken = uuidv4();
    const expires = new Date(Date.now() + 3600000); // 1 hour

    const { rows } = await query(
      `UPDATE users SET password_reset_token=$1, password_reset_expires=$2
       WHERE email=$3 AND deleted_at IS NULL RETURNING first_name`,
      [resetToken, expires, email]
    );

    // Always return 200 (don't reveal if email exists)
    if (rows[0]) {
      emailService.sendPasswordResetEmail(email, resetToken).catch(logger.error);
    }

    res.json({ message: 'If an account exists with that email, a reset link has been sent.' });
  }
);

// ── POST /reset-password ──────────────────────────────────────
router.post('/reset-password',
  body('token').notEmpty(),
  body('password').isLength({ min: 8 }).matches(/^(?=.*[A-Za-z])(?=.*\d)/),
  validate,
  async (req, res) => {
    const { token, password } = req.body;
    const hash = await bcrypt.hash(password, 12);

    const { rows } = await query(
      `UPDATE users SET password_hash=$1, password_reset_token=NULL, password_reset_expires=NULL,
              refresh_token_hash=NULL
       WHERE password_reset_token=$2 AND password_reset_expires > NOW()
       RETURNING id, email`,
      [hash, token]
    );

    if (!rows[0]) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    res.json({ message: 'Password updated successfully. Please sign in.' });
  }
);

// ── POST /change-password ─────────────────────────────────────
router.post('/change-password', authenticate,
  body('current_password').notEmpty(),
  body('new_password').isLength({ min: 8 }).matches(/^(?=.*[A-Za-z])(?=.*\d)/),
  validate,
  async (req, res) => {
    const { current_password, new_password } = req.body;
    const { rows } = await query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);

    if (!(await bcrypt.compare(current_password, rows[0].password_hash))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(new_password, 12);
    await query(
      'UPDATE users SET password_hash=$1, refresh_token_hash=NULL WHERE id=$2',
      [hash, req.user.id]
    );

    res.json({ message: 'Password changed successfully. Please sign in again.' });
  }
);

module.exports = router;
