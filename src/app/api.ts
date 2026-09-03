export type DeviceKind = "hot" | "cold";

export interface AccountData {
  authenticated: boolean;
  mobile?: string;
  balance?: string;
}

export interface DeviceView {
  id: string;
  label: string;
  enabled: boolean;
  hot: { bound: boolean; fingerprint?: string };
  cold: { bound: boolean; fingerprint?: string };
}

export interface DevicesData {
  devices: DeviceView[];
}

export interface DeviceInput {
  label: string;
  hotKey?: string | null;
  coldKey?: string | null;
}

export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
  }
}

type SessionExpiredListener = (message: string) => void;
const sessionExpiredListeners = new Set<SessionExpiredListener>();

export function onSessionExpired(listener: SessionExpiredListener): () => void {
  sessionExpiredListeners.add(listener);
  return () => { sessionExpiredListeners.delete(listener); };
}

export function isSessionExpiredError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 401;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(["POST", "PUT", "PATCH", "DELETE"].includes(method) ? { "x-duoheshui-client": "web" } : {}),
      ...init.headers,
    },
  });
  const payload = (await response.json()) as { ok: boolean; data?: T; error?: { code: string; message: string } };
  if (!response.ok || !payload.ok) {
    const error = new ApiError(payload.error?.code ?? "REQUEST_FAILED", payload.error?.message ?? "请求失败", response.status);
    if (response.status === 401) {
      for (const listener of sessionExpiredListeners) listener(error.message);
    }
    throw error;
  }
  return payload.data as T;
}

const body = (value: unknown) => JSON.stringify(value);

export const api = {
  me: () => request<AccountData>("/api/me"),
  config: () => request<{ turnstileSiteKey: string }>("/api/config"),
  sendCode: (mobile: string, turnstileToken: string) => request<{ sent: true; retryAfter: number }>("/api/auth/send-code", { method: "POST", body: body({ mobile, turnstileToken }) }),
  login: (mobile: string, code: string, turnstileToken: string) => request<AccountData>("/api/auth/login", { method: "POST", body: body({ mobile, code, turnstileToken }) }),
  loginWithPassword: (mobile: string, password: string, turnstileToken: string) => request<AccountData>("/api/auth/login/password", { method: "POST", body: body({ mobile, password, turnstileToken }) }),
  logout: () => request<AccountData>("/api/auth/logout", { method: "POST", body: body({}) }),
  refreshBalance: () => request<{ balance: string }>("/api/balance/refresh", { method: "POST", body: body({}) }),
  devices: () => request<DevicesData>("/api/devices"),
  createDevice: (input: DeviceInput) => request<DeviceView>("/api/devices", { method: "POST", body: body(input) }),
  updateDevice: (id: string, input: Partial<DeviceInput>) => request<DeviceView>(`/api/devices/${id}`, { method: "PATCH", body: body(input) }),
  deleteDevice: (id: string) => request<{ deleted: true }>(`/api/devices/${id}`, { method: "DELETE" }),
  activateDevice: (id: string) => request<{ enabled: true }>(`/api/devices/${id}/activate`, { method: "POST", body: body({}) }),
  startWater: (kind: DeviceKind, requestId: string) => request<{ started: true }>(`/api/water/${kind}/start`, { method: "POST", body: body({ requestId }) }),
  startTemporaryWater: (deviceKey: string, requestId: string) => request<{ started: true }>("/api/water/temporary/start", { method: "POST", body: body({ deviceKey, requestId }) }),
};
