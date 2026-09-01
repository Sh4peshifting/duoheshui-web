import { afterEach, describe, expect, it, vi } from "vitest";
import { TianjiUpstream } from "../src/worker/upstream/client";

function env(overrides: Partial<Record<string, string>> = {}): Cloudflare.Env {
  return {
    TIANJI_DES_KEY: "5yoOxt9w",
    TIANJI_DES_IV: "20190829",
    TIANJI_USER_ORIGIN: "http://newxiaotian.tianji-inc.com",
    TIANJI_IOT_ORIGIN: "http://iot.tianji-inc.com",
    ...overrides,
  } as unknown as Cloudflare.Env;
}

describe("Tianji upstream transport", () => {
  afterEach(() => vi.restoreAllMocks());

  it("normalizes dashboard-pasted origins and mirrors the legacy Android request headers", async () => {
    let fetchReceiver: unknown = "not-called";
    const fetcher = vi.fn<typeof fetch>(async function (this: unknown) {
      fetchReceiver = this;
      return new Response(JSON.stringify({ code: 0, msg: "发送成功" }), { status: 200 });
    });
    const upstream = new TianjiUpstream(
      env({ TIANJI_USER_ORIGIN: ' TIANJI_USER_ORIGIN="http://newxiaotian.tianji-inc.com/" ' }),
      fetcher,
    );

    await upstream.sendCode("13800138000");

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetchReceiver).toBeUndefined();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://newxiaotian.tianji-inc.com/api/v1/UserApi/sendCode");
    expect(init?.headers).toMatchObject({
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
    });
    expect(init?.headers).not.toHaveProperty("accept-encoding");
    expect((init?.headers as Record<string, string>)["user-agent"]).toContain("Android 11");
  });

  it("logs an upstream HTTP status separately from transport failures", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetcher = vi.fn<typeof fetch>(async () => new Response("failure", { status: 500 }));
    const upstream = new TianjiUpstream(env(), fetcher);

    await expect(upstream.sendCode("13800138000")).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });

    expect(JSON.parse(String(error.mock.calls[0][0]))).toMatchObject({
      event: "tianji_request",
      outcome: "http_error",
      upstreamStatus: 500,
      success: false,
    });
  });

  it("records a sanitized Cloudflare connection failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Network connection lost while fetching http://newxiaotian.tianji-inc.com/private");
    });
    const upstream = new TianjiUpstream(env(), fetcher);

    await expect(upstream.sendCode("13800138000")).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });

    expect(JSON.parse(String(error.mock.calls[0][0]))).toMatchObject({
      outcome: "network_error",
      failureKind: "connection_lost",
      errorMessage: "Network connection lost while fetching [url]",
    });
  });

  it("does not treat an HTTP 200 business rejection as a sent SMS", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ code: 100, msg: "请输入正确的手机号 13800138000", data: "secret" }), { status: 200 }),
    );
    const upstream = new TianjiUpstream(env(), fetcher);

    await expect(upstream.sendCode("13800138000")).rejects.toMatchObject({
      status: 400,
      code: "UPSTREAM_REJECTED",
      message: "手机号未被上游服务接受",
    });

    const businessLog = info.mock.calls
      .map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>)
      .find((entry) => entry.event === "tianji_business_response");
    expect(businessLog).toMatchObject({
      businessCode: "100",
      businessMessage: "请输入正确的手机号 [mobile]",
      accepted: false,
    });
    expect(JSON.stringify(businessLog)).not.toContain("secret");
    expect(JSON.stringify(businessLog)).not.toContain("13800138000");
  });

  it("rejects an unrecognized HTTP 200 response instead of reporting success", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    const upstream = new TianjiUpstream(env(), fetcher);

    await expect(upstream.sendCode("13800138000")).rejects.toMatchObject({ code: "UPSTREAM_PROTOCOL_ERROR" });
  });
});
