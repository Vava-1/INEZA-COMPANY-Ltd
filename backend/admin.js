'use strict';
const router = require('express').Router();
const { query, withTransaction } = require('../models/db');
const { authenticate, requireRole } = require('../middleware/auth');
const emailService = require('../services/email');
const logger = require('../utils/logger');

// All admin routes require admin role
router.use(authenticate, requireRole('admin'));

// ── GET /admin/stats ──────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [users, jobs, apps, revenue, topPlans] = await Promise.all([
      query(`SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE role='candidate') AS candidates,
               COUNT(*) FILTER (WHERE role='employer') AS employers,
               COUNT(*) FILTER (WHERE status='active') AS active,
               COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '7 days') AS new_this_week,
               COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '30 days') AS new_this_month
             FROM users WHERE deleted_at IS NULL`),
      query(`SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE status='active') AS active,
               COUNT(*) FILTER (WHERE status='pending_review') AS pending,
               COUNT(*) FILTER (WHERE status='closed') AS closed,
               COUNT(*) FILTER (WHERE featured=true) AS featured
             FROM jobs WHERE deleted_at IS NULL`),
      query(`SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE status='hired') AS placements,
               COALESCE(SUM(placement_fee) FILTER (WHERE status='hired'),0) AS total_fees
             FROM applications`),
      query(`SELECT
               COALESCE(SUM(amount) FILTER (WHERE currency='RWF' AND status='completed'),0) AS rwf_month,
               COALESCE(SUM(amount) FILTER (WHERE currency='USD' AND status='completed'),0) AS usd_month,
               COUNT(*) FILTER (WHERE status='completed') AS completed_count,
               COUNT(*) FILTER (WHERE status='failed') AS failed_count
             FROM payments WHERE created_at >= date_trunc('month', NOW())`),
      query(`SELECT plan, COUNT(*) AS count FROM users WHERE plan != 'candidate_free' AND deleted_at IS NULL GROUP BY plan ORDER BY count DESC`)
    ]);
    res.json({
      users:     users.rows[0],
      jobs:      jobs.rows[0],
      applications: apps.rows[0],
      revenue:   revenue.rows[0],
      top_plans: topPlans.rows
    });
  } catch (err) {
    logger.error('Admin stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ── GET /admin/users ──────────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const { role, status, plan, q, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page)-1) * parseInt(limit);
    let where = 'u.deleted_at IS NULL';
    const params = [];
    let idx = 1;
    if (role)   { where += ` AND u.role=$${idx++}`;   params.push(role); }
    if (status) { where += ` AND u.status=$${idx++}`; params.push(status); }
    if (plan)   { where += ` AND u.plan=$${idx++}`;   params.push(plan); }
    if (q) {
      where += ` AND (u.email ILIKE $${idx} OR COALESCE(cp.first_name,'') ILIKE $${idx} OR COALESCE(ep.company_name,'') ILIKE $${idx})`;
      params.push(`%${q}%`); idx++;
    }
    const { rows } = await query(`
      SELECT u.id, u.email, u.role, u.status, u.plan, u.created_at, u.last_login_at, u.login_count,
        COALESCE(cp.first_name||' '||cp.last_name, ep.company_name) AS name,
        cp.profile_score, cp.cv_url IS NOT NULL AS has_cv
      FROM users u
      LEFT JOIN candidate_profiles cp ON cp.user_id=u.id
      LEFT JOIN employer_profiles ep ON ep.user_id=u.id
      WHERE ${where}
      ORDER BY u.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, [...params, parseInt(limit), offset]);
    const { rows: [{ count }] } = await query(
      `SELECT COUNT(*) FROM users u LEFT JOIN candidate_profiles cp ON cp.user_id=u.id LEFT JOIN employer_profiles ep ON ep.user_id=u.id WHERE ${where}`,
      params
    );
    res.json({ users: rows, total: parseInt(count) });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch users' }); }
});

// ── GET /admin/users/:id — User detail ───────────────────────
router.get('/users/:id', async (req, res) => {
  try {
    const { rows: [user] } = await query(`
      SELECT u.*, COALESCE(cp.first_name||' '||cp.last_name, ep.company_name) AS name,
        cp.*, ep.company_name, ep.is_verified AS company_verified
      FROM users u
      LEFT JOIN candidate_profiles cp ON cp.user_id=u.id
      LEFT JOIN employer_profiles ep ON ep.user_id=u.id
      WHERE u.id=$1`, [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const [apps, payments] = await Promise.all([
      user.role === 'candidate' ? query(`
        SELECT a.id, a.status, j.title, ep.company_name FROM applications a
        JOIN jobs j ON a.job_id=j.id JOIN employer_profiles ep ON j.employer_id=ep.id
        JOIN candidate_profiles cp ON a.candidate_id=cp.id WHERE cp.user_id=$1 ORDER BY a.created_at DESC LIMIT 10`, [user.id]) : { rows: [] },
      query(`SELECT id, payment_type, amount, currency, status, method, created_at FROM payments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 10`, [user.id])
    ]);

    res.json({ user, applications: apps.rows, payments: payments.rows });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch user' }); }
});

// ── PATCH /admin/users/:id — Update user ─────────────────────
router.patch('/users/:id', async (req, res) => {
  try {
    const { status, plan, role } = req.body;
    const updates = []; const params = []; let idx = 1;
    if (status) { updates.push(`status=$${idx++}`); params.push(status); }
    if (plan)   { updates.push(`plan=$${idx++}`);   params.push(plan);
      // Also update plan_expires_at if upgrading
      if (!['candidate_free'].includes(plan)) {
        const exp = new Date(); exp.setDate(exp.getDate() + 30);
        updates.push(`plan_expires_at=$${idx++}`); params.push(exp);
      }
    }
    if (role)   { updates.push(`role=$${idx++}`);   params.push(role); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.id);
    await query(`UPDATE users SET ${updates.join(',')} WHERE id=$${idx}`, params);

    // Audit log
    await query('INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_data, ip_address) VALUES ($1,$2,$3,$4,$5,$6)',
      [req.user.id, 'admin_update_user', 'users', req.params.id, JSON.stringify(req.body), req.ip]);

    res.json({ message: 'User updated successfully' });
  } catch (err) { res.status(500).json({ error: 'Failed to update user' }); }
});

// ── DELETE /admin/users/:id — Soft delete ────────────────────
router.delete('/users/:id', async (req, res) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete your own admin account' });
    await query(`UPDATE users SET deleted_at=NOW(), status='inactive', refresh_token_hash=NULL WHERE id=$1`, [req.params.id]);
    res.json({ message: 'User account deactivated' });
  } catch (err) { res.status(500).json({ error: 'Failed to delete user' }); }
});

// ── GET /admin/jobs/pending ───────────────────────────────────
router.get('/jobs/pending', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT j.id, j.title, j.industry, j.location, j.job_type, j.salary_min, j.salary_max,
        j.featured, j.urgent, j.created_at, j.description,
        ep.company_name, ep.is_verified AS company_verified, ep.logo_url AS company_logo,
        u.email AS employer_email
      FROM jobs j
      JOIN employer_profiles ep ON j.employer_id=ep.id
      JOIN users u ON ep.user_id=u.id
      WHERE j.status='pending_review'
      ORDER BY j.created_at ASC
    `);
    res.json({ jobs: rows, count: rows.length });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch pending jobs' }); }
});

// ── PATCH /admin/jobs/:id/approve ────────────────────────────
router.patch('/jobs/:id/approve', async (req, res) => {
  try {
    const { featured = false, urgent = false } = req.body;
    const { rows: [job] } = await query(`
      UPDATE jobs SET status='active', published_at=NOW(), featured=$1, urgent=$2
      WHERE id=$3 RETURNING title, employer_id
    `, [featured, urgent, req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    // Notify employer
    const { rows: [ep] } = await query('SELECT ep.*, u.email FROM employer_profiles ep JOIN users u ON ep.user_id=u.id WHERE ep.id=$1', [job.employer_id]);
    if (ep) emailService.send(ep.email, `Your job "${job.title}" is now live on Ineza! 🚀`,
      `<p>Your job posting <strong>${job.title}</strong> has been approved and is now live on the Ineza platform. Candidates can now apply!</p>
       <p><a href="${process.env.FRONTEND_URL}/jobs/board.html">View on platform →</a></p>`
    ).catch(logger.error);

    await query('INSERT INTO audit_logs (user_id,action,entity_type,entity_id) VALUES ($1,$2,$3,$4)',
      [req.user.id, 'approve_job', 'jobs', req.params.id]);

    res.json({ message: `Job "${job.title}" approved and published` });
  } catch (err) { res.status(500).json({ error: 'Failed to approve job' }); }
});

// ── PATCH /admin/jobs/:id/reject ─────────────────────────────
router.patch('/jobs/:id/reject', async (req, res) => {
  try {
    const { reason } = req.body;
    const { rows: [job] } = await query(`
      UPDATE jobs SET status='draft' WHERE id=$1 RETURNING title, employer_id
    `, [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const { rows: [ep] } = await query('SELECT u.email FROM employer_profiles ep JOIN users u ON ep.user_id=u.id WHERE ep.id=$1', [job.employer_id]);
    if (ep && reason) {
      emailService.send(ep.email, `Action required: Your job "${job.title}" needs edits`, `<p>Your job posting requires the following changes before it can be approved:</p><p><strong>${reason}</strong></p><p>Please update your posting and resubmit.</p>`).catch(logger.error);
    }

    res.json({ message: 'Job rejected and returned to employer' });
  } catch (err) { res.status(500).json({ error: 'Failed to reject job' }); }
});

// ── GET /admin/revenue ────────────────────────────────────────
router.get('/revenue', async (req, res) => {
  try {
    const { rows: monthly } = await query('SELECT * FROM v_monthly_revenue LIMIT 12');
    const { rows: byMethod } = await query(`
      SELECT method, COUNT(*) AS count, COALESCE(SUM(amount),0) AS total
      FROM payments WHERE status='completed' GROUP BY method ORDER BY total DESC
    `);
    const { rows: byPlan } = await query(`
      SELECT plan, COUNT(*) AS subscribers FROM subscriptions WHERE status='active' GROUP BY plan
    `);
    res.json({ monthly, by_method: byMethod, by_plan: byPlan });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch revenue' }); }
});

// ── POST /admin/broadcast — Send email to all users ──────────
router.post('/broadcast', async (req, res) => {
  try {
    const { role, subject, body, plan } = req.body;
    if (!subject || !body) return res.status(400).json({ error: 'subject and body required' });

    let where = 'status=\'active\'';
    if (role) where += ` AND role='${role}'`;
    if (plan) where += ` AND plan='${plan}'`;

    const { rows: users } = await query(`SELECT email FROM users WHERE ${where} AND deleted_at IS NULL LIMIT 1000`);

    let sent = 0;
    for (const user of users) {
      try {
        await emailService.send(user.email, subject, `<div style="font-family:Arial,sans-serif;color:#333">${body}</div>`);
        sent++;
      } catch {}
    }

    await query('INSERT INTO audit_logs (user_id,action,entity_type,new_data) VALUES ($1,$2,$3,$4)',
      [req.user.id, 'broadcast_email', 'system', JSON.stringify({ subject, role, plan, recipients: sent })]);

    res.json({ message: `Broadcast sent to ${sent} users`, sent });
  } catch (err) { res.status(500).json({ error: 'Failed to send broadcast' }); }
});

// ── GET /admin/audit-logs ─────────────────────────────────────
router.get('/audit-logs', async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page)-1)*parseInt(limit);
    const { rows } = await query(`
      SELECT al.*, COALESCE(cp.first_name||' '||cp.last_name, ep.company_name, u.email) AS user_name, u.role AS user_role
      FROM audit_logs al LEFT JOIN users u ON al.user_id=u.id
      LEFT JOIN candidate_profiles cp ON cp.user_id=u.id
      LEFT JOIN employer_profiles ep ON ep.user_id=u.id
      ORDER BY al.created_at DESC LIMIT $1 OFFSET $2
    `, [parseInt(limit), offset]);
    res.json({ logs: rows });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch audit logs' }); }
});

// ── GET /admin/payments — All payments ───────────────────────
router.get('/payments', async (req, res) => {
  try {
    const { status, method, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page)-1)*parseInt(limit);
    let where = '1=1'; const params = []; let idx = 1;
    if (status) { where += ` AND p.status=$${idx++}`; params.push(status); }
    if (method) { where += ` AND p.method=$${idx++}`; params.push(method); }
    const { rows } = await query(`
      SELECT p.*, u.email AS user_email, COALESCE(cp.first_name||' '||cp.last_name, ep.company_name) AS user_name
      FROM payments p JOIN users u ON p.user_id=u.id
      LEFT JOIN candidate_profiles cp ON cp.user_id=u.id
      LEFT JOIN employer_profiles ep ON ep.user_id=u.id
      WHERE ${where} ORDER BY p.created_at DESC LIMIT $${idx++} OFFSET $${idx++}
    `, [...params, parseInt(limit), offset]);
    res.json({ payments: rows });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch payments' }); }
});

// ── POST /admin/payments/:id/refund ───────────────────────────
router.post('/payments/:id/refund', async (req, res) => {
  try {
    const { reason } = req.body;
    const { rows: [p] } = await query('SELECT * FROM payments WHERE id=$1', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Payment not found' });
    if (p.status !== 'completed') return res.status(400).json({ error: 'Only completed payments can be refunded' });

    await withTransaction(async (client) => {
      await client.query(`UPDATE payments SET status='refunded', refunded_at=NOW(), refund_reason=$1 WHERE id=$2`, [reason, req.params.id]);
      // Downgrade plan if subscription refund
      if (p.payment_type === 'subscription') {
        const defaultPlan = p.user_id ? (await client.query('SELECT role FROM users WHERE id=$1', [p.user_id])).rows[0]?.role === 'employer' ? 'employer_starter' : 'candidate_free' : 'candidate_free';
        await client.query('UPDATE users SET plan=$1 WHERE id=$2', [defaultPlan, p.user_id]);
      }
    });

    await query('INSERT INTO audit_logs (user_id,action,entity_type,entity_id,new_data) VALUES ($1,$2,$3,$4,$5)',
      [req.user.id, 'refund_payment', 'payments', req.params.id, JSON.stringify({ reason, amount: p.amount })]);

    res.json({ message: `Refund of ${p.currency} ${p.amount.toLocaleString()} processed` });
  } catch (err) { res.status(500).json({ error: 'Failed to process refund' }); }
});

// ── GET /admin/verifications — Employer verification queue ────
router.get('/verifications', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT ep.*, u.email, u.created_at AS account_created,
        COUNT(j.id) AS total_jobs
      FROM employer_profiles ep
      JOIN users u ON ep.user_id=u.id
      LEFT JOIN jobs j ON j.employer_id=ep.id
      WHERE ep.is_verified=false
      GROUP BY ep.id, u.email, u.created_at
      ORDER BY ep.created_at ASC
    `);
    res.json({ employers: rows });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch verifications' }); }
});

// ── PATCH /admin/verify-employer/:id ─────────────────────────
router.patch('/verify-employer/:id', async (req, res) => {
  try {
    await query('UPDATE employer_profiles SET is_verified=true, verified_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ message: 'Employer verified' });
  } catch (err) { res.status(500).json({ error: 'Failed to verify employer' }); }
});

module.exports = router;
