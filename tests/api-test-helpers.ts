import type { DeviceRecord, SessionRecord, Store, Upstream } from "../src/worker/types";

export class MemoryStore implements Store {
  readonly sessions = new Map<string, SessionRecord>();
  readonly devices = new Map<string, DeviceRecord>();
  readonly commands: Array<{ sidHash: string; requestId: string; kind: "hot" | "cold"; createdAt: number }> = [];
  readonly smsRequests: Array<{ mobileHash: string; createdAt: number }> = [];

  async cleanup(now: number) {
    for (const [key, value] of this.sessions) if (value.expiresAt <= now) this.sessions.delete(key);
    for (let i = this.commands.length - 1; i >= 0; i--) {
      if (this.commands[i].createdAt <= now - 600_000) this.commands.splice(i, 1);
    }
    for (let i = this.smsRequests.length - 1; i >= 0; i--) if (this.smsRequests[i].createdAt <= now - 3_600_000) this.smsRequests.splice(i, 1);
  }
  async reserveSendCode(mobileHash: string, now: number) {
    const recent = this.smsRequests.filter((item) => item.mobileHash === mobileHash && item.createdAt > now - 3_600_000);
    if (recent.some((item) => item.createdAt > now - 60_000) || recent.length >= 5) return false;
    this.smsRequests.push({ mobileHash, createdAt: now });
    return true;
  }
  async getSession(sidHash: string) { return this.sessions.get(sidHash) ?? null; }
  async putSession(record: SessionRecord) { this.sessions.set(record.sidHash, record); }
  async deleteSession(sidHash: string) { this.sessions.delete(sidHash); }
  async updateBalance(sidHash: string, balance: string, updatedAt: number) {
    const value = this.sessions.get(sidHash);
    if (value) this.sessions.set(sidHash, { ...value, balance, updatedAt });
  }
  async listDevices(sidHash: string) {
    return [...this.devices.values()].filter((item) => item.sidHash === sidHash);
  }
  async getDevice(sidHash: string, kind: "hot" | "cold") { return this.devices.get(`${sidHash}:${kind}`) ?? null; }
  async putDevice(record: DeviceRecord) { this.devices.set(`${record.sidHash}:${record.kind}`, record); }
  async deleteDevice(sidHash: string, kind: "hot" | "cold") { this.devices.delete(`${sidHash}:${kind}`); }
  async reserveCommand(sidHash: string, requestId: string, kind: "hot" | "cold", now: number) {
    if (this.commands.some((item) => item.sidHash === sidHash && item.requestId === requestId)) return "duplicate" as const;
    if (this.commands.some((item) => item.sidHash === sidHash && item.kind === kind && item.createdAt > now - 3_000)) return "rate_limited" as const;
    this.commands.push({ sidHash, requestId, kind, createdAt: now });
    return "reserved" as const;
  }
}

export function createMockUpstream(): Upstream & { calls: Record<string, number> } {
  const calls: Record<string, number> = { sendCode: 0, login: 0, refreshBalance: 0, startWater: 0 };
  return {
    calls,
    async sendCode() { calls.sendCode++; },
    async login(mobile, code) {
      calls.login++;
      if (code !== "123456") throw Object.assign(new Error("验证码错误"), { code: "UPSTREAM_REJECTED", status: 400 });
      return { mobile, token: "server-only-token", balance: "12.34" };
    },
    async refreshBalance() { calls.refreshBalance++; return "18.88"; },
    async startWater() { calls.startWater++; },
  };
}
