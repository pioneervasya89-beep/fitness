CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  first_name TEXT,
  username TEXT,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS states (
  user_id INTEGER PRIMARY KEY,
  data TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS links (
  coach_id INTEGER NOT NULL,
  client_id INTEGER NOT NULL,
  created_at INTEGER,
  PRIMARY KEY (coach_id, client_id)
);
CREATE INDEX IF NOT EXISTS links_client ON links (client_id);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  client_id INTEGER NOT NULL,
  created_at INTEGER
);
