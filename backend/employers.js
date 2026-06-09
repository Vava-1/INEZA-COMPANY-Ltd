'use strict';
// ============================================================
// EMPLOYERS ROUTES
// ============================================================
const router  = require('express').Router();
const { query, withTransaction } = require('../models/db');
const { authenticate, requireRole } = require('../middleware/auth');
const logger  = require('../utils/logger');

// GET /employers/profile
router.get('/profile', authenticate, requireRole('employer','admin'), async (req, res) => {
  try {
    const { rows: [ep] } = await query('SELECT * FROM employer_profiles WHERE user_id=$1', [req.user.id]);
    if (!ep) return res.status(404).json({ error: 'Employer profile not found' });
    res.json({ profile: ep });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch profile' }); }
});

// PUT /employers/profile
router.put('/profile', authenticate, requireRole('employer','admin'), async (req, res) => {
  try {
    const {
      company_name, company_size, industry, website_url,
      description, contact_name, contact_title, phone, address, city
    } = req.body;

    const slug = company_name?.toLowerCase()
      .replace(/[^a-z0-9\s]/g,'').replace(/\s+/g,'-').substring(0,100);

    await query(`
      UPDATE employer_profiles SET
        company_name=$1, company_size=$2, industry=$3, website_url=$4,
        description=$5, contact_name=$6, contact_title=$7, phone=$8,
        address=$9, city=$10, company_slug=COALESCE(company_slug,$11)
      WHERE user_id=$12
    `, [company_name, company_size, industry, website_url, description,
        contact_name, contact_title, phone, address, city || 'Kigali', slug, req.user.id]);

    res.json({ message: 'Company profile updated' });
  } catch (err) { res.status(500).json({ error: 'Failed to update profile' }); }
});

// GET /employers/dashboard
router.get('/dashboard', authenticate, requireRole('employer','admin'), async (req, res) => {
  try {
    const { rows: [ep] } = await query('SELECT id FROM employer_profiles WHERE user_id=$1', [req.user.id]);
    if (!ep) return res.status(404).json({ error: 'Profile not found' });

    const [jobStats, appStats, recentApps] = await Promise.all([
      query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='active') AS active,
              COUNT(*) FILTER (WHERE status='paused') AS paused FROM jobs WHERE employer_id=$1 AND deleted_at IS NULL`, [ep.id]),
      query(`SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE a.status='shortlisted') AS shortlisted,
              COUNT(*) FILTER (WHERE a.status='interview_scheduled') AS interviews,
              COUNT(*) FILTER (WHERE a.status='hired') AS hired
             FROM applications a JOIN jobs j ON a.job_id=j.id WHERE j.employer_id=$1`, [ep.id]),
      query(`SELECT a.id, a.status, a.created_at, j.title AS job_title,
              cp.first_name, cp.last_name, cp.current_title, cp.profile_photo_url
             FROM applications a JOIN jobs j ON a.job_id=j.id
             JOIN candidate_profiles cp ON a.candidate_id=cp.id
             WHERE j.employer_id=$1 ORDER BY a.created_at DESC LIMIT 5`, [ep.id])
    ]);

    res.json({
      jobs: jobStats.rows[0],
      applications: appStats.rows[0],
      recent_applications: recentApps.rows
    });
  } catch (err) {
    logger.error('GET /employers/dashboard error:', err);
    res.status(500).json({ error: 'Failed to fetch dashboard' });
  }
});

// GET /employers/:slug — Public company page
router.get('/:slug', async (req, res) => {
  try {
    const { rows: [ep] } = await query(
      'SELECT * FROM employer_profiles WHERE company_slug=$1 AND is_verified=true', [req.params.slug]
    );
    if (!ep) return res.status(404).json({ error: 'Company not found' });
    const { rows: jobs } = await query(
      `SELECT id,title,job_type,location,salary_min,salary_max,salary_hidden,published_at
       FROM jobs WHERE employer_id=$1 AND status='active' ORDER BY published_at DESC LIMIT 10`, [ep.id]
    );
    res.json({ company: ep, jobs });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch company' }); }
});

module.exports = router;
