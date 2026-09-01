import { decryptField, encryptField } from "./storage-crypto";
import type { DeviceKind, DeviceRecord, SessionRecord, Store } from "./types";

type SessionRow = {
  sid_hash: string;
  mobile_enc: string;
  upstream_token_enc: string;
  balance: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
};

type DeviceRow = {
  sid_hash: string;
  kind: DeviceKind;
  label: string | null;
  device_key_enc: string;
  device_fingerprint: string;
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
      "INSERT INTO sessions (sid_hash, mobile_enc, upstream_token_enc, balance, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      record.sidHash,
      await encryptField(record.mobile, this.secret),
      await encryptField(record.upstreamToken, this.secret),
      record.balance,
      record.createdAt,
      record.updatedAt,
      record.expiresAt,
    ).run();
  }

  async deleteSession(sidHash: string): Promise<void> {
    await this.db.prepare("DELETE FROM sessions WHERE sid_hash = ?").bind(sidHash).run();
  }

  async updateBalance(sidHash: string, balance: string, updatedAt: number): Promise<void> {
    await this.db.prepare("UPDATE sessions SET balance = ?, updated_at = ? WHERE sid_hash = ?").bind(balance, updatedAt, sidHash).run();
  }

  private async mapDevice(row: DeviceRow): Promise<DeviceRecord> {
    return {
      sidHash: row.sid_hash,
      kind: row.kind,
      label: row.label || (row.kind === "hot" ? "热水" : "冷水"),
      deviceKey: await decryptField(row.device_key_enc, this.secret),
      fingerprint: row.device_fingerprint,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async listDevices(sidHash: string): Promise<DeviceRecord[]> {
    const result = await this.db.prepare("SELECT * FROM devices WHERE sid_hash = ? ORDER BY kind").bind(sidHash).all<DeviceRow>();
    return Promise.all(result.results.map((row) => this.mapDevice(row)));
  }

  async getDevice(sidHash: string, kind: DeviceKind): Promise<DeviceRecord | null> {
    const row = await this.db.prepare("SELECT * FROM devices WHERE sid_hash = ? AND kind = ?").bind(sidHash, kind).first<DeviceRow>();
    return row ? this.mapDevice(row) : null;
  }

  async putDevice(record: DeviceRecord): Promise<void> {
    await this.db.prepare(
      `INSERT INTO devices (sid_hash, kind, label, device_key_enc, device_fingerprint, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sid_hash, kind) DO UPDATE SET label = excluded.label, device_key_enc = excluded.device_key_enc,
       device_fingerprint = excluded.device_fingerprint, updated_at = excluded.updated_at`,
    ).bind(
      record.sidHash,
      record.kind,
      record.label,
      await encryptField(record.deviceKey, this.secret),
      record.fingerprint,
      record.createdAt,
      record.updatedAt,
    ).run();
  }

  async deleteDevice(sidHash: string, kind: DeviceKind): Promise<void> {
    await this.db.prepare("DELETE FROM devices WHERE sid_hash = ? AND kind = ?").bind(sidHash, kind).run();
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
