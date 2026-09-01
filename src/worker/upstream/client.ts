import { AppError, UpstreamProtocolError } from "../errors";
import type { DeviceKind, Env, Upstream } from "../types";
import { decryptTianjiPayload, encryptTianjiPayload } from "./crypto";
import { buildGptechMessage, buildGptechRequestBody, parseEncryptedResponse } from "./protocol";

interface TianjiUserPayload {
  mobile: string;
  token: string;
  wallet: { balance: string | number };
}

class RetryableNetworkError extends AppError {}

function stringBalance(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") throw new UpstreamProtocolError();
  const balance = String(value);
  if (!/^-?\d+(?:\.\d+)?$/.test(balance)) throw new UpstreamProtocolError();
  return balance;
}

export class TianjiUpstream implements Upstream {
  private readonly userOrigin: string;
  private readonly iotOrigin: string;

  constructor(private readonly env: Env, private readonly fetcher: typeof fetch = fetch) {
    this.userOrigin = (env.TIANJI_USER_ORIGIN ?? "http://newxiaotian.tianji-inc.com").replace(/\/$/, "");
    this.iotOrigin = (env.TIANJI_IOT_ORIGIN ?? "http://iot.tianji-inc.com").replace(/\/$/, "");
  }

  private async post(
    origin: string,
    path: string,
    act: string,
    plaintext: string,
    token: string,
    timeoutMs: number,
  ): Promise<string> {
    const encrypted = encryptTianjiPayload(plaintext, this.env.TIANJI_DES_KEY, this.env.TIANJI_DES_IV);
    const body = buildGptechRequestBody(buildGptechMessage(act, encrypted, token));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      const response = await this.fetcher(`${origin}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          "accept-language": "zh-CN,zh;q=0.8",
          "cache-control": "no-cache",
          "user-agent": "Duoheshui-Web/0.1 Cloudflare-Worker",
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new AppError(response.status >= 500 ? 502 : 400, response.status >= 500 ? "UPSTREAM_UNAVAILABLE" : "UPSTREAM_REJECTED", response.status >= 500 ? "上游服务暂时不可用" : "请求未被上游服务接受");
      }
      return await response.text();
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (controller.signal.aborted) throw new RetryableNetworkError(504, "UPSTREAM_TIMEOUT", "上游服务响应超时");
      throw new RetryableNetworkError(502, "UPSTREAM_UNAVAILABLE", "上游服务暂时不可用");
    } finally {
      clearTimeout(timeout);
      console.info(JSON.stringify({ event: "tianji_request", route: path, success: !controller.signal.aborted, durationMs: Date.now() - startedAt }));
    }
  }

  private decrypt<T>(text: string): T {
    return parseEncryptedResponse<T>(text, (ciphertext) =>
      decryptTianjiPayload(ciphertext, this.env.TIANJI_DES_KEY, this.env.TIANJI_DES_IV),
    );
  }

  async sendCode(mobile: string): Promise<void> {
    const text = await this.post(
      this.userOrigin,
      "/api/v1/UserApi/sendCode",
      "sendCode",
      JSON.stringify({ mobile, type: "login" }),
      "",
      8_000,
    );
    try { JSON.parse(text); } catch { throw new UpstreamProtocolError(); }
  }

  async login(mobile: string, code: string) {
    const text = await this.post(
      this.userOrigin,
      "/api/v1/UserApi/loginByCode",
      "loginByCode",
      JSON.stringify({ code, mobile }),
      "",
      10_000,
    );
    const user = this.decrypt<TianjiUserPayload>(text);
    if (!user.mobile || !user.token || !user.wallet) throw new UpstreamProtocolError();
    return { mobile: user.mobile, token: user.token, balance: stringBalance(user.wallet.balance) };
  }

  async refreshBalance(mobile: string, token: string): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await this.post(
          this.userOrigin,
          "/api/v1/UserInfoApi/getUserInfo",
          "getUserInfo",
          JSON.stringify({ mobile, type: "login" }),
          token,
          8_000,
        );
        const user = this.decrypt<TianjiUserPayload>(text);
        return stringBalance(user.wallet?.balance);
      } catch (error) {
        lastError = error;
        if (!(error instanceof RetryableNetworkError)) throw error;
      }
    }
    throw lastError;
  }

  async startWater(kind: DeviceKind, deviceKey: string, token: string): Promise<void> {
    const text = await this.post(
      this.iotOrigin,
      "/index.php/drinking/send_command/send",
      "send",
      JSON.stringify({ device_key: deviceKey }),
      token,
      8_000,
    );
    const result = this.decrypt<{ order_sn?: string }>(text);
    if (!result.order_sn) throw new UpstreamProtocolError();
    console.info(JSON.stringify({ event: "water_command", kind, success: true }));
  }
}
