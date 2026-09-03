PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS saved_devices (
  id TEXT PRIMARY KEY,
  sid_hash TEXT NOT NULL,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  hot_device_key_enc TEXT,
  hot_device_fingerprint TEXT,
  cold_device_key_enc TEXT,
  cold_device_fingerprint TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (hot_device_key_enc IS NOT NULL OR cold_device_key_enc IS NOT NULL),
  FOREIGN KEY (sid_hash) REFERENCES sessions(sid_hash) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_devices_one_active
ON saved_devices(sid_hash) WHERE enabled = 1;

CREATE INDEX IF NOT EXISTS idx_saved_devices_account
ON saved_devices(sid_hash, created_at);

INSERT INTO saved_devices (
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
)
SELECT
  'legacy-' || lower(hex(randomblob(16))),
  d.sid_hash,
  COALESCE(NULLIF(MAX(d.label), ''), '原有设备'),
  1,
  MAX(CASE WHEN d.kind = 'hot' THEN d.device_key_enc END),
  MAX(CASE WHEN d.kind = 'hot' THEN d.device_fingerprint END),
  MAX(CASE WHEN d.kind = 'cold' THEN d.device_key_enc END),
  MAX(CASE WHEN d.kind = 'cold' THEN d.device_fingerprint END),
  MIN(d.created_at),
  MAX(d.updated_at)
FROM devices AS d
WHERE NOT EXISTS (SELECT 1 FROM saved_devices AS current WHERE current.sid_hash = d.sid_hash)
GROUP BY d.sid_hash;

PRAGMA optimize;
