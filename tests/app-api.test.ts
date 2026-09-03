import { afterEach, describe, expect, it, vi } from "vitest";
import { api, onSessionExpired } from "../src/app/api";

describe("browser API session handling", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("notifies the application when an API request returns 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: { code: "UNAUTHENTICATED", message: "上游登录状态已失效，请重新登录" },
    }), { status: 401, headers: { "content-type": "application/json" } })));
    const messages: string[] = [];
    const unsubscribe = onSessionExpired((message) => messages.push(message));

    await expect(api.refreshBalance()).rejects.toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    expect(messages).toEqual(["上游登录状态已失效，请重新登录"]);
    unsubscribe();
  });

  it("does not notify the application for an ordinary upstream outage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: { code: "UPSTREAM_UNAVAILABLE", message: "上游服务暂时不可用" },
    }), { status: 502, headers: { "content-type": "application/json" } })));
    const messages: string[] = [];
    const unsubscribe = onSessionExpired((message) => messages.push(message));

    await expect(api.refreshBalance()).rejects.toMatchObject({ status: 502, code: "UPSTREAM_UNAVAILABLE" });
    expect(messages).toEqual([]);
    unsubscribe();
  });
});
