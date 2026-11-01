/**
 * Full schema. Every statement is idempotent so migrate() can run on every boot.
 * Money is stored as integer cents everywhere.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text NOT NULL UNIQUE,
  password_hash       text NOT NULL,
  display_name        text NOT NULL,
  date_of_birth       date NOT NULL,
  role_mode           text NOT NULL DEFAULT 'both'
                      CHECK (role_mode IN ('need_help', 'can_help', 'both')),
  city                text NOT NULL DEFAULT '',
  state               text NOT NULL DEFAULT '',
  zip                 text NOT NULL DEFAULT '',
  bio                 text NOT NULL DEFAULT '',
  availability        text NOT NULL DEFAULT '',
  skills              text[] NOT NULL DEFAULT '{}',
  tools               text[] NOT NULL DEFAULT '{}',
  verification_status text NOT NULL DEFAULT 'unverified'
                      CHECK (verification_status IN ('unverified', 'pending', 'verified', 'rejected')),
  is_admin            boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS founder_title text;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id      uuid NOT NULL REFERENCES users(id),
  title             text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  description       text NOT NULL CHECK (char_length(description) BETWEEN 10 AND 4000),
  category          text NOT NULL,
  help_type         text NOT NULL DEFAULT 'paid' CHECK (help_type IN ('paid', 'volunteer')),
  required_skills   text[] NOT NULL DEFAULT '{}',
  tools_needed      text[] NOT NULL DEFAULT '{}',
  city              text NOT NULL,
  state             text NOT NULL DEFAULT '',
  zip               text NOT NULL,
  address_private   text NOT NULL DEFAULT '',
  schedule_type     text NOT NULL CHECK (schedule_type IN
                      ('asap', 'today', 'tomorrow', 'this_week', 'specific_date',
                       'flexible', 'recurring', 'appointment')),
  scheduled_for     timestamptz,
  schedule_note     text NOT NULL DEFAULT '',
  helpers_needed    integer NOT NULL CHECK (helpers_needed BETWEEN 1 AND 3),
  helper_count_unsure boolean NOT NULL DEFAULT false,
  supplies_provided text NOT NULL DEFAULT 'unsure'
                      CHECK (supplies_provided IN ('requester', 'helper', 'either', 'unsure')),
  supplies_note    text NOT NULL DEFAULT '',
  price_cents       integer NOT NULL CHECK (price_cents >= 0),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN (
                      'open', 'accepted', 'in_progress', 'awaiting_confirmation',
                      'continue_later', 'paused_safety', 'completed',
                      'partially_completed', 'cancelled', 'disputed')),
  proposed_outcome      text,
  proposed_earned_cents integer,
  earned_cents         integer NOT NULL DEFAULT 0,
  completed_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_open_idx ON tasks (status, zip);
CREATE INDEX IF NOT EXISTS tasks_requester_idx ON tasks (requester_id);

CREATE TABLE IF NOT EXISTS task_assignments (
  task_id      uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  helper_id    uuid NOT NULL REFERENCES users(id),
  status       text NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'withdrawn', 'completed', 'cancelled')),
  accepted_at  timestamptz NOT NULL DEFAULT now(),
  arrived_at   timestamptz,
  ended_at     timestamptz,
  PRIMARY KEY (task_id, helper_id)
);
CREATE INDEX IF NOT EXISTS assignments_helper_idx ON task_assignments (helper_id);

-- Append-only ledger for test-mode money movement. Balance = sum of the
-- 'hold' events minus every event that moves money out of escrow.
CREATE TABLE IF NOT EXISTS payment_events (
  id          bigserial PRIMARY KEY,
  task_id     uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  helper_id   uuid REFERENCES users(id),
  kind        text NOT NULL CHECK (kind IN
                ('hold', 'release_helper', 'platform_fee', 'refund')),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Snapshot of the official agreement each time it changes.
CREATE TABLE IF NOT EXISTS agreement_history (
  id          bigserial PRIMARY KEY,
  task_id     uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  snapshot    jsonb NOT NULL,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, version)
);

CREATE TABLE IF NOT EXISTS change_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  requested_by  uuid NOT NULL REFERENCES users(id),
  kind          text NOT NULL CHECK (kind IN
                  ('price', 'helper_count', 'schedule', 'location', 'supplies', 'scope')),
  proposed      jsonb NOT NULL,
  reason        text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'declined')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz
);

CREATE TABLE IF NOT EXISTS safety_reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id      uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  reporter_id  uuid NOT NULL REFERENCES users(id),
  description  text NOT NULL CHECK (char_length(description) BETWEEN 5 AND 4000),
  stopped_task boolean NOT NULL DEFAULT false,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reviews (
  task_id      uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  reviewer_id  uuid NOT NULL REFERENCES users(id),
  subject_id   uuid NOT NULL REFERENCES users(id),
  rating       integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment      text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, reviewer_id, subject_id)
);
`;
