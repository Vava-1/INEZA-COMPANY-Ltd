'use strict';
const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { query, withTransaction } = require('../models/db');
const { authenticate, requireRole } = require('../middleware/auth');
const logger = require('../utils/logger');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
  next();
};

// ── GET /candidates/profile — Own profile ─────────────────────
router.get('/profile', authenticate, requireRole('candidate'), async (req, res) => {
  try {
    const { rows: [cp] } = await query(`
      SELECT cp.*,
        json_agg(DISTINCT jsonb_build_object('id',cs.id,'name',cs.skill_name,'level',cs.skill_level,'years',cs.years)) FILTER (WHERE cs.id IS NOT NULL) AS skills,
        json_agg(DISTINCT jsonb_build_object('id',we.id,'title',we.job_title,'company',we.company,'start',we.start_date,'end',we.end_date,'current',we.is_current,'desc',we.description)) FILTER (WHERE we.id IS NOT NULL) AS experiences
      FROM candidate_profiles cp
      LEFT JOIN candidate_skills cs ON cp.id = cs.candidate_id
      LEFT JOIN work_experiences we ON cp.id = we.candidate_id
      WHERE cp.user_id = $1
      GROUP BY cp.id
    `, [req.user.id]);
    if (!cp) return res.status(404).json({ error: 'Profile not found' });
    res.json({ profile: cp });
  } catch (err) {
    logger.error('GET /candidates/profile error:', err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// ── PUT /candidates/profile — Update own profile ──────────────
router.put('/profile', authenticate, requireRole('candidate'), async (req, res) => {
  try {
    const {
      first_name, last_name, phone, nationality, location, linkedin_url,
      headline, summary, current_title, current_employer, years_experience,
      industry, highest_qualification, field_of_study, institution, graduation_year,
      desired_title, desired_salary_min, desired_salary_max, salary_currency,
      salary_negotiable, preferred_location, preferred_arrangement,
      open_to_relocation, open_to_international, availability, languages,
      profile_visible, alerts_email, alerts_whatsapp
    } = req.body;

    const { rows: [cp] } = await query(`
      UPDATE candidate_profiles SET
        first_name=$1, last_name=$2, phone=$3, nationality=$4, location=$5,
        linkedin_url=$6, headline=$7, summary=$8, current_title=$9,
        current_employer=$10, years_experience=$11, industry=$12,
        highest_qualification=$13, field_of_study=$14, institution=$15,
        graduation_year=$16, desired_title=$17, desired_salary_min=$18,
        desired_salary_max=$19, salary_currency=$20, salary_negotiable=$21,
        preferred_location=$22, preferred_arrangement=$23,
        open_to_relocation=$24, open_to_international=$25,
        availability=$26, languages=$27, profile_visible=$28,
        alerts_email=$29, alerts_whatsapp=$30
      WHERE user_id=$31
      RETURNING id, profile_score
    `, [
      first_name, last_name, phone, nationality, location, linkedin_url,
      headline, summary, current_title, current_employer, years_experience,
      industry, highest_qualification, field_of_study, institution, graduation_year,
      desired_title, desired_salary_min, desired_salary_max, salary_currency || 'RWF',
      salary_negotiable !== false, preferred_location, preferred_arrangement || 'onsite',
      open_to_relocation || false, open_to_international || false,
      availability || 'immediately', JSON.stringify(languages || []),
      profile_visible !== false, alerts_email !== false, alerts_whatsapp || false,
      req.user.id
    ]);

    // Recalculate profile score
    const score = await calcProfileScore(cp.id);
    await query('UPDATE candidate_profiles SET profile_score=$1 WHERE id=$2', [score, cp.id]);

    res.json({ message: 'Profile updated', profile_score: score });
  } catch (err) {
    logger.error('PUT /candidates/profile error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Profile score calculator
async function calcProfileScore(candidateId) {
  const { rows: [cp] } = await query(
    `SELECT cp.*, COUNT(cs.id) AS skill_count, COUNT(we.id) AS exp_count
     FROM candidate_profiles cp
     LEFT JOIN candidate_skills cs ON cp.id=cs.candidate_id
     LEFT JOIN work_experiences we ON cp.id=we.candidate_id
     WHERE cp.id=$1 GROUP BY cp.id`,
    [candidateId]
  );
  if (!cp) return 0;
  let score = 0;
  if (cp.first_name && cp.last_name) score += 10;
  if (cp.phone)              score += 5;
  if (cp.profile_photo_url)  score += 10;
  if (cp.headline)           score += 8;
  if (cp.summary?.length > 80) score += 10;
  if (cp.cv_url)             score += 15;
  if (parseInt(cp.skill_count) >= 3) score += 12;
  if (parseInt(cp.exp_count) >= 1)   score += 10;
  if (cp.linkedin_url)       score += 5;
  if (cp.desired_salary_min) score += 5;
  if (cp.industry)           score += 5;
  if (cp.highest_qualification) score += 5;
  return Math.min(score, 100);
}

// ── POST /candidates/skills — Replace all skills ──────────────
router.post('/skills', authenticate, requireRole('candidate'), async (req, res) => {
  try {
    const { skills } = req.body; // [{ name, level, years }]
    if (!Array.isArray(skills)) return res.status(400).json({ error: 'skills must be an array' });
    const { rows: [cp] } = await query('SELECT id FROM candidate_profiles WHERE user_id=$1', [req.user.id]);
    if (!cp) return res.status(404).json({ error: 'Profile not found' });

    await withTransaction(async (client) => {
      await client.query('DELETE FROM candidate_skills WHERE candidate_id=$1', [cp.id]);
      for (const s of skills.slice(0, 30)) {
        if (!s.name?.trim()) continue;
        await client.query(
          'INSERT INTO candidate_skills (candidate_id, skill_name, skill_level, years) VALUES ($1,$2,$3,$4)',
          [cp.id, s.name.trim(), s.level || null, s.years || null]
        );
      }
    });

    const score = await calcProfileScore(cp.id);
    await query('UPDATE candidate_profiles SET profile_score=$1 WHERE id=$2', [score, cp.id]);

    res.json({ message: 'Skills updated', count: skills.length });
  } catch (err) {
    logger.error('POST /candidates/skills error:', err);
    res.status(500).json({ error: 'Failed to update skills' });
  }
});

// ── POST /candidates/experience — Add work experience ─────────
router.post('/experience', authenticate, requireRole('candidate'), async (req, res) => {
  try {
    const { job_title, company, location, start_date, end_date, is_current, description } = req.body;
    const { rows: [cp] } = await query('SELECT id FROM candidate_profiles WHERE user_id=$1', [req.user.id]);

    const { rows: [exp] } = await query(`
      INSERT INTO work_experiences (candidate_id, job_title, company, location, start_date, end_date, is_current, description)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [cp.id, job_title, company, location || null, start_date, end_date || null, is_current || false, description || null]);

    res.status(201).json({ experience: exp });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add experience' });
  }
});

// ── DELETE /candidates/experience/:id ─────────────────────────
router.delete('/experience/:id', authenticate, requireRole('candidate'), async (req, res) => {
  try {
    const { rows: [cp] } = await query('SELECT id FROM candidate_profiles WHERE user_id=$1', [req.user.id]);
    await query('DELETE FROM work_experiences WHERE id=$1 AND candidate_id=$2', [req.params.id, cp.id]);
    res.json({ message: 'Experience deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete experience' });
  }
});

// ── GET /candidates/saved-jobs — Saved job listings ──────────
router.get('/saved-jobs', authenticate, requireRole('candidate'), async (req, res) => {
  try {
    const { rows: [cp] } = await query('SELECT id FROM candidate_profiles WHERE user_id=$1', [req.user.id]);
    const { rows } = await query(`
      SELECT sj.id AS saved_id, sj.created_at AS saved_at,
        j.id, j.title, j.job_type, j.location, j.salary_min, j.salary_max,
        j.salary_currency, j.salary_hidden, j.status, j.published_at,
        ep.company_name, ep.logo_url AS company_logo
      FROM saved_jobs sj
      JOIN jobs j ON sj.job_id = j.id
      JOIN employer_profiles ep ON j.employer_id = ep.id
      WHERE sj.candidate_id=$1
      ORDER BY sj.created_at DESC
    `, [cp.id]);
    res.json({ saved_jobs: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch saved jobs' });
  }
});

// ── POST /candidates/saved-jobs/:jobId — Toggle save ─────────
router.post('/saved-jobs/:jobId', authenticate, requireRole('candidate'), async (req, res) => {
  try {
    const { rows: [cp] } = await query('SELECT id FROM candidate_profiles WHERE user_id=$1', [req.user.id]);
    const { rows: [existing] } = await query(
      'SELECT id FROM saved_jobs WHERE candidate_id=$1 AND job_id=$2', [cp.id, req.params.jobId]
    );
    if (existing) {
      await query('DELETE FROM saved_jobs WHERE candidate_id=$1 AND job_id=$2', [cp.id, req.params.jobId]);
      return res.json({ saved: false, message: 'Job removed from saved' });
    }
    await query('INSERT INTO saved_jobs (candidate_id, job_id) VALUES ($1,$2)', [cp.id, req.params.jobId]);
    res.json({ saved: true, message: 'Job saved!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle save' });
  }
});

// ── GET /candidates/alerts — Job alerts ───────────────────────
router.get('/alerts', authenticate, requireRole('candidate'), async (req, res) => {
  try {
    const { rows: [cp] } = await query('SELECT id FROM candidate_profiles WHERE user_id=$1', [req.user.id]);
    const { rows } = await query(
      'SELECT * FROM job_alerts WHERE candidate_id=$1 ORDER BY created_at DESC', [cp.id]
    );
    res.json({ alerts: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

// ── POST /candidates/alerts — Create alert ────────────────────
router.post('/alerts', authenticate, requireRole('candidate'), async (req, res) => {
  try {
    const { name, keywords, location, industry, job_type, salary_min, frequency } = req.body;
    const { rows: [cp] } = await query('SELECT id FROM candidate_profiles WHERE user_id=$1', [req.user.id]);

    // Limit to 10 alerts
    const { rows: [{ count }] } = await query('SELECT COUNT(*) FROM job_alerts WHERE candidate_id=$1', [cp.id]);
    if (parseInt(count) >= 10) return res.status(400).json({ error: 'Maximum 10 job alerts allowed' });

    const { rows: [alert] } = await query(`
      INSERT INTO job_alerts (candidate_id, name, keywords, location, industry, job_type, salary_min, frequency)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [cp.id, name || keywords, keywords, location, industry, job_type, salary_min, frequency || 'daily']);

    res.status(201).json({ alert });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create alert' });
  }
});

// ── PATCH /candidates/alerts/:id — Toggle or update alert ─────
router.patch('/alerts/:id', authenticate, requireRole('candidate'), async (req, res) => {
  try {
    const { rows: [cp] } = await query('SELECT id FROM candidate_profiles WHERE user_id=$1', [req.user.id]);
    const { is_active, frequency } = req.body;
    await query(
      'UPDATE job_alerts SET is_active=$1, frequency=COALESCE($2,frequency) WHERE id=$3 AND candidate_id=$4',
      [is_active !== undefined ? is_active : true, frequency || null, req.params.id, cp.id]
    );
    res.json({ message: 'Alert updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update alert' });
  }
});

// ── DELETE /candidates/alerts/:id ────────────────────────────
router.delete('/alerts/:id', authenticate, requireRole('candidate'), async (req, res) => {
  try {
    const { rows: [cp] } = await query('SELECT id FROM candidate_profiles WHERE user_id=$1', [req.user.id]);
    await query('DELETE FROM job_alerts WHERE id=$1 AND candidate_id=$2', [req.params.id, cp.id]);
    res.json({ message: 'Alert deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete alert' });
  }
});

// ── GET /candidates/dashboard — Dashboard stats ───────────────
router.get('/dashboard', authenticate, requireRole('candidate'), async (req, res) => {
  try {
    const { rows: [cp] } = await query('SELECT id, profile_score, profile_views FROM candidate_profiles WHERE user_id=$1', [req.user.id]);
    if (!cp) return res.status(404).json({ error: 'Profile not found' });

    const [appStats, savedCount, unreadNotifs] = await Promise.all([
      query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status='interview_scheduled') AS interviews,
          COUNT(*) FILTER (WHERE status='offer_extended') AS offers,
          COUNT(*) FILTER (WHERE status='hired') AS hired
        FROM applications WHERE candidate_id=$1
      `, [cp.id]),
      query('SELECT COUNT(*) FROM saved_jobs WHERE candidate_id=$1', [cp.id]),
      query('SELECT COUNT(*) FROM notifications WHERE user_id=$1 AND read_at IS NULL', [req.user.id])
    ]);

    res.json({
      profile_score: cp.profile_score,
      profile_views: cp.profile_views,
      applications: appStats.rows[0],
      saved_jobs: parseInt(savedCount.rows[0].count),
      unread_notifications: parseInt(unreadNotifs.rows[0].count)
    });
  } catch (err) {
    logger.error('GET /candidates/dashboard error:', err);
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
});

module.exports = router;
