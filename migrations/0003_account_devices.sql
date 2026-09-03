PRAGMA foreign_keys = OFF;

ALTER TABLE sessions ADD COLUMN account_hash TEXT;

CREATE TABLE saved_devices_by_account (
  id TEXT PRIMARY KEY,
  account_hash TEXT NOT NULL,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  hot_device_key_enc TEXT,
  hot_device_fingerprint TEXT,
  cold_device_key_enc TEXT,
  cold_device_fingerprint TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (hot_device_key_enc IS NOT NULL OR cold_device_key_enc IS NOT NULL)
);

INSERT INTO saved_devices_by_account (
  id,
  account_hash,
  label,
  enabled,
  hot_device_key_enc,
  hot_device_fingerprint,
  cold_device_key_enc,
  cold_device_fingerprint,
  created_at,
  updated_at
)
SELECT
  id,
  sid_hash,
  label,
  enabled,
  hot_device_key_enc,
  hot_device_fingerprint,
  cold_device_key_enc,
  cold_device_fingerprint,
  created_at,
  updated_at
FROM saved_devices;

DROP TABLE saved_devices;
ALTER TABLE saved_devices_by_account RENAME TO saved_devices;

CREATE UNIQUE INDEX idx_saved_devices_one_active
ON saved_devices(account_hash) WHERE enabled = 1;

CREATE INDEX idx_saved_devices_account
ON saved_devices(account_hash, created_at);

PRAGMA foreign_keys = ON;
PRAGMA optimize;
