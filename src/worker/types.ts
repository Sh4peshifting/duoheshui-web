export type DeviceKind = "hot" | "cold";

export interface SessionRecord {
  sidHash: string;
  mobile: string;
  upstreamToken: string;
  balance: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface DeviceRecord {
  sidHash: string;
  kind: DeviceKind;
  label: string;
  deviceKey: string;
  fingerprint: string;
  createdAt: number;
  updatedAt: number;
}

export interface Store {
  cleanup(now: number): Promise<void>;
  reserveSendCode(mobileHash: string, now: number): Promise<boolean>;
  getSession(sidHash: string): Promise<SessionRecord | null>;
  putSession(record: SessionRecord): Promise<void>;
  deleteSession(sidHash: string): Promise<void>;
  updateBalance(sidHash: string, balance: string, updatedAt: number): Promise<void>;
  listDevices(sidHash: string): Promise<DeviceRecord[]>;
  getDevice(sidHash: string, kind: DeviceKind): Promise<DeviceRecord | null>;
  putDevice(record: DeviceRecord): Promise<void>;
  deleteDevice(sidHash: string, kind: DeviceKind): Promise<void>;
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
  refreshBalance(mobile: string, token: string): Promise<string>;
  startWater(kind: DeviceKind, deviceKey: string, token: string): Promise<void>;
}

export type Env = Cloudflare.Env;

export interface AppDependencies {
  store?: Store;
  upstream?: Upstream;
  now?: () => number;
}
