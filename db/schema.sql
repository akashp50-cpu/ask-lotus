-- Ask Lotus schema. Safe to run more than once.

CREATE TABLE IF NOT EXISTS hotels (
  id          TEXT PRIMARY KEY,               -- short code, e.g. 'hop'
  name        TEXT NOT NULL,
  ready       BOOLEAN NOT NULL DEFAULT FALSE, -- has SOPs and is open to staff (kept in sync: ready = setup = 'live')
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Multi-hotel columns (idempotent).
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS brand   TEXT  NOT NULL DEFAULT 'independent';  -- 'hilton' | 'independent'
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS system  TEXT  NOT NULL DEFAULT 'hotelkey';     -- 'pep' | 'hotelkey'
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS setup   TEXT  NOT NULL DEFAULT 'new';          -- 'new' | 'setup' | 'live'
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS answers JSONB NOT NULL DEFAULT '{}';           -- setup answers {breakfast,pool,pets,laundry,market}
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS details JSONB NOT NULL DEFAULT '{}';           -- hotel details, key -> value

CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  username        TEXT,                        -- sign-in name, stored lower-case (NOT NULL enforced below)
  email           TEXT UNIQUE,                 -- optional, stored lower-case
  role            TEXT NOT NULL CHECK (role IN ('Front Desk','Manager','GM','Owner')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','off')),
  password_hash   TEXT NOT NULL,
  must_change_pw  BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Username sign-in (idempotent; also upgrades databases created with email-only users).
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
UPDATE users SET email = NULL WHERE email IS NOT NULL AND btrim(email) = '';
DO $$
DECLARE r RECORD; base TEXT; cand TEXT;
BEGIN
  FOR r IN SELECT id, email FROM users WHERE username IS NULL OR btrim(username) = '' ORDER BY id LOOP
    base := regexp_replace(lower(split_part(COALESCE(r.email, ''), '@', 1)), '[^a-z0-9._-]', '', 'g');
    IF base = '' THEN base := 'user'; END IF;
    cand := base;
    IF EXISTS (SELECT 1 FROM users WHERE lower(username) = cand AND id <> r.id) THEN
      cand := base || r.id::text;
    END IF;
    UPDATE users SET username = cand WHERE id = r.id;
  END LOOP;
END $$;
ALTER TABLE users ALTER COLUMN username SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username));

CREATE TABLE IF NOT EXISTS user_hotels (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hotel_id  TEXT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, hotel_id)
);

CREATE TABLE IF NOT EXISTS categories (
  hotel_id  TEXT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  prefix    TEXT NOT NULL,                    -- SOP id prefix, e.g. 'CI'
  sort      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hotel_id, name)
);

CREATE TABLE IF NOT EXISTS sops (
  hotel_id    TEXT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  id          TEXT NOT NULL,                  -- e.g. 'CI-01'
  category    TEXT NOT NULL,
  title       TEXT NOT NULL,
  steps       JSONB NOT NULL DEFAULT '[]',    -- [{ "t": "text", "img": "image-id" | null }]
  script      TEXT NOT NULL DEFAULT '',
  flag        TEXT NOT NULL DEFAULT '',
  keywords    TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live','draft','off')),
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (hotel_id, id)
);

-- Link each hotel copy to the Owner's master library (null = hotel-only SOP).
ALTER TABLE sops ADD COLUMN IF NOT EXISTS master_id      TEXT;
ALTER TABLE sops ADD COLUMN IF NOT EXISTS master_version INTEGER;
ALTER TABLE sops ADD COLUMN IF NOT EXISTS kept           BOOLEAN NOT NULL DEFAULT FALSE;

-- Widen the status check to include 'off'. Replaces the old constraint only when it lacks 'off'.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'sops'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%status%' AND pg_get_constraintdef(oid) NOT LIKE '%off%' LOOP
    EXECUTE format('ALTER TABLE sops DROP CONSTRAINT %I', r.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'sops'::regclass AND contype = 'c'
                    AND pg_get_constraintdef(oid) LIKE '%status%' AND pg_get_constraintdef(oid) LIKE '%off%') THEN
    ALTER TABLE sops ADD CONSTRAINT sops_status_check CHECK (status IN ('live','draft','off'));
  END IF;
END $$;

-- Roles: Front Desk < Manager < GM < Owner. Old 'Admin' becomes 'Owner'.
-- Drop the old check first, move the rows, then add the new check.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'users'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%role%' AND pg_get_constraintdef(oid) NOT LIKE '%Owner%' LOOP
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', r.conname);
  END LOOP;
  UPDATE users SET role = 'Owner' WHERE role = 'Admin';
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'users'::regclass AND contype = 'c'
                    AND pg_get_constraintdef(oid) LIKE '%role%' AND pg_get_constraintdef(oid) LIKE '%Owner%') THEN
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('Front Desk','Manager','GM','Owner'));
  END IF;
END $$;

-- The Owner's master library. Hotels get their own copy of each SOP (sops.master_id).
CREATE TABLE IF NOT EXISTS master_categories (
  name    TEXT PRIMARY KEY,
  prefix  TEXT NOT NULL,
  sort    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS master_sops (
  id          TEXT PRIMARY KEY,                -- same ids as before, e.g. 'CI-01'
  category    TEXT NOT NULL,
  title       TEXT NOT NULL,
  steps       JSONB NOT NULL DEFAULT '[]',     -- [{ "t": PEP/default text, "hk": HotelKey text | null, "img": id | null }]
  script      TEXT NOT NULL DEFAULT '',
  script_hk   TEXT,
  flag        TEXT NOT NULL DEFAULT '',
  flag_hk     TEXT,
  keywords    TEXT NOT NULL DEFAULT '',
  applies     TEXT NOT NULL DEFAULT 'all' CHECK (applies IN ('all','hilton')),
  requires    TEXT CHECK (requires IN ('breakfast','pool','pets','laundry','market')),
  hk_status   TEXT NOT NULL DEFAULT 'same' CHECK (hk_status IN ('same','draft','approved')),
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- 'live' = offered to hotels; 'draft' = being written (imports and new SOPs start here), not offered until the Owner publishes it.
ALTER TABLE master_sops ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'live';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'master_sops'::regclass AND conname = 'master_sops_status_check') THEN
    ALTER TABLE master_sops ADD CONSTRAINT master_sops_status_check CHECK (status IN ('live','draft'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS master_history (
  id          SERIAL PRIMARY KEY,
  master_id   TEXT NOT NULL,
  version     INTEGER NOT NULL,
  snapshot    JSONB NOT NULL,
  changed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS master_history_idx ON master_history (master_id, version);

-- Hotel detail names the master library expects (e.g. "Breakfast hours"), shown in setup and the master editor.
CREATE TABLE IF NOT EXISTS master_details (
  key      TEXT PRIMARY KEY,
  example  TEXT NOT NULL DEFAULT '',
  sort     INTEGER NOT NULL DEFAULT 0
);
-- Amenity a detail belongs to ('breakfast','pool','pets','laundry','market'), null = general hotel detail.
ALTER TABLE master_details ADD COLUMN IF NOT EXISTS grp TEXT;

-- Small named JSON values that come with the master file (e.g. 'setup_defaults': the wording the setup yes/no questions fill in).
CREATE TABLE IF NOT EXISTS master_meta (
  key    TEXT PRIMARY KEY,
  value  JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS sop_history (
  id          SERIAL PRIMARY KEY,
  hotel_id    TEXT NOT NULL,
  sop_id      TEXT NOT NULL,
  version     INTEGER NOT NULL,
  snapshot    JSONB NOT NULL,
  changed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS images (
  id          TEXT PRIMARY KEY,
  hotel_id    TEXT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  mime        TEXT NOT NULL,
  data        BYTEA NOT NULL,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contacts (
  id        SERIAL PRIMARY KEY,
  hotel_id  TEXT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  role      TEXT NOT NULL,
  name      TEXT NOT NULL,
  phone     TEXT NOT NULL,
  UNIQUE (hotel_id, role)
);

CREATE TABLE IF NOT EXISTS routes (
  hotel_id    TEXT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  label       TEXT NOT NULL,
  sub         TEXT NOT NULL DEFAULT '',
  first_role  TEXT NOT NULL,
  then_role   TEXT NOT NULL DEFAULT '',
  joiner      TEXT NOT NULL DEFAULT 'then' CHECK (joiner IN ('then','and')),
  sort        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hotel_id, id)
);

CREATE TABLE IF NOT EXISTS questions (
  id          SERIAL PRIMARY KEY,
  hotel_id    TEXT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  question    TEXT NOT NULL,
  sop_id      TEXT,
  matched_by  TEXT NOT NULL DEFAULT 'keyword',  -- 'keyword' | 'ai' | 'none'
  feedback    TEXT CHECK (feedback IN ('y','n')),
  dismissed   BOOLEAN NOT NULL DEFAULT FALSE,
  asked_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS questions_hotel_time ON questions (hotel_id, asked_at DESC);

-- One row of app-wide settings (AI provider etc.). The API key is stored encrypted.
CREATE TABLE IF NOT EXISTS settings (
  id            INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  provider      TEXT NOT NULL DEFAULT 'none',
  model         TEXT NOT NULL DEFAULT '',
  base_url      TEXT NOT NULL DEFAULT '',
  key_enc       TEXT,
  key_last4     TEXT,
  key_added_by  TEXT,
  key_added_at  TIMESTAMPTZ,
  source_only   BOOLEAN NOT NULL DEFAULT TRUE,
  show_source   BOOLEAN NOT NULL DEFAULT TRUE,
  fallback      BOOLEAN NOT NULL DEFAULT TRUE
);
INSERT INTO settings (id) VALUES (1) ON CONFLICT DO NOTHING;

-- Sessions (connect-pg-simple)
CREATE TABLE IF NOT EXISTS "session" (
  "sid"    VARCHAR NOT NULL PRIMARY KEY,
  "sess"   JSON NOT NULL,
  "expire" TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

-- Import batches (Owner -> master library, GM -> their hotel). The review survives a reload.
-- hotel_id NULL = the master library. result = { matches, new, details, meta }, each item carrying its own "state".
CREATE TABLE IF NOT EXISTS imports (
  id          SERIAL PRIMARY KEY,
  hotel_id    TEXT REFERENCES hotels(id) ON DELETE CASCADE,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  filenames   TEXT[] NOT NULL DEFAULT '{}',
  kind        TEXT NOT NULL DEFAULT 'ai' CHECK (kind IN ('ai','sheet')),
  status      TEXT NOT NULL DEFAULT 'review' CHECK (status IN ('review','done','discarded')),
  result      JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS imports_hotel_idx ON imports (hotel_id, created_at DESC);
