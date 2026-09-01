import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/worker/app";
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
    expect(await login.text()).not.toContain("server-only-token");

    const cookie = setCookie.split(";", 1)[0];
    const me = await request("/api/me", undefined, cookie);
    expect(await me.json()).toMatchObject({ ok: true, data: { authenticated: true, mobile: "*******8000", balance: "12.34" } });

    const refresh = await request("/api/balance/refresh", {}, cookie);
    expect(await refresh.json()).toMatchObject({ ok: true, data: { balance: "18.88" } });
  });
});
