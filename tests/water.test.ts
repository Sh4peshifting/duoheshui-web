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

  it("stores multiple devices with separate outlets and never returns raw keys", async () => {
    expect((await api("/api/devices", "POST", {
      label: "一号饮水机",
      hotKey: "HOT-DEVICE-AB12CD",
      coldKey: "COLD-DEVICE-EF34GH",
    })).status).toBe(201);
    expect((await api("/api/devices", "POST", {
      label: "二号饮水机",
      coldKey: "SECOND-COLD-112233",
    })).status).toBe(201);
    const response = await api("/api/devices", "GET");
    const text = await response.text();
    expect(text).toContain("AB12CD");
    expect(text).toContain("EF34GH");
    expect(text).toContain("112233");
    expect(text).not.toContain("HOT-DEVICE");
    expect(text).not.toContain("COLD-DEVICE");
    const payload = JSON.parse(text);
    expect(payload.data.devices).toHaveLength(2);
    expect(payload.data.devices.filter((device: { enabled: boolean }) => device.enabled)).toHaveLength(1);
  });

  it("edits, activates, and deletes device entries", async () => {
    const first = await (await api("/api/devices", "POST", { label: "宿舍", hotKey: "HOT-ONE" })).json() as any;
    const second = await (await api("/api/devices", "POST", { label: "实验室", coldKey: "COLD-TWO" })).json() as any;
    expect(first.data.enabled).toBe(true);
    expect(second.data.enabled).toBe(false);

    expect((await api(`/api/devices/${second.data.id}`, "PATCH", { label: "实验室东侧", hotKey: "HOT-TWO" })).status).toBe(200);
    expect((await api(`/api/devices/${second.data.id}/activate`, "POST", {})).status).toBe(200);
    let devices = await (await api("/api/devices", "GET")).json() as any;
    expect(devices.data.devices.find((item: any) => item.id === second.data.id)).toMatchObject({ label: "实验室东侧", enabled: true, hot: { bound: true }, cold: { bound: true } });

    expect((await api(`/api/devices/${second.data.id}`, "DELETE")).status).toBe(200);
    devices = await (await api("/api/devices", "GET")).json() as any;
    expect(devices.data.devices).toHaveLength(1);
    expect(devices.data.devices[0]).toMatchObject({ id: first.data.id, enabled: true });
  });

  it("starts the selected device outlets, rejects duplicate IDs, and rate-limits rapid commands", async () => {
    const first = await (await api("/api/devices", "POST", { label: "一号", hotKey: "HOT-ONE", coldKey: "COLD-ONE" })).json() as any;
    const second = await (await api("/api/devices", "POST", { label: "二号", hotKey: "HOT-TWO", coldKey: "COLD-TWO" })).json() as any;
    await api(`/api/devices/${second.data.id}/activate`, "POST", {});

    const hotId = "11111111-1111-4111-8111-111111111111";
    expect((await api("/api/water/hot/start", "POST", { requestId: hotId })).status).toBe(200);
    expect((await api("/api/water/hot/start", "POST", { requestId: hotId })).status).toBe(409);
    expect((await api("/api/water/hot/start", "POST", { requestId: "22222222-2222-4222-8222-222222222222" })).status).toBe(429);

    expect((await api("/api/water/cold/start", "POST", { requestId: "33333333-3333-4333-8333-333333333333" })).status).toBe(200);
    expect(upstream.calls.startWater).toBe(2);
    expect(upstream.waterCalls).toEqual([
      { kind: "hot", deviceKey: "HOT-TWO" },
      { kind: "cold", deviceKey: "COLD-TWO" },
    ]);
    expect(first.data.id).not.toBe(second.data.id);
  });

  it("starts a temporary scanned outlet without saving it", async () => {
    expect((await api("/api/water/temporary/start", "POST", {
      requestId: "44444444-4444-4444-8444-444444444444",
      deviceKey: "TEMP-COLD-KEY",
    })).status).toBe(200);
    expect(upstream.waterCalls).toEqual([{ kind: "cold", deviceKey: "TEMP-COLD-KEY" }]);
    expect(store.devices.size).toBe(0);
  });

  it("returns 401 without a session and 404 without a device", async () => {
    expect((await api("/api/water/hot/start", "POST", { requestId: crypto.randomUUID() }, false)).status).toBe(401);
    expect((await api("/api/water/hot/start", "POST", { requestId: crypto.randomUUID() })).status).toBe(404);
  });
});
