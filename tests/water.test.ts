import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/worker/app";
import { createMockUpstream, MemoryStore } from "./api-test-helpers";

const origin = "https://duoheshui.test";

describe("device and water APIs", () => {
  let store: MemoryStore;
  let upstream: ReturnType<typeof createMockUpstream>;
  let now: number;
  let cookie: string;

  beforeEach(async () => {
    store = new MemoryStore();
    upstream = createMockUpstream();
    now = 1_800_000_000_000;
    const response = await api("/api/auth/login", "POST", { mobile: "13800138000", code: "123456" });
    cookie = response.headers.get("set-cookie")!.split(";", 1)[0];
  });

  async function api(path: string, method: string, body?: unknown, useCookie = true) {
    const app = createApp({ store, upstream, now: () => now });
    return app.request(`${origin}${path}`, {
      method,
      headers: {
        origin,
        "x-duoheshui-client": "web",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(useCookie && cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it("keeps hot and cold bindings separate and never returns raw keys", async () => {
    await api("/api/devices/hot", "PUT", { deviceKey: "HOT-DEVICE-AB12CD", label: "宿舍热水" });
    await api("/api/devices/cold", "PUT", { deviceKey: "COLD-DEVICE-EF34GH", label: "宿舍冷水" });
    const response = await api("/api/devices", "GET");
    const text = await response.text();
    expect(text).toContain("AB12CD");
    expect(text).toContain("EF34GH");
    expect(text).not.toContain("HOT-DEVICE");
    expect(text).not.toContain("COLD-DEVICE");
  });

  it("starts each device once, rejects duplicate IDs, and rate-limits rapid commands", async () => {
    await api("/api/devices/hot", "PUT", { deviceKey: "HOT-DEVICE-AB12CD", label: "热水" });
    await api("/api/devices/cold", "PUT", { deviceKey: "COLD-DEVICE-EF34GH", label: "冷水" });

    const hotId = "11111111-1111-4111-8111-111111111111";
    expect((await api("/api/water/hot/start", "POST", { requestId: hotId })).status).toBe(200);
    expect((await api("/api/water/hot/start", "POST", { requestId: hotId })).status).toBe(409);
    expect((await api("/api/water/hot/start", "POST", { requestId: "22222222-2222-4222-8222-222222222222" })).status).toBe(429);

    expect((await api("/api/water/cold/start", "POST", { requestId: "33333333-3333-4333-8333-333333333333" })).status).toBe(200);
    expect(upstream.calls.startWater).toBe(2);
  });

  it("returns 401 without a session and 404 without a device", async () => {
    expect((await api("/api/water/hot/start", "POST", { requestId: crypto.randomUUID() }, false)).status).toBe(401);
    expect((await api("/api/water/hot/start", "POST", { requestId: crypto.randomUUID() })).status).toBe(404);
  });
});
