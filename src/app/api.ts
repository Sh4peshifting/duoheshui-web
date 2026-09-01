export type DeviceKind = "hot" | "cold";

export interface AccountData {
  authenticated: boolean;
  mobile?: string;
  balance?: string;
}

export interface DeviceView {
  bound: boolean;
  label: string;
  fingerprint?: string;
}

export type DevicesData = Record<DeviceKind, DeviceView>;

class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(["POST", "PUT", "DELETE"].includes(method) ? { "x-duoheshui-client": "web" } : {}),
      ...init.headers,
    },
  });
  const payload = (await response.json()) as { ok: boolean; data?: T; error?: { code: string; message: string } };
  if (!response.ok || !payload.ok) throw new ApiError(payload.error?.code ?? "REQUEST_FAILED", payload.error?.message ?? "请求失败", response.status);
  return payload.data as T;
}

const body = (value: unknown) => JSON.stringify(value);

export const api = {
  me: () => request<AccountData>("/api/me"),
  sendCode: (mobile: string) => request<{ sent: true; retryAfter: number }>("/api/auth/send-code", { method: "POST", body: body({ mobile }) }),
  login: (mobile: string, code: string) => request<AccountData>("/api/auth/login", { method: "POST", body: body({ mobile, code }) }),
  logout: () => request<AccountData>("/api/auth/logout", { method: "POST", body: body({}) }),
  refreshBalance: () => request<{ balance: string }>("/api/balance/refresh", { method: "POST", body: body({}) }),
  devices: () => request<DevicesData>("/api/devices"),
  putDevice: (kind: DeviceKind, deviceKey: string, label: string) => request<DeviceView>(`/api/devices/${kind}`, { method: "PUT", body: body({ deviceKey, label }) }),
  deleteDevice: (kind: DeviceKind) => request<{ bound: false }>(`/api/devices/${kind}`, { method: "DELETE" }),
  startWater: (kind: DeviceKind, requestId: string) => request<{ started: true }>(`/api/water/${kind}/start`, { method: "POST", body: body({ requestId }) }),
};
