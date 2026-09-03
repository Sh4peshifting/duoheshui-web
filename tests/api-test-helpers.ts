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
  async bindSessionAccount(sidHash: string, accountHash: string) {
    const session = this.sessions.get(sidHash);
    if (session) this.sessions.set(sidHash, { ...session, accountHash });
    const targetHasActive = [...this.devices.values()].some((device) => device.accountHash === accountHash && device.enabled);
    for (const [key, device] of [...this.devices]) {
      if (device.accountHash !== sidHash) continue;
      this.devices.delete(key);
      this.devices.set(`${accountHash}:${device.id}`, { ...device, accountHash, enabled: targetHasActive ? false : device.enabled });
    }
  }
  async deleteSession(sidHash: string) { this.sessions.delete(sidHash); }
  async updateBalance(sidHash: string, balance: string, updatedAt: number) {
    const value = this.sessions.get(sidHash);
    if (value) this.sessions.set(sidHash, { ...value, balance, updatedAt });
  }
  async listDevices(accountHash: string) {
    return [...this.devices.values()].filter((item) => item.accountHash === accountHash);
  }
  async getDevice(accountHash: string, id: string) { return this.devices.get(`${accountHash}:${id}`) ?? null; }
  async getActiveDevice(accountHash: string) {
    return [...this.devices.values()].find((item) => item.accountHash === accountHash && item.enabled) ?? null;
  }
  async putDevice(record: DeviceRecord) { this.devices.set(`${record.accountHash}:${record.id}`, record); }
  async deleteDevice(accountHash: string, id: string) {
    const existing = await this.getDevice(accountHash, id);
    this.devices.delete(`${accountHash}:${id}`);
    if (existing?.enabled) {
      const next = [...this.devices.values()].find((item) => item.accountHash === accountHash);
      if (next) this.devices.set(`${accountHash}:${next.id}`, { ...next, enabled: true });
    }
  }
  async setActiveDevice(accountHash: string, id: string) {
    if (!(await this.getDevice(accountHash, id))) return false;
    for (const [key, device] of this.devices) {
      if (device.accountHash === accountHash) this.devices.set(key, { ...device, enabled: device.id === id });
    }
    return true;
  }
  async reserveCommand(sidHash: string, requestId: string, kind: "hot" | "cold", now: number) {
    if (this.commands.some((item) => item.sidHash === sidHash && item.requestId === requestId)) return "duplicate" as const;
    if (this.commands.some((item) => item.sidHash === sidHash && item.kind === kind && item.createdAt > now - 3_000)) return "rate_limited" as const;
    this.commands.push({ sidHash, requestId, kind, createdAt: now });
    return "reserved" as const;
  }
}

export function createMockUpstream(): Upstream & { calls: Record<string, number>; waterCalls: Array<{ kind: "hot" | "cold"; deviceKey: string }> } {
  const calls: Record<string, number> = { sendCode: 0, login: 0, loginWithPassword: 0, refreshBalance: 0, startWater: 0 };
  const waterCalls: Array<{ kind: "hot" | "cold"; deviceKey: string }> = [];
  return {
    calls,
    waterCalls,
    async sendCode() { calls.sendCode++; },
    async login(mobile, code) {
      calls.login++;
      if (code !== "123456") throw Object.assign(new Error("验证码错误"), { code: "UPSTREAM_REJECTED", status: 400 });
      return { mobile, token: "server-only-token", balance: "12.34" };
    },
    async loginWithPassword(mobile, password) {
      calls.loginWithPassword++;
      if (password !== "correct-password") throw Object.assign(new Error("密码错误"), { code: "UPSTREAM_REJECTED", status: 400 });
      return { mobile, token: "server-only-password-token", balance: "21.00" };
    },
    async refreshBalance() { calls.refreshBalance++; return "18.88"; },
    async startWater(kind, deviceKey) { calls.startWater++; waterCalls.push({ kind, deviceKey }); },
  };
}
