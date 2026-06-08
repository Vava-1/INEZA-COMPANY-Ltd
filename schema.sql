-- ============================================================
-- INEZA PLATFORM — COMPLETE DATABASE SCHEMA
-- PostgreSQL 14+
-- Run: psql -U postgres -c "CREATE DATABASE ineza_platform;"
--      psql -U postgres -d ineza_platform -f schema.sql
-- ============================================================

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- ============================================================
-- ENUMS
-- ============================================================

CREATE TYPE user_role AS ENUM ('candidate', 'employer', 'recruiter', 'admin');
CREATE TYPE user_status AS ENUM ('active', 'inactive', 'suspended', 'pending_verification');
CREATE TYPE plan_type AS ENUM (
  'candidate_free', 'candidate_pro', 'candidate_premium',
  'employer_starter', 'employer_business', 'employer_enterprise'
);
CREATE TYPE job_status AS ENUM ('draft', 'pending_review', 'active', 'paused', 'closed', 'expired');
CREATE TYPE job_type AS ENUM ('fulltime', 'parttime', 'contract', 'freelance', 'internship', 'volunteer');
CREATE TYPE work_arrangement AS ENUM ('onsite', 'hybrid', 'remote');
CREATE TYPE application_status AS ENUM (
  'applied', 'under_review', 'shortlisted', 'interview_scheduled',
  'interview_completed', 'offer_extended', 'offer_accepted',
  'offer_declined', 'hired', 'rejected', 'withdrawn'
);
CREATE TYPE payment_status AS ENUM ('pending', 'processing', 'completed', 'failed', 'refunded', 'cancelled');
CREATE TYPE payment_method AS ENUM ('mtn_momo', 'airtel_money', 'card', 'bank_transfer');
CREATE TYPE message_status AS ENUM ('sent', 'delivered', 'read');
CREATE TYPE notification_type AS ENUM (
  'new_application', 'application_update', 'new_message',
  'job_match', 'interview_invite', 'offer', 'payment', 'system'
);

-- ============================================================
-- USERS (Base table for all user types)
-- ============================================================

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255),
  role          user_role NOT NULL DEFAULT 'candidate',
  status        user_status NOT NULL DEFAULT 'pending_verification',
  plan          plan_type NOT NULL DEFAULT 'candidate_free',
  plan_expires_at TIMESTAMPTZ,
  
  -- OAuth
  google_id     VARCHAR(255) UNIQUE,
  linkedin_id   VARCHAR(255) UNIQUE,
  
  -- Tokens
  email_verification_token VARCHAR(255),
  email_verified_at        TIMESTAMPTZ,
  password_reset_token     VARCHAR(255),
  password_reset_expires   TIMESTAMPTZ,
  refresh_token_hash       VARCHAR(255),
  
  -- Meta
  last_login_at  TIMESTAMPTZ,
  login_count    INTEGER DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  deleted_at     TIMESTAMPTZ
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_status ON users(status);
CREATE INDEX idx_users_plan ON users(plan);

-- ============================================================
-- CANDIDATE PROFILES
-- ============================================================

CREATE TABLE candidate_profiles (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- Personal
  first_name        VARCHAR(100) NOT NULL,
  last_name         VARCHAR(100) NOT NULL,
  phone             VARCHAR(30),
  nationality       VARCHAR(100),
  location          VARCHAR(255),
  linkedin_url      VARCHAR(500),
  profile_photo_url VARCHAR(500),
  
  -- Professional
  headline          VARCHAR(255),
  summary           TEXT,
  current_title     VARCHAR(200),
  current_employer  VARCHAR(200),
  years_experience  SMALLINT,
  industry          VARCHAR(100),
  
  -- Education
  highest_qualification VARCHAR(100),
  field_of_study        VARCHAR(200),
  institution           VARCHAR(200),
  graduation_year       SMALLINT,
  
  -- Job Preferences
  desired_title         VARCHAR(255),
  desired_salary_min    DECIMAL(12,2),
  desired_salary_max    DECIMAL(12,2),
  salary_currency       CHAR(3) DEFAULT 'RWF',
  salary_negotiable     BOOLEAN DEFAULT true,
  preferred_location    VARCHAR(255),
  preferred_arrangement work_arrangement DEFAULT 'onsite',
  open_to_relocation    BOOLEAN DEFAULT false,
  open_to_international BOOLEAN DEFAULT false,
  availability          VARCHAR(100) DEFAULT 'immediately',
  
  -- CV
  cv_url            VARCHAR(500),
  cv_filename       VARCHAR(255),
  cv_uploaded_at    TIMESTAMPTZ,
  
  -- Visibility & Alerts
  profile_visible   BOOLEAN DEFAULT true,
  alerts_email      BOOLEAN DEFAULT true,
  alerts_whatsapp   BOOLEAN DEFAULT false,
  
  -- Scores
  profile_score     SMALLINT DEFAULT 0,
  profile_views     INTEGER DEFAULT 0,
  
  -- Languages (JSONB array of {language, level})
  languages         JSONB DEFAULT '[]',
  
  -- Metadata
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  
  -- Full-text search vector
  search_vector     tsvector GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(first_name,'') || ' ' ||
      coalesce(last_name,'') || ' ' ||
      coalesce(headline,'') || ' ' ||
      coalesce(summary,'') || ' ' ||
      coalesce(current_title,'') || ' ' ||
      coalesce(industry,'')
    )
  ) STORED
);

CREATE INDEX idx_candidate_user ON candidate_profiles(user_id);
CREATE INDEX idx_candidate_industry ON candidate_profiles(industry);
CREATE INDEX idx_candidate_location ON candidate_profiles(location);
CREATE INDEX idx_candidate_search ON candidate_profiles USING GIN(search_vector);

-- ============================================================
-- CANDIDATE SKILLS
-- ============================================================

CREATE TABLE candidate_skills (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  candidate_id UUID NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
  skill_name   VARCHAR(100) NOT NULL,
  skill_level  VARCHAR(50), -- beginner, intermediate, advanced, expert
  years        SMALLINT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_candidate_skills ON candidate_skills(candidate_id);
CREATE INDEX idx_skill_name ON candidate_skills(skill_name);

-- ============================================================
-- WORK EXPERIENCE
-- ============================================================

CREATE TABLE work_experiences (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  candidate_id  UUID NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
  job_title     VARCHAR(200) NOT NULL,
  company       VARCHAR(200) NOT NULL,
  location      VARCHAR(255),
  start_date    DATE NOT NULL,
  end_date      DATE,
  is_current    BOOLEAN DEFAULT false,
  description   TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_work_exp_candidate ON work_experiences(candidate_id);

-- ============================================================
-- EMPLOYER PROFILES
-- ============================================================

CREATE TABLE employer_profiles (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  company_name        VARCHAR(255) NOT NULL,
  company_slug        VARCHAR(255) UNIQUE,
  company_size        VARCHAR(50),
  industry            VARCHAR(100),
  website_url         VARCHAR(500),
  description         TEXT,
  logo_url            VARCHAR(500),
  cover_image_url     VARCHAR(500),
  
  -- Contact
  contact_name        VARCHAR(200),
  contact_title       VARCHAR(200),
  phone               VARCHAR(30),
  address             TEXT,
  city                VARCHAR(100) DEFAULT 'Kigali',
  country             VARCHAR(100) DEFAULT 'Rwanda',
  
  -- Verification
  is_verified         BOOLEAN DEFAULT false,
  verified_at         TIMESTAMPTZ,
  
  -- Stats
  total_jobs_posted   INTEGER DEFAULT 0,
  total_hires         INTEGER DEFAULT 0,
  
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_employer_user ON employer_profiles(user_id);
CREATE INDEX idx_employer_industry ON employer_profiles(industry);
CREATE UNIQUE INDEX idx_employer_slug ON employer_profiles(company_slug);

-- ============================================================
-- JOBS
-- ============================================================

CREATE TABLE jobs (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employer_id       UUID NOT NULL REFERENCES employer_profiles(id) ON DELETE CASCADE,
  
  -- Basic Info
  title             VARCHAR(255) NOT NULL,
  slug              VARCHAR(300),
  department        VARCHAR(200),
  industry          VARCHAR(100),
  
  -- Type & Location
  job_type          job_type NOT NULL DEFAULT 'fulltime',
  arrangement       work_arrangement DEFAULT 'onsite',
  location          VARCHAR(255),
  is_remote         BOOLEAN DEFAULT false,
  
  -- Level
  experience_level  VARCHAR(100),
  min_years_exp     SMALLINT,
  positions_count   SMALLINT DEFAULT 1,
  
  -- Salary
  salary_min        DECIMAL(12,2),
  salary_max        DECIMAL(12,2),
  salary_currency   CHAR(3) DEFAULT 'RWF',
  salary_hidden     BOOLEAN DEFAULT false,
  benefits          JSONB DEFAULT '[]',
  
  -- Content
  description       TEXT NOT NULL,
  responsibilities  TEXT,
  requirements      TEXT,
  nice_to_have      TEXT,
  
  -- Skills
  required_skills   JSONB DEFAULT '[]',
  required_languages JSONB DEFAULT '[]',
  
  -- Status & Dates
  status            job_status DEFAULT 'pending_review',
  featured          BOOLEAN DEFAULT false,
  urgent            BOOLEAN DEFAULT false,
  published_at      TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ,
  closed_at         TIMESTAMPTZ,
  
  -- Internal
  ineza_managed     BOOLEAN DEFAULT true,
  confidential      BOOLEAN DEFAULT false,
  ineza_ref         VARCHAR(50) UNIQUE,
  
  -- Stats
  views_count       INTEGER DEFAULT 0,
  applications_count INTEGER DEFAULT 0,
  
  -- Search
  search_vector     tsvector GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(title,'') || ' ' ||
      coalesce(description,'') || ' ' ||
      coalesce(department,'') || ' ' ||
      coalesce(industry,'') || ' ' ||
      coalesce(location,'')
    )
  ) STORED,
  
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  deleted_at        TIMESTAMPTZ
);

CREATE INDEX idx_jobs_employer ON jobs(employer_id);
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_industry ON jobs(industry);
CREATE INDEX idx_jobs_location ON jobs(location);
CREATE INDEX idx_jobs_featured ON jobs(featured) WHERE featured = true;
CREATE INDEX idx_jobs_published ON jobs(published_at DESC);
CREATE INDEX idx_jobs_search ON jobs USING GIN(search_vector);
CREATE INDEX idx_jobs_expires ON jobs(expires_at);

-- ============================================================
-- APPLICATIONS
-- ============================================================

CREATE TABLE applications (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  candidate_id    UUID NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
  
  -- Status tracking
  status          application_status DEFAULT 'applied',
  status_updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Submission
  cover_letter    TEXT,
  cv_url          VARCHAR(500),
  portfolio_url   VARCHAR(500),
  
  -- Ineza internal
  ineza_score     SMALLINT,    -- 0-100 recruiter quality score
  ineza_notes     TEXT,        -- Internal recruiter notes
  shortlisted_at  TIMESTAMPTZ,
  shortlisted_by  UUID REFERENCES users(id),
  
  -- Interview
  interview_date  TIMESTAMPTZ,
  interview_type  VARCHAR(50),
  interview_notes TEXT,
  
  -- Offer
  offer_amount    DECIMAL(12,2),
  offer_currency  CHAR(3),
  offer_sent_at   TIMESTAMPTZ,
  offer_expires   TIMESTAMPTZ,
  
  -- Hire
  start_date      DATE,
  placed_at       TIMESTAMPTZ,
  placement_fee   DECIMAL(12,2),
  
  -- Metadata
  source          VARCHAR(100) DEFAULT 'platform',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(job_id, candidate_id)
);

CREATE INDEX idx_app_job ON applications(job_id);
CREATE INDEX idx_app_candidate ON applications(candidate_id);
CREATE INDEX idx_app_status ON applications(status);
CREATE INDEX idx_app_created ON applications(created_at DESC);

-- ============================================================
-- SAVED JOBS
-- ============================================================

CREATE TABLE saved_jobs (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  candidate_id UUID NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
  job_id       UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(candidate_id, job_id)
);

CREATE INDEX idx_saved_candidate ON saved_jobs(candidate_id);

-- ============================================================
-- JOB ALERTS
-- ============================================================

CREATE TABLE job_alerts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  candidate_id    UUID NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
  name            VARCHAR(200),
  keywords        VARCHAR(500),
  location        VARCHAR(255),
  industry        VARCHAR(100),
  job_type        job_type,
  salary_min      DECIMAL(12,2),
  frequency       VARCHAR(20) DEFAULT 'daily',
  is_active       BOOLEAN DEFAULT true,
  last_sent_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_alerts_candidate ON job_alerts(candidate_id);
CREATE INDEX idx_alerts_active ON job_alerts(is_active) WHERE is_active = true;

-- ============================================================
-- PAYMENTS / SUBSCRIPTIONS
-- ============================================================

CREATE TABLE payments (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES users(id),
  
  -- What was paid for
  plan              plan_type,
  job_id            UUID REFERENCES jobs(id),
  payment_type      VARCHAR(50) NOT NULL, -- 'subscription', 'job_posting', 'upgrade', 'placement_fee'
  description       VARCHAR(500),
  
  -- Amounts
  amount            DECIMAL(12,2) NOT NULL,
  currency          CHAR(3) DEFAULT 'RWF',
  
  -- Payment method
  method            payment_method NOT NULL,
  status            payment_status DEFAULT 'pending',
  
  -- Gateway references
  gateway           VARCHAR(50),  -- 'mtn_momo', 'airtel', 'stripe'
  gateway_ref       VARCHAR(255), -- Gateway transaction ID
  gateway_response  JSONB,
  
  -- MoMo specific
  momo_phone        VARCHAR(30),
  momo_ref_id       UUID,
  
  -- Stripe specific
  stripe_payment_intent VARCHAR(255),
  stripe_charge_id      VARCHAR(255),
  
  -- Timestamps
  initiated_at      TIMESTAMPTZ DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  failed_at         TIMESTAMPTZ,
  refunded_at       TIMESTAMPTZ,
  refund_reason     TEXT,
  
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_payments_user ON payments(user_id);
CREATE INDEX idx_payments_status ON payments(status);
CREATE INDEX idx_payments_created ON payments(created_at DESC);
CREATE INDEX idx_payments_gateway_ref ON payments(gateway_ref);

-- ============================================================
-- SUBSCRIPTIONS
-- ============================================================

CREATE TABLE subscriptions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID UNIQUE NOT NULL REFERENCES users(id),
  plan            plan_type NOT NULL,
  status          VARCHAR(20) DEFAULT 'active', -- active, cancelled, expired, paused
  
  started_at      TIMESTAMPTZ DEFAULT NOW(),
  current_period_start TIMESTAMPTZ DEFAULT NOW(),
  current_period_end   TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  cancel_reason   TEXT,
  
  auto_renew      BOOLEAN DEFAULT true,
  payment_method  payment_method,
  
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sub_user ON subscriptions(user_id);
CREATE INDEX idx_sub_status ON subscriptions(status);
CREATE INDEX idx_sub_period_end ON subscriptions(current_period_end);

-- ============================================================
-- MESSAGES
-- ============================================================

CREATE TABLE conversations (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  participant_1 UUID NOT NULL REFERENCES users(id),
  participant_2 UUID NOT NULL REFERENCES users(id),
  job_id        UUID REFERENCES jobs(id),
  last_message_at TIMESTAMPTZ DEFAULT NOW(),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(participant_1, participant_2, job_id)
);

CREATE INDEX idx_conv_p1 ON conversations(participant_1);
CREATE INDEX idx_conv_p2 ON conversations(participant_2);
CREATE INDEX idx_conv_last ON conversations(last_message_at DESC);

CREATE TABLE messages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       UUID NOT NULL REFERENCES users(id),
  body            TEXT NOT NULL,
  status          message_status DEFAULT 'sent',
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_messages_conv ON messages(conversation_id);
CREATE INDEX idx_messages_sender ON messages(sender_id);
CREATE INDEX idx_messages_created ON messages(created_at DESC);

-- ============================================================
-- NOTIFICATIONS
-- ============================================================

CREATE TABLE notifications (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         notification_type NOT NULL,
  title        VARCHAR(255) NOT NULL,
  body         TEXT,
  data         JSONB DEFAULT '{}',
  read_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notif_user ON notifications(user_id);
CREATE INDEX idx_notif_unread ON notifications(user_id, read_at) WHERE read_at IS NULL;
CREATE INDEX idx_notif_created ON notifications(created_at DESC);

-- ============================================================
-- REVIEWS (Employer reviews)
-- ============================================================

CREATE TABLE employer_reviews (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employer_id     UUID NOT NULL REFERENCES employer_profiles(id) ON DELETE CASCADE,
  candidate_id    UUID NOT NULL REFERENCES candidate_profiles(id),
  rating          SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title           VARCHAR(200),
  body            TEXT,
  pros            TEXT,
  cons            TEXT,
  is_anonymous    BOOLEAN DEFAULT false,
  is_verified     BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(employer_id, candidate_id)
);

CREATE INDEX idx_reviews_employer ON employer_reviews(employer_id);

-- ============================================================
-- AUDIT LOG
-- ============================================================

CREATE TABLE audit_logs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES users(id),
  action      VARCHAR(100) NOT NULL,
  entity_type VARCHAR(100),
  entity_id   UUID,
  old_data    JSONB,
  new_data    JSONB,
  ip_address  INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_user ON audit_logs(user_id);
CREATE INDEX idx_audit_action ON audit_logs(action);
CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);

-- ============================================================
-- ANALYTICS EVENTS
-- ============================================================

CREATE TABLE analytics_events (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_type  VARCHAR(100) NOT NULL,
  user_id     UUID REFERENCES users(id),
  job_id      UUID REFERENCES jobs(id),
  data        JSONB DEFAULT '{}',
  ip_address  INET,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_analytics_type ON analytics_events(event_type);
CREATE INDEX idx_analytics_created ON analytics_events(created_at DESC);
CREATE INDEX idx_analytics_job ON analytics_events(job_id);

-- ============================================================
-- TRIGGERS: auto-update updated_at
-- ============================================================

CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_candidate_updated_at BEFORE UPDATE ON candidate_profiles FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_employer_updated_at BEFORE UPDATE ON employer_profiles FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_jobs_updated_at BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_app_updated_at BEFORE UPDATE ON applications FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_sub_updated_at BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ============================================================
-- TRIGGER: auto-generate ineza_ref for jobs
-- ============================================================

CREATE OR REPLACE FUNCTION generate_ineza_ref()
RETURNS TRIGGER AS $$
BEGIN
  NEW.ineza_ref := 'INA-' || TO_CHAR(NOW(), 'YYYY') || '-' ||
    LPAD(NEXTVAL('job_ref_seq')::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE SEQUENCE job_ref_seq START 1000;
CREATE TRIGGER auto_ineza_ref BEFORE INSERT ON jobs FOR EACH ROW
  WHEN (NEW.ineza_ref IS NULL) EXECUTE FUNCTION generate_ineza_ref();

-- ============================================================
-- TRIGGER: update applications_count on jobs
-- ============================================================

CREATE OR REPLACE FUNCTION update_job_app_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE jobs SET applications_count = applications_count + 1 WHERE id = NEW.job_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE jobs SET applications_count = GREATEST(applications_count - 1, 0) WHERE id = OLD.job_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_app_count AFTER INSERT OR DELETE ON applications
  FOR EACH ROW EXECUTE FUNCTION update_job_app_count();

-- ============================================================
-- VIEWS
-- ============================================================

-- Active jobs with employer info
CREATE VIEW v_active_jobs AS
SELECT
  j.*,
  ep.company_name,
  ep.company_slug,
  ep.logo_url AS company_logo,
  ep.is_verified AS company_verified,
  ep.city AS company_city
FROM jobs j
JOIN employer_profiles ep ON j.employer_id = ep.id
WHERE j.status = 'active'
  AND j.deleted_at IS NULL
  AND (j.expires_at IS NULL OR j.expires_at > NOW());

-- Candidate overview
CREATE VIEW v_candidates AS
SELECT
  u.id AS user_id,
  u.email,
  u.plan,
  u.status AS account_status,
  cp.*
FROM users u
JOIN candidate_profiles cp ON u.id = cp.user_id
WHERE u.deleted_at IS NULL AND u.role = 'candidate';

-- Application pipeline for employers
CREATE VIEW v_application_pipeline AS
SELECT
  a.*,
  j.title AS job_title,
  j.employer_id,
  cp.first_name || ' ' || cp.last_name AS candidate_name,
  cp.current_title AS candidate_title,
  cp.profile_photo_url,
  cp.cv_url,
  u.email AS candidate_email
FROM applications a
JOIN jobs j ON a.job_id = j.id
JOIN candidate_profiles cp ON a.candidate_id = cp.id
JOIN users u ON cp.user_id = u.id;

-- Monthly revenue summary
CREATE VIEW v_monthly_revenue AS
SELECT
  DATE_TRUNC('month', created_at) AS month,
  COUNT(*) AS transaction_count,
  SUM(amount) FILTER (WHERE currency = 'RWF') AS rwf_revenue,
  SUM(amount) FILTER (WHERE currency = 'USD') AS usd_revenue,
  SUM(CASE WHEN payment_type = 'subscription' THEN amount ELSE 0 END) AS subscription_revenue,
  SUM(CASE WHEN payment_type = 'job_posting' THEN amount ELSE 0 END) AS posting_revenue,
  SUM(CASE WHEN payment_type = 'placement_fee' THEN amount ELSE 0 END) AS placement_revenue
FROM payments
WHERE status = 'completed'
GROUP BY DATE_TRUNC('month', created_at)
ORDER BY month DESC;

-- ============================================================
-- SAMPLE DATA (Development only)
-- ============================================================

-- Admin user (password: Admin@Ineza2025!)
INSERT INTO users (email, password_hash, role, status, plan, email_verified_at)
VALUES (
  'admin@inezaagencies.rw',
  '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMDJos6cT/kzN0YWfGdJi0m1q.',
  'admin', 'active', 'employer_enterprise', NOW()
);

COMMENT ON TABLE users IS 'Core user accounts for all roles';
COMMENT ON TABLE jobs IS 'Job postings managed by employers through Ineza platform';
COMMENT ON TABLE applications IS 'Candidate applications with full pipeline tracking';
COMMENT ON TABLE payments IS 'All payment transactions with gateway references';
