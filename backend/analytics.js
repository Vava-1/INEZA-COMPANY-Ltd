'use strict';
const router = require('express').Router();
const { query } = require('../models/db');
const { authenticate, requireRole } = require('../middleware/auth');

// POST /analytics/track — Frontend event tracking
router.post('/track', authenticate, async (req, res) => {
  try {
    const { event_type, job_id, data } = req.body;
    if (!event_type) return res.status(400).json({ error: 'event_type required' });
    await query(
      'INSERT INTO analytics_events (event_type,user_id,job_id,data,ip_address) VALUES ($1,$2,$3,$4,$5)',
      [event_type, req.user.id, job_id || null, JSON.stringify(data || {}), req.ip]
    );
    res.json({ tracked: true });
  } catch { res.json({ tracked: false }); }
});

// GET /analytics/overview — Admin overview
router.get('/overview', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const interval = `${days} days`;
    const [usersRow, jobsRow, appsRow, revenueRow, dailyRow] = await Promise.all([
      query(`SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE created_at >= NOW()-INTERVAL '${interval}') AS new_period,
               COUNT(*) FILTER (WHERE role='candidate') AS candidates,
               COUNT(*) FILTER (WHERE role='employer') AS employers
             FROM users WHERE deleted_at IS NULL`),
      query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='active') AS active,
               COUNT(*) FILTER (WHERE status='pending_review') AS pending,
               COUNT(*) FILTER (WHERE featured=true) AS featured
             FROM jobs WHERE deleted_at IS NULL`),
      query(`SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE status='hired') AS placements,
               COUNT(*) FILTER (WHERE created_at >= NOW()-INTERVAL '${interval}') AS new_period
             FROM applications`),
      query(`SELECT COALESCE(SUM(amount) FILTER (WHERE currency='RWF'),0) AS rwf_total,
               COALESCE(SUM(amount) FILTER (WHERE currency='USD'),0) AS usd_total,
               COUNT(*) AS transaction_count
             FROM payments WHERE status='completed' AND created_at >= NOW()-INTERVAL '${interval}'`),
      query(`SELECT DATE_TRUNC('day', created_at)::date AS date, COUNT(*) AS signups
             FROM users WHERE created_at >= NOW()-INTERVAL '${interval}' AND deleted_at IS NULL
             GROUP BY 1 ORDER BY 1`)
    ]);
    res.json({
      users: usersRow.rows[0],
      jobs: jobsRow.rows[0],
      applications: appsRow.rows[0],
      revenue: revenueRow.rows[0],
      daily_signups: dailyRow.rows
    });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch analytics' }); }
});

// GET /analytics/jobs/:id — Per-job analytics for employer
router.get('/jobs/:id', authenticate, requireRole('employer','admin'), async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        COUNT(*) AS total_apps,
        COUNT(*) FILTER (WHERE status='shortlisted')    AS shortlisted,
        COUNT(*) FILTER (WHERE status IN ('interview_scheduled','interview_completed')) AS interviews,
        COUNT(*) FILTER (WHERE status='hired')          AS hired,
        COUNT(*) FILTER (WHERE status='rejected')       AS rejected,
        AVG(ineza_score) FILTER (WHERE ineza_score IS NOT NULL) AS avg_score,
        json_agg(jsonb_build_object('date', DATE_TRUNC('day',a.created_at)::date, 'count', 1) ORDER BY a.created_at) AS timeline
      FROM applications a WHERE a.job_id=$1
    `, [req.params.id]);
    const jobRow = await query('SELECT views_count, applications_count, title FROM jobs WHERE id=$1', [req.params.id]);
    res.json({ stats: rows[0], job: jobRow.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch job analytics' }); }
});

module.exports = router;
