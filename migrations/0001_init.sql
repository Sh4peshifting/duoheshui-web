PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  sid_hash TEXT PRIMARY KEY,
  mobile_enc TEXT NOT NULL,
  upstream_token_enc TEXT NOT NULL,
  balance TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  sid_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('hot', 'cold')),
  label TEXT,
  device_key_enc TEXT NOT NULL,
  device_fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (sid_hash, kind),
  FOREIGN KEY (sid_hash) REFERENCES sessions(sid_hash) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS command_requests (
  sid_hash TEXT NOT NULL,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('hot', 'cold')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (sid_hash, request_id),
  FOREIGN KEY (sid_hash) REFERENCES sessions(sid_hash) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sms_requests (
  mobile_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_command_requests_created ON command_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_command_requests_cooldown ON command_requests(sid_hash, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_sms_requests_mobile_created ON sms_requests(mobile_hash, created_at);
PRAGMA optimize;
