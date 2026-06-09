'use strict';
const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { query, withTransaction } = require('../models/db');
const { authenticate, requireRole } = require('../middleware/auth');
const notifService = require('../services/notifications');
const logger = require('../utils/logger');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
  next();
};

// ── POST /applications — Candidate applies for a job ─────────
router.post('/',
  authenticate,
  requireRole('candidate'),
  [
    body('job_id').isUUID().withMessage('Valid job_id required'),
    body('cover_letter').optional().trim().isLength({ max: 5000 }),
  ],
  validate,
  async (req, res) => {
    try {
      const { job_id, cover_letter, portfolio_url } = req.body;

      // Get candidate profile
      const { rows: [cp] } = await query(
        'SELECT id, cv_url FROM candidate_profiles WHERE user_id = $1', [req.user.id]
      );
      if (!cp) return res.status(404).json({ error: 'Candidate profile not found. Please complete your profile first.' });
      if (!cp.cv_url) return res.status(400).json({ error: 'Please upload your CV before applying.' });

      // Check job exists and is active
      const { rows: [job] } = await query(
        `SELECT j.id, j.title, j.employer_id, ep.company_name, ep.user_id AS emp_user_id
         FROM jobs j JOIN employer_profiles ep ON j.employer_id=ep.id
         WHERE j.id=$1 AND j.status='active' AND j.deleted_at IS NULL`,
        [job_id]
      );
      if (!job) return res.status(404).json({ error: 'Job not found or no longer accepting applications.' });

      // Check plan limits (free: 5/month)
      if (req.user.plan === 'candidate_free') {
        const { rows } = await query(
          `SELECT COUNT(*) FROM applications a
           JOIN candidate_profiles cp ON a.candidate_id=cp.id
           WHERE cp.user_id=$1 AND a.created_at >= date_trunc('month', NOW())`,
          [req.user.id]
        );
        if (parseInt(rows[0].count) >= 5) {
          return res.status(403).json({
            error: 'Free plan limited to 5 applications per month. Upgrade to Pro for unlimited applications.',
            code: 'PLAN_LIMIT_REACHED',
            upgrade_url: '/auth/signup.html?plan=candidate_pro'
          });
        }
      }

      // Check duplicate application
      const { rows: [existing] } = await query(
        'SELECT id, status FROM applications WHERE candidate_id=$1 AND job_id=$2',
        [cp.id, job_id]
      );
      if (existing) {
        return res.status(409).json({
          error: 'You have already applied for this job.',
          application: existing
        });
      }

      // Create application
      const { rows: [app] } = await query(`
        INSERT INTO applications (job_id, candidate_id, cover_letter, cv_url, portfolio_url, source)
        VALUES ($1, $2, $3, $4, $5, 'platform')
        RETURNING *
      `, [job_id, cp.id, cover_letter || null, cp.cv_url, portfolio_url || null]);

      // Notify employer (real-time + DB)
      await notifService.create({
        userId: job.emp_user_id,
        type: 'new_application',
        title: 'New Application Received',
        body: `A candidate applied for: ${job.title}`,
        data: { applicationId: app.id, jobId: job_id }
      });

      // Real-time socket notification
      const io = req.app.get('io');
      if (io) {
        io.to(`user:${job.emp_user_id}`).emit('new_application', {
          applicationId: app.id,
          jobTitle: job.title,
          company: job.company_name
        });
      }

      res.status(201).json({
        message: 'Application submitted successfully! Your recruiter will be in touch within 48 hours.',
        application: app
      });
    } catch (err) {
      logger.error('POST /applications error:', err);
      res.status(500).json({ error: 'Failed to submit application' });
    }
  }
);

// ── GET /applications/mine — Candidate's own applications ─────
router.get('/mine', authenticate, requireRole('candidate'), async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const { rows: [cp] } = await query(
      'SELECT id FROM candidate_profiles WHERE user_id=$1', [req.user.id]
    );
    if (!cp) return res.status(404).json({ error: 'Profile not found' });

    let where = 'a.candidate_id = $1';
    const params = [cp.id];
    let idx = 2;

    if (status) { where += ` AND a.status=$${idx++}`; params.push(status); }

    const { rows } = await query(`
      SELECT
        a.id, a.status, a.created_at, a.interview_date, a.offer_amount,
        a.status_updated_at, a.placed_at,
        j.id AS job_id, j.title AS job_title, j.job_type, j.location,
        j.salary_min, j.salary_max, j.salary_currency, j.salary_hidden,
        ep.company_name, ep.logo_url AS company_logo, ep.is_verified
      FROM applications a
      JOIN jobs j ON a.job_id = j.id
      JOIN employer_profiles ep ON j.employer_id = ep.id
      WHERE ${where}
      ORDER BY a.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, [...params, parseInt(limit), offset]);

    const { rows: [{ count }] } = await query(
      `SELECT COUNT(*) FROM applications WHERE candidate_id=$1`, [cp.id]
    );

    res.json({
      applications: rows,
      pagination: { total: parseInt(count), page: parseInt(page), limit: parseInt(limit) }
    });
  } catch (err) {
    logger.error('GET /applications/mine error:', err);
    res.status(500).json({ error: 'Failed to fetch applications' });
  }
});

// ── GET /applications/:id — Single application detail ─────────
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { rows: [app] } = await query(`
      SELECT a.*,
        j.title AS job_title, j.job_type, j.location, j.salary_min, j.salary_max,
        j.description AS job_description,
        ep.company_name, ep.logo_url AS company_logo, ep.user_id AS emp_user_id,
        cp.first_name, cp.last_name, cp.current_title, cp.profile_photo_url,
        cp.user_id AS cand_user_id
      FROM applications a
      JOIN jobs j ON a.job_id = j.id
      JOIN employer_profiles ep ON j.employer_id = ep.id
      JOIN candidate_profiles cp ON a.candidate_id = cp.id
      WHERE a.id = $1
    `, [req.params.id]);

    if (!app) return res.status(404).json({ error: 'Application not found' });

    // Only involved parties can view
    if (req.user.id !== app.emp_user_id && req.user.id !== app.cand_user_id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorised' });
    }

    res.json({ application: app });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch application' });
  }
});

// ── PATCH /applications/:id/status — Update pipeline status ──
router.patch('/:id/status',
  authenticate,
  requireRole('employer', 'admin', 'recruiter'),
  [body('status').isIn(['under_review','shortlisted','interview_scheduled','interview_completed','offer_extended','offer_accepted','offer_declined','hired','rejected'])],
  validate,
  async (req, res) => {
    try {
      const { status, interview_date, interview_type, offer_amount, offer_currency, start_date, ineza_notes, ineza_score } = req.body;

      const { rows: [app] } = await query(`
        SELECT a.*, j.employer_id, j.title AS job_title, ep.user_id AS emp_user_id,
               cp.user_id AS cand_user_id, cp.first_name
        FROM applications a
        JOIN jobs j ON a.job_id=j.id
        JOIN employer_profiles ep ON j.employer_id=ep.id
        JOIN candidate_profiles cp ON a.candidate_id=cp.id
        WHERE a.id=$1
      `, [req.params.id]);

      if (!app) return res.status(404).json({ error: 'Application not found' });
      if (app.emp_user_id !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Not authorised' });
      }

      const updates = {
        status,
        status_updated_at: 'NOW()',
        interview_date: interview_date || null,
        interview_type: interview_type || null,
        offer_amount: offer_amount || null,
        offer_currency: offer_currency || null,
        start_date: start_date || null,
        ineza_notes: ineza_notes || null,
        ineza_score: ineza_score || null
      };

      if (status === 'shortlisted') {
        updates.shortlisted_at = 'NOW()';
        updates.shortlisted_by = req.user.id;
      }
      if (status === 'hired') {
        updates.placed_at = 'NOW()';
        // Calculate placement fee (18% of annual salary)
        if (offer_amount) {
          updates.placement_fee = offer_amount * 12 * 0.18;
        }
      }

      await query(`
        UPDATE applications SET
          status=$1, status_updated_at=NOW(),
          interview_date=$2, interview_type=$3,
          offer_amount=$4, offer_currency=$5,
          start_date=$6, ineza_notes=$7, ineza_score=$8,
          shortlisted_at=CASE WHEN $1='shortlisted' THEN NOW() ELSE shortlisted_at END,
          placed_at=CASE WHEN $1='hired' THEN NOW() ELSE placed_at END,
          placement_fee=CASE WHEN $1='hired' AND $4 IS NOT NULL THEN $4*12*0.18 ELSE placement_fee END
        WHERE id=$9
      `, [status, interview_date || null, interview_type || null, offer_amount || null, offer_currency || null, start_date || null, ineza_notes || null, ineza_score || null, req.params.id]);

      // Notify candidate
      const statusMessages = {
        shortlisted: `🎉 Great news! You've been shortlisted for ${app.job_title}`,
        interview_scheduled: `📅 Interview scheduled for ${app.job_title} on ${interview_date}`,
        offer_extended: `🏆 You have received a job offer for ${app.job_title}!`,
        hired: `🎊 Congratulations! You've been hired for ${app.job_title}!`,
        rejected: `Your application for ${app.job_title} was not successful this time.`
      };

      if (statusMessages[status]) {
        await notifService.create({
          userId: app.cand_user_id,
          type: 'application_update',
          title: 'Application Update',
          body: statusMessages[status],
          data: { applicationId: app.id, status, jobTitle: app.job_title }
        });

        const io = req.app.get('io');
        if (io) {
          io.to(`user:${app.cand_user_id}`).emit('application_update', {
            applicationId: app.id,
            status,
            message: statusMessages[status]
          });
        }
      }

      res.json({ message: `Application marked as ${status}` });
    } catch (err) {
      logger.error('PATCH application status error:', err);
      res.status(500).json({ error: 'Failed to update application status' });
    }
  }
);

// ── DELETE /applications/:id — Withdraw application ──────────
router.delete('/:id', authenticate, requireRole('candidate'), async (req, res) => {
  try {
    const { rows: [cp] } = await query('SELECT id FROM candidate_profiles WHERE user_id=$1', [req.user.id]);
    const result = await query(
      `UPDATE applications SET status='withdrawn' WHERE id=$1 AND candidate_id=$2 AND status NOT IN ('hired','offer_accepted') RETURNING id`,
      [req.params.id, cp.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Application not found or cannot be withdrawn' });
    res.json({ message: 'Application withdrawn' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to withdraw application' });
  }
});

// ── POST /applications/:id/save-notes — Recruiter notes ───────
router.post('/:id/notes', authenticate, requireRole('admin', 'recruiter', 'employer'), async (req, res) => {
  try {
    const { notes, score } = req.body;
    await query(
      'UPDATE applications SET ineza_notes=$1, ineza_score=$2 WHERE id=$3',
      [notes, score, req.params.id]
    );
    res.json({ message: 'Notes saved' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save notes' });
  }
});

module.exports = router;
