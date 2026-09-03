export type DeviceKind = "hot" | "cold";

export interface SessionRecord {
  sidHash: string;
  accountHash: string;
  mobile: string;
  upstreamToken: string;
  balance: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface DeviceRecord {
  id: string;
  accountHash: string;
  label: string;
  enabled: boolean;
  hot: { deviceKey: string; fingerprint: string } | null;
  cold: { deviceKey: string; fingerprint: string } | null;
  createdAt: number;
  updatedAt: number;
}

export interface Store {
  cleanup(now: number): Promise<void>;
  reserveSendCode(mobileHash: string, now: number): Promise<boolean>;
  getSession(sidHash: string): Promise<SessionRecord | null>;
  putSession(record: SessionRecord): Promise<void>;
  bindSessionAccount(sidHash: string, accountHash: string): Promise<void>;
  deleteSession(sidHash: string): Promise<void>;
  updateBalance(sidHash: string, balance: string, updatedAt: number): Promise<void>;
  listDevices(accountHash: string): Promise<DeviceRecord[]>;
  getDevice(accountHash: string, id: string): Promise<DeviceRecord | null>;
  getActiveDevice(accountHash: string): Promise<DeviceRecord | null>;
  putDevice(record: DeviceRecord): Promise<void>;
  deleteDevice(accountHash: string, id: string): Promise<void>;
  setActiveDevice(accountHash: string, id: string): Promise<boolean>;
  reserveCommand(
    sidHash: string,
    requestId: string,
    kind: DeviceKind,
    now: number,
  ): Promise<"reserved" | "duplicate" | "rate_limited">;
}

export interface Upstream {
  sendCode(mobile: string): Promise<void>;
  login(mobile: string, code: string): Promise<{ mobile: string; token: string; balance: string }>;
  loginWithPassword(mobile: string, password: string): Promise<{ mobile: string; token: string; balance: string }>;
  refreshBalance(mobile: string, token: string): Promise<string>;
  startWater(kind: DeviceKind, deviceKey: string, token: string): Promise<void>;
}

export type Env = Cloudflare.Env;

export interface AppDependencies {
  store?: Store;
  upstream?: Upstream;
  now?: () => number;
  verifyTurnstile?: (token: string, remoteIp: string | undefined, expectedHostname: string) => Promise<void>;
}
