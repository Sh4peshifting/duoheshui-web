import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/worker/app";
import { AppError, UpstreamSessionInvalidError } from "../src/worker/errors";
import { hashAccount, hashValue } from "../src/worker/session";
import { createMockUpstream, MemoryStore } from "./api-test-helpers";

const origin = "https://duoheshui.test";

describe("authentication and account API", () => {
  let store: MemoryStore;
  let upstream: ReturnType<typeof createMockUpstream>;
  let now: number;

  beforeEach(() => {
    store = new MemoryStore();
    upstream = createMockUpstream();
    now = 1_800_000_000_000;
  });

  async function request(path: string, body?: unknown, cookie?: string) {
    const app = createApp({ store, upstream, now: () => now });
    return app.request(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json", origin, "x-duoheshui-client": "web" }),
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it("sends a code without retrying", async () => {
    const response = await request("/api/auth/send-code", { mobile: "13800138000" });
    expect(response.status).toBe(200);
    expect(upstream.calls.sendCode).toBe(1);
    expect((await request("/api/auth/send-code", { mobile: "13800138000" })).status).toBe(429);
    expect(upstream.calls.sendCode).toBe(1);
  });

  it("does not establish a session when login fails", async () => {
    const response = await request("/api/auth/login", { mobile: "13800138000", code: "000000" });
    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(store.sessions.size).toBe(0);
  });

  it("establishes an HttpOnly session and exposes only masked account data", async () => {
    const login = await request("/api/auth/login", { mobile: "13800138000", code: "123456" });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie")!;
    expect(setCookie).toContain("duoheshui_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Max-Age=31536000");
    expect(await login.text()).not.toContain("server-only-token");

    const cookie = setCookie.split(";", 1)[0];
    const me = await request("/api/me", undefined, cookie);
    expect(await me.json()).toMatchObject({ ok: true, data: { authenticated: true, mobile: "*******8000", balance: "18.88" } });

    const refresh = await request("/api/balance/refresh", {}, cookie);
    expect(await refresh.json()).toMatchObject({ ok: true, data: { balance: "18.88" } });
  });

  it("logs in with a password without exposing it or the upstream token", async () => {
    const failed = await request("/api/auth/login/password", { mobile: "13800138000", password: "wrong-password" });
    expect(failed.status).toBe(400);
    expect(failed.headers.get("set-cookie")).toBeNull();

    const login = await request("/api/auth/login/password", { mobile: "13800138000", password: "correct-password" });
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toContain("HttpOnly");
    const text = await login.text();
    expect(text).not.toContain("correct-password");
    expect(text).not.toContain("server-only-password-token");
    expect(upstream.calls.loginWithPassword).toBe(2);
  });

  it("clears the local session when startup user-info validation reports an invalid upstream token", async () => {
    const login = await request("/api/auth/login", { mobile: "13800138000", code: "123456" });
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0];
    upstream.refreshBalance = async () => { throw new UpstreamSessionInvalidError(); };

    const response = await request("/api/me", undefined, cookie);
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    expect(store.sessions.size).toBe(0);
  });

  it("clears the local session when a balance refresh reports an invalid upstream token", async () => {
    const login = await request("/api/auth/login", { mobile: "13800138000", code: "123456" });
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0];
    upstream.refreshBalance = async () => { throw new UpstreamSessionInvalidError(); };

    const response = await request("/api/balance/refresh", {}, cookie);
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(store.sessions.size).toBe(0);
  });

  it("clears the local session when a water command reports an invalid upstream token", async () => {
    const login = await request("/api/auth/login", { mobile: "13800138000", code: "123456" });
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0];
    await request("/api/devices", { label: "测试设备", coldKey: "COLD-KEY" }, cookie);
    upstream.startWater = async () => { throw new UpstreamSessionInvalidError(); };

    const response = await request("/api/water/cold/start", { requestId: "55555555-5555-4555-8555-555555555555" }, cookie);
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(store.sessions.size).toBe(0);
    expect(store.devices.size).toBe(1);

    const relogin = await request("/api/auth/login/password", { mobile: "13800138000", password: "correct-password" });
    const newCookie = relogin.headers.get("set-cookie")!.split(";", 1)[0];
    const devices = await (await request("/api/devices", undefined, newCookie)).json() as any;
    expect(devices.data.devices).toHaveLength(1);
    expect(devices.data.devices[0]).toMatchObject({ label: "测试设备", enabled: true });
  });

  it("keeps the local session for an ordinary upstream network failure", async () => {
    const login = await request("/api/auth/login", { mobile: "13800138000", code: "123456" });
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0];
    upstream.refreshBalance = async () => { throw new AppError(502, "UPSTREAM_UNAVAILABLE", "上游服务暂时不可用"); };

    const response = await request("/api/me", undefined, cookie);
    expect(response.status).toBe(502);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(store.sessions.size).toBe(1);
  });

  it("claims legacy session-owned devices for the stable account before validating user info", async () => {
    const rawToken = "legacy-session-token";
    const sidHash = await hashValue(rawToken);
    store.sessions.set(sidHash, {
      sidHash,
      accountHash: sidHash,
      mobile: "13800138000",
      upstreamToken: "legacy-upstream-token",
      balance: "1.00",
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 60_000,
    });
    store.devices.set(`${sidHash}:legacy-device`, {
      id: "legacy-device",
      accountHash: sidHash,
      label: "原有设备",
      enabled: true,
      hot: { deviceKey: "LEGACY-HOT", fingerprint: "******CY-HOT" },
      cold: null,
      createdAt: now,
      updatedAt: now,
    });

    const response = await request("/api/me", undefined, `duoheshui_session=${rawToken}`);
    expect(response.status).toBe(200);
    const accountHash = await hashAccount("13800138000");
    expect(store.sessions.get(sidHash)?.accountHash).toBe(accountHash);
    expect(await store.getDevice(accountHash, "legacy-device")).toMatchObject({ label: "原有设备", enabled: true });
  });
});
