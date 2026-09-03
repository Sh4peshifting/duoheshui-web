import { decryptField, encryptField } from "./storage-crypto";
import type { DeviceKind, DeviceRecord, SessionRecord, Store } from "./types";

type SessionRow = {
  sid_hash: string;
  account_hash: string | null;
  mobile_enc: string;
  upstream_token_enc: string;
  balance: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
};

type DeviceRow = {
  id: string;
  account_hash: string;
  label: string;
  enabled: number;
  hot_device_key_enc: string | null;
  hot_device_fingerprint: string | null;
  cold_device_key_enc: string | null;
  cold_device_fingerprint: string | null;
  created_at: number;
  updated_at: number;
};

export class D1Store implements Store {
  constructor(private readonly db: D1Database, private readonly secret: string) {}

  async cleanup(now: number): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
      this.db.prepare("DELETE FROM command_requests WHERE created_at <= ?").bind(now - 600_000),
      this.db.prepare("DELETE FROM sms_requests WHERE created_at <= ?").bind(now - 3_600_000),
    ]);
  }

  async reserveSendCode(mobileHash: string, now: number): Promise<boolean> {
    const inserted = await this.db.prepare(
      `INSERT INTO sms_requests (mobile_hash, created_at)
       SELECT ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM sms_requests WHERE mobile_hash = ? AND created_at > ?)
         AND (SELECT COUNT(*) FROM sms_requests WHERE mobile_hash = ? AND created_at > ?) < 5
       RETURNING created_at`,
    ).bind(mobileHash, now, mobileHash, now - 60_000, mobileHash, now - 3_600_000).all<{ created_at: number }>();
    return inserted.results.length > 0;
  }

  async getSession(sidHash: string): Promise<SessionRecord | null> {
    const row = await this.db.prepare("SELECT * FROM sessions WHERE sid_hash = ?").bind(sidHash).first<SessionRow>();
    if (!row) return null;
    return {
      sidHash: row.sid_hash,
      accountHash: row.account_hash ?? row.sid_hash,
      mobile: await decryptField(row.mobile_enc, this.secret),
      upstreamToken: await decryptField(row.upstream_token_enc, this.secret),
      balance: row.balance,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    };
  }

  async putSession(record: SessionRecord): Promise<void> {
    await this.db.prepare(
      "INSERT INTO sessions (sid_hash, account_hash, mobile_enc, upstream_token_enc, balance, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      record.sidHash,
      record.accountHash,
      await encryptField(record.mobile, this.secret),
      await encryptField(record.upstreamToken, this.secret),
      record.balance,
      record.createdAt,
      record.updatedAt,
      record.expiresAt,
    ).run();
  }

  async bindSessionAccount(sidHash: string, accountHash: string): Promise<void> {
    await this.db.batch([
      this.db.prepare("UPDATE sessions SET account_hash = ? WHERE sid_hash = ?").bind(accountHash, sidHash),
      this.db.prepare(
        `UPDATE saved_devices
         SET enabled = 0
         WHERE account_hash = ?
           AND EXISTS (SELECT 1 FROM saved_devices WHERE account_hash = ? AND enabled = 1)`,
      ).bind(sidHash, accountHash),
      this.db.prepare("UPDATE saved_devices SET account_hash = ? WHERE account_hash = ?").bind(accountHash, sidHash),
    ]);
  }

  async deleteSession(sidHash: string): Promise<void> {
    await this.db.prepare("DELETE FROM sessions WHERE sid_hash = ?").bind(sidHash).run();
  }

  async updateBalance(sidHash: string, balance: string, updatedAt: number): Promise<void> {
    await this.db.prepare("UPDATE sessions SET balance = ?, updated_at = ? WHERE sid_hash = ?").bind(balance, updatedAt, sidHash).run();
  }

  private async mapDevice(row: DeviceRow): Promise<DeviceRecord> {
    return {
      id: row.id,
      accountHash: row.account_hash,
      label: row.label,
      enabled: row.enabled === 1,
      hot: row.hot_device_key_enc && row.hot_device_fingerprint
        ? { deviceKey: await decryptField(row.hot_device_key_enc, this.secret), fingerprint: row.hot_device_fingerprint }
        : null,
      cold: row.cold_device_key_enc && row.cold_device_fingerprint
        ? { deviceKey: await decryptField(row.cold_device_key_enc, this.secret), fingerprint: row.cold_device_fingerprint }
        : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async listDevices(accountHash: string): Promise<DeviceRecord[]> {
    const result = await this.db.prepare(
      "SELECT * FROM saved_devices WHERE account_hash = ? ORDER BY enabled DESC, created_at ASC",
    ).bind(accountHash).all<DeviceRow>();
    return Promise.all(result.results.map((row) => this.mapDevice(row)));
  }

  async getDevice(accountHash: string, id: string): Promise<DeviceRecord | null> {
    const row = await this.db.prepare("SELECT * FROM saved_devices WHERE account_hash = ? AND id = ?").bind(accountHash, id).first<DeviceRow>();
    return row ? this.mapDevice(row) : null;
  }

  async getActiveDevice(accountHash: string): Promise<DeviceRecord | null> {
    const row = await this.db.prepare(
      "SELECT * FROM saved_devices WHERE account_hash = ? AND enabled = 1 ORDER BY created_at ASC LIMIT 1",
    ).bind(accountHash).first<DeviceRow>();
    return row ? this.mapDevice(row) : null;
  }

  async putDevice(record: DeviceRecord): Promise<void> {
    await this.db.prepare(
      `INSERT INTO saved_devices (
         id, account_hash, label, enabled,
         hot_device_key_enc, hot_device_fingerprint,
         cold_device_key_enc, cold_device_fingerprint,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         label = excluded.label,
         enabled = excluded.enabled,
         hot_device_key_enc = excluded.hot_device_key_enc,
         hot_device_fingerprint = excluded.hot_device_fingerprint,
         cold_device_key_enc = excluded.cold_device_key_enc,
         cold_device_fingerprint = excluded.cold_device_fingerprint,
         updated_at = excluded.updated_at
       WHERE saved_devices.account_hash = excluded.account_hash`,
    ).bind(
      record.id,
      record.accountHash,
      record.label,
      record.enabled ? 1 : 0,
      record.hot ? await encryptField(record.hot.deviceKey, this.secret) : null,
      record.hot?.fingerprint ?? null,
      record.cold ? await encryptField(record.cold.deviceKey, this.secret) : null,
      record.cold?.fingerprint ?? null,
      record.createdAt,
      record.updatedAt,
    ).run();
  }

  async deleteDevice(accountHash: string, id: string): Promise<void> {
    const device = await this.getDevice(accountHash, id);
    await this.db.prepare("DELETE FROM saved_devices WHERE account_hash = ? AND id = ?").bind(accountHash, id).run();
    if (device?.enabled) {
      const next = await this.db.prepare(
        "SELECT id FROM saved_devices WHERE account_hash = ? ORDER BY created_at ASC LIMIT 1",
      ).bind(accountHash).first<{ id: string }>();
      if (next) await this.setActiveDevice(accountHash, next.id);
    }
  }

  async setActiveDevice(accountHash: string, id: string): Promise<boolean> {
    const found = await this.db.prepare(
      "SELECT 1 AS found FROM saved_devices WHERE account_hash = ? AND id = ?",
    ).bind(accountHash, id).first<{ found: number }>();
    if (!found) return false;
    await this.db.batch([
      this.db.prepare("UPDATE saved_devices SET enabled = 0 WHERE account_hash = ?").bind(accountHash),
      this.db.prepare("UPDATE saved_devices SET enabled = 1 WHERE account_hash = ? AND id = ?").bind(accountHash, id),
    ]);
    return true;
  }

  async reserveCommand(sidHash: string, requestId: string, kind: DeviceKind, now: number) {
    const inserted = await this.db.prepare(
      `INSERT INTO command_requests (sid_hash, request_id, kind, created_at)
       SELECT ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM command_requests WHERE sid_hash = ? AND kind = ? AND created_at > ?
       )
       ON CONFLICT(sid_hash, request_id) DO NOTHING
       RETURNING request_id`,
    ).bind(sidHash, requestId, kind, now, sidHash, kind, now - 3_000).all<{ request_id: string }>();
    if (inserted.results.length > 0) return "reserved" as const;
    const duplicate = await this.db.prepare("SELECT 1 AS found FROM command_requests WHERE sid_hash = ? AND request_id = ?").bind(sidHash, requestId).first();
    return duplicate ? "duplicate" as const : "rate_limited" as const;
  }
}
