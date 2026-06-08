'use strict';
const router = require('express').Router();
const { body, query: qv, validationResult } = require('express-validator');
const { query, withTransaction } = require('../models/db');
const { authenticate, optionalAuth, requireRole, requirePlan } = require('../middleware/auth');
const logger = require('../utils/logger');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
  next();
};

// ── GET /jobs — Public job board with full search + filters ───
router.get('/', optionalAuth, async (req, res) => {
  try {
    const {
      q, location, industry, job_type, arrangement,
      level, salary_min, salary_max, featured, urgent,
      page = 1, limit = 20, sort = 'published_at',
      employer_id
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    let idx = 1;

    let where = `j.status = 'active' AND j.deleted_at IS NULL AND (j.expires_at IS NULL OR j.expires_at > NOW())`;

    if (q) {
      where += ` AND j.search_vector @@ plainto_tsquery('english', $${idx++})`;
      params.push(q);
    }
    if (location) {
      where += ` AND j.location ILIKE $${idx++}`;
      params.push(`%${location}%`);
    }
    if (industry) {
      where += ` AND j.industry = $${idx++}`;
      params.push(industry);
    }
    if (job_type) {
      where += ` AND j.job_type = $${idx++}`;
      params.push(job_type);
    }
    if (arrangement) {
      where += ` AND j.arrangement = $${idx++}`;
      params.push(arrangement);
    }
    if (level) {
      where += ` AND j.experience_level ILIKE $${idx++}`;
      params.push(`%${level}%`);
    }
    if (salary_min) {
      where += ` AND j.salary_max >= $${idx++}`;
      params.push(parseFloat(salary_min));
    }
    if (salary_max) {
      where += ` AND j.salary_min <= $${idx++}`;
      params.push(parseFloat(salary_max));
    }
    if (featured === 'true') {
      where += ` AND j.featured = true`;
    }
    if (urgent === 'true') {
      where += ` AND j.urgent = true`;
    }
    if (employer_id) {
      where += ` AND j.employer_id = $${idx++}`;
      params.push(employer_id);
    }

    const sortMap = {
      'published_at': 'j.published_at DESC',
      'salary': 'j.salary_max DESC NULLS LAST',
      'applications': 'j.applications_count DESC',
      'relevance': q ? `ts_rank(j.search_vector, plainto_tsquery('english', '${q.replace(/'/g,"''")}')) DESC` : 'j.published_at DESC'
    };
    const orderBy = sortMap[sort] || 'j.published_at DESC';

    // Featured jobs always at top
    const fullOrder = `j.featured DESC, j.urgent DESC, ${orderBy}`;

    const dataQuery = `
      SELECT
        j.id, j.title, j.slug, j.industry, j.job_type, j.arrangement,
        j.location, j.experience_level, j.salary_min, j.salary_max,
        j.salary_currency, j.salary_hidden, j.featured, j.urgent,
        j.published_at, j.expires_at, j.applications_count, j.views_count,
        j.required_skills, j.ineza_ref, j.confidential,
        ep.company_name, ep.company_slug, ep.logo_url AS company_logo,
        ep.is_verified AS company_verified, ep.city AS company_city
      FROM jobs j
      JOIN employer_profiles ep ON j.employer_id = ep.id
      WHERE ${where}
      ORDER BY ${fullOrder}
      LIMIT $${idx++} OFFSET $${idx++}
    `;

    const countQuery = `
      SELECT COUNT(*) FROM jobs j
      JOIN employer_profiles ep ON j.employer_id = ep.id
      WHERE ${where}
    `;

    params.push(parseInt(limit), offset);
    const countParams = params.slice(0, params.length - 2);

    const [dataResult, countResult] = await Promise.all([
      query(dataQuery, params),
      query(countQuery, countParams)
    ]);

    const total = parseInt(countResult.rows[0].count);

    // Track job views (non-blocking analytics)
    if (req.user) {
      query(
        `INSERT INTO analytics_events (event_type, user_id, data) VALUES ('job_search', $1, $2)`,
        [req.user.id, JSON.stringify({ q, location, industry })]
      ).catch(() => {});
    }

    res.json({
      jobs: dataResult.rows,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (err) {
    logger.error('GET /jobs error:', err);
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

// ── GET /jobs/:id — Single job detail ─────────────────────────
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        j.*,
        ep.company_name, ep.company_slug, ep.logo_url AS company_logo,
        ep.description AS company_description, ep.website_url,
        ep.company_size, ep.is_verified AS company_verified,
        ep.city AS company_city, ep.total_hires AS company_total_hires
      FROM jobs j
      JOIN employer_profiles ep ON j.employer_id = ep.id
      WHERE j.id = $1 AND j.deleted_at IS NULL
    `, [req.params.id]);

    if (!rows[0]) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];

    // Increment view count (non-blocking)
    query('UPDATE jobs SET views_count = views_count + 1 WHERE id = $1', [job.id]).catch(() => {});

    // Check if current user has saved/applied
    if (req.user?.role === 'candidate') {
      const { rows: cp } = await query(
        'SELECT id FROM candidate_profiles WHERE user_id = $1', [req.user.id]
      );
      if (cp[0]) {
        const [saved, applied] = await Promise.all([
          query('SELECT id FROM saved_jobs WHERE candidate_id=$1 AND job_id=$2', [cp[0].id, job.id]),
          query('SELECT id, status FROM applications WHERE candidate_id=$1 AND job_id=$2', [cp[0].id, job.id])
        ]);
        job.is_saved = !!saved.rows[0];
        job.application = applied.rows[0] || null;
      }
    }

    res.json({ job });
  } catch (err) {
    logger.error('GET /jobs/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

// ── POST /jobs — Create job (employer only) ───────────────────
router.post('/',
  authenticate,
  requireRole('employer', 'admin'),
  [
    body('title').trim().isLength({ min: 5, max: 255 }).withMessage('Title must be 5-255 chars'),
    body('description').trim().isLength({ min: 50 }).withMessage('Description must be at least 50 chars'),
    body('job_type').isIn(['fulltime','parttime','contract','freelance','internship']),
    body('location').trim().notEmpty().withMessage('Location required'),
    body('industry').trim().notEmpty().withMessage('Industry required'),
  ],
  validate,
  async (req, res) => {
    try {
      const { rows: [ep] } = await query(
        'SELECT id FROM employer_profiles WHERE user_id = $1', [req.user.id]
      );
      if (!ep) return res.status(404).json({ error: 'Employer profile not found' });

      const {
        title, department, industry, job_type, arrangement,
        location, experience_level, min_years_exp, positions_count,
        salary_min, salary_max, salary_currency, salary_hidden, benefits,
        description, responsibilities, requirements, nice_to_have,
        required_skills, required_languages, expires_at, featured,
        urgent, confidential, ineza_managed
      } = req.body;

      // Check plan limits
      if (req.user.plan === 'employer_starter') {
        const { rows } = await query(
          `SELECT COUNT(*) FROM jobs WHERE employer_id=$1 AND status IN ('active','pending_review','draft')`,
          [ep.id]
        );
        if (parseInt(rows[0].count) >= 3) {
          return res.status(403).json({
            error: 'Starter plan limited to 3 active jobs. Upgrade to Business plan.',
            code: 'PLAN_LIMIT_REACHED'
          });
        }
      }

      const slug = title.toLowerCase()
        .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '-')
        .substring(0, 100) + '-' + Date.now().toString(36);

      const { rows: [job] } = await query(`
        INSERT INTO jobs (
          employer_id, title, slug, department, industry, job_type,
          arrangement, location, experience_level, min_years_exp,
          positions_count, salary_min, salary_max, salary_currency,
          salary_hidden, benefits, description, responsibilities,
          requirements, nice_to_have, required_skills, required_languages,
          expires_at, featured, urgent, confidential, ineza_managed,
          status, published_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
          $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,
          'pending_review', NOW()
        ) RETURNING *
      `, [
        ep.id, title, slug, department, industry, job_type,
        arrangement || 'onsite', location, experience_level, min_years_exp || null,
        positions_count || 1, salary_min || null, salary_max || null,
        salary_currency || 'RWF', salary_hidden || false,
        JSON.stringify(benefits || []), description,
        responsibilities || null, requirements || null, nice_to_have || null,
        JSON.stringify(required_skills || []),
        JSON.stringify(required_languages || []),
        expires_at || null,
        featured || false, urgent || false,
        confidential || false, ineza_managed !== false
      ]);

      // Update employer stats
      await query(
        'UPDATE employer_profiles SET total_jobs_posted = total_jobs_posted + 1 WHERE id = $1',
        [ep.id]
      );

      // Notify admin for review (if not admin posting)
      if (req.user.role !== 'admin') {
        const io = req.app.get('io');
        if (io) {
          io.emit('admin:new_job', {
            jobId: job.id,
            title: job.title,
            company: ep.company_name
          });
        }
      } else {
        // Admin can publish immediately
        await query(
          `UPDATE jobs SET status='active', published_at=NOW() WHERE id=$1`,
          [job.id]
        );
        job.status = 'active';
      }

      res.status(201).json({
        message: 'Job submitted for review. Goes live within 2 hours.',
        job
      });
    } catch (err) {
      logger.error('POST /jobs error:', err);
      res.status(500).json({ error: 'Failed to create job' });
    }
  }
);

// ── PUT /jobs/:id — Update job ────────────────────────────────
router.put('/:id', authenticate, requireRole('employer', 'admin'), async (req, res) => {
  try {
    const { rows: [job] } = await query(
      `SELECT j.*, ep.user_id FROM jobs j JOIN employer_profiles ep ON j.employer_id=ep.id WHERE j.id=$1`,
      [req.params.id]
    );
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorised to edit this job' });
    }

    const {
      title, department, industry, job_type, arrangement, location,
      experience_level, salary_min, salary_max, salary_hidden,
      description, responsibilities, requirements, nice_to_have,
      required_skills, benefits, expires_at, status
    } = req.body;

    const { rows: [updated] } = await query(`
      UPDATE jobs SET
        title=$1, department=$2, industry=$3, job_type=$4, arrangement=$5,
        location=$6, experience_level=$7, salary_min=$8, salary_max=$9,
        salary_hidden=$10, description=$11, responsibilities=$12,
        requirements=$13, nice_to_have=$14, required_skills=$15,
        benefits=$16, expires_at=$17,
        status=CASE WHEN $18::text IS NOT NULL AND $19='admin' THEN $18::job_status ELSE status END
      WHERE id=$20
      RETURNING *
    `, [
      title, department, industry, job_type, arrangement, location,
      experience_level, salary_min, salary_max, salary_hidden,
      description, responsibilities, requirements, nice_to_have,
      JSON.stringify(required_skills || []), JSON.stringify(benefits || []),
      expires_at, status, req.user.role, req.params.id
    ]);

    res.json({ message: 'Job updated', job: updated });
  } catch (err) {
    logger.error('PUT /jobs/:id error:', err);
    res.status(500).json({ error: 'Failed to update job' });
  }
});

// ── PATCH /jobs/:id/status — Pause / close / activate ────────
router.patch('/:id/status', authenticate, requireRole('employer','admin'), async (req, res) => {
  const { status } = req.body;
  const allowed = ['active','paused','closed','draft'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `Status must be one of: ${allowed.join(', ')}` });
  }

  try {
    const { rows: [job] } = await query(
      `SELECT j.id, ep.user_id FROM jobs j JOIN employer_profiles ep ON j.employer_id=ep.id WHERE j.id=$1`,
      [req.params.id]
    );
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorised' });
    }

    await query(
      `UPDATE jobs SET status=$1, closed_at=CASE WHEN $1='closed' THEN NOW() ELSE closed_at END WHERE id=$2`,
      [status, req.params.id]
    );
    res.json({ message: `Job ${status}` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update job status' });
  }
});

// ── DELETE /jobs/:id ──────────────────────────────────────────
router.delete('/:id', authenticate, requireRole('employer','admin'), async (req, res) => {
  try {
    await query(
      `UPDATE jobs SET deleted_at=NOW(), status='closed' WHERE id=$1`,
      [req.params.id]
    );
    res.json({ message: 'Job deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete job' });
  }
});

// ── GET /jobs/:id/applications — Employer sees their apps ────
router.get('/:id/applications', authenticate, requireRole('employer','admin','recruiter'), async (req, res) => {
  try {
    const { status, sort = 'created_at', page = 1, limit = 30 } = req.query;
    const offset = (parseInt(page)-1) * parseInt(limit);

    let where = 'a.job_id = $1';
    const params = [req.params.id];
    let idx = 2;

    if (status) { where += ` AND a.status = $${idx++}`; params.push(status); }

    const { rows } = await query(`
      SELECT
        a.id, a.status, a.ineza_score, a.created_at, a.interview_date,
        a.offer_amount, a.placed_at,
        cp.id AS candidate_profile_id,
        cp.first_name, cp.last_name, cp.current_title, cp.years_experience,
        cp.location, cp.profile_photo_url, cp.cv_url, cp.headline,
        u.email AS candidate_email
      FROM applications a
      JOIN candidate_profiles cp ON a.candidate_id = cp.id
      JOIN users u ON cp.user_id = u.id
      WHERE ${where}
      ORDER BY a.${sort === 'score' ? 'ineza_score DESC NULLS LAST' : 'created_at DESC'}
      LIMIT $${idx++} OFFSET $${idx++}
    `, [...params, parseInt(limit), offset]);

    res.json({ applications: rows });
  } catch (err) {
    logger.error('GET job applications error:', err);
    res.status(500).json({ error: 'Failed to fetch applications' });
  }
});

// ── GET /jobs/recommended/:candidateId — AI Matching ─────────
router.get('/recommended/:candidateId', authenticate, async (req, res) => {
  try {
    const { rows: [cp] } = await query(
      'SELECT * FROM candidate_profiles WHERE id=$1', [req.params.candidateId]
    );
    if (!cp) return res.status(404).json({ error: 'Profile not found' });

    // Simple matching: industry + skills overlap
    const { rows } = await query(`
      SELECT j.*, ep.company_name, ep.logo_url AS company_logo,
        (
          CASE WHEN j.industry = $1 THEN 30 ELSE 0 END +
          CASE WHEN j.salary_min <= $2 AND j.salary_max >= $3 THEN 20 ELSE 0 END +
          CASE WHEN j.location ILIKE $4 THEN 15 ELSE 0 END +
          CASE WHEN j.arrangement = $5 THEN 10 ELSE 0 END
        ) AS match_score
      FROM jobs j
      JOIN employer_profiles ep ON j.employer_id = ep.id
      WHERE j.status='active' AND j.deleted_at IS NULL
        AND (j.expires_at IS NULL OR j.expires_at > NOW())
        AND j.id NOT IN (
          SELECT job_id FROM applications WHERE candidate_id = $6
        )
      ORDER BY match_score DESC, j.published_at DESC
      LIMIT 10
    `, [
      cp.industry, cp.desired_salary_max || 999999999,
      cp.desired_salary_min || 0,
      `%${cp.location || 'Kigali'}%`,
      cp.preferred_arrangement || 'onsite',
      cp.id
    ]);

    res.json({ jobs: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get recommendations' });
  }
});

module.exports = router;
