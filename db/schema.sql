-- Ask Lotus schema. Safe to run more than once.

CREATE TABLE IF NOT EXISTS hotels (
  id          TEXT PRIMARY KEY,               -- short code, e.g. 'hop'
  name        TEXT NOT NULL,
  ready       BOOLEAN NOT NULL DEFAULT FALSE, -- has SOPs and is open to staff
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE,        -- stored lower-case
  role            TEXT NOT NULL CHECK (role IN ('Front Desk','Manager','Admin')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','off')),
  password_hash   TEXT NOT NULL,
  must_change_pw  BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
  status      TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live','draft')),
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (hotel_id, id)
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
