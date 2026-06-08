'use strict';
const jwt    = require('jsonwebtoken');
const { query } = require('../models/db');
const logger = require('../utils/logger');

// Verify access token
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.split(' ')[1]
      : req.cookies?.access_token;

    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
      }
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Check user still exists and is active
    const { rows } = await query(
      'SELECT id, email, role, status, plan FROM users WHERE id = $1 AND deleted_at IS NULL',
      [decoded.id]
    );

    if (!rows[0]) {
      return res.status(401).json({ error: 'User not found or deleted' });
    }
    if (rows[0].status === 'suspended') {
      return res.status(403).json({ error: 'Account suspended. Contact support.' });
    }

    req.user = rows[0];
    next();
  } catch (err) {
    logger.error('Auth middleware error:', err);
    res.status(500).json({ error: 'Authentication error' });
  }
};

// Optional auth — doesn't fail if no token
const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.split(' ')[1]
    : req.cookies?.access_token;

  if (!token) return next();

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await query(
      'SELECT id, email, role, status, plan FROM users WHERE id = $1 AND deleted_at IS NULL',
      [decoded.id]
    );
    if (rows[0]) req.user = rows[0];
  } catch (_) {}
  next();
};

// Role-based access
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({
      error: `Access restricted to: ${roles.join(', ')}`
    });
  }
  next();
};

// Plan-based access
const requirePlan = (...plans) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!plans.includes(req.user.plan)) {
    return res.status(403).json({
      error: 'This feature requires a paid plan',
      code: 'PLAN_REQUIRED',
      required: plans,
      current: req.user.plan
    });
  }
  next();
};

// Generate token pair
const generateTokens = (user) => {
  const payload = {
    id:    user.id,
    email: user.email,
    role:  user.role,
    plan:  user.plan
  };

  const accessToken = jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '15m'
  });

  const refreshToken = jwt.sign(
    { id: user.id },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' }
  );

  return { accessToken, refreshToken };
};

// Set secure cookie
const setTokenCookies = (res, accessToken, refreshToken) => {
  res.cookie('access_token', accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 15 * 60 * 1000 // 15 minutes
  });
  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    path: '/api/v1/auth/refresh'
  });
};

module.exports = {
  authenticate,
  optionalAuth,
  requireRole,
  requirePlan,
  generateTokens,
  setTokenCookies
};
