import { AppError, UpstreamProtocolError, UpstreamSessionInvalidError } from "../errors";
import type { DeviceKind, Env, Upstream } from "../types";
import { decryptTianjiPayload, encryptTianjiPayload } from "./crypto";
import { assertUpstreamSessionValid, buildGptechMessage, buildGptechRequestBody, parseEncryptedResponse } from "./protocol";

interface TianjiUserPayload {
  mobile: string;
  token: string;
  wallet: { balance: string | number };
}

interface TianjiBusinessEnvelope {
  code: string | number;
  msg?: string;
}

class RetryableNetworkError extends AppError {}

const ANDROID_USER_AGENT =
  "Mozilla/5.0 (Linux; U; Android 11; zh-cn; LM-G820 Build/RKQ1.210420.001) AppleWebKit/533.1 (KHTML, like Gecko) Version/5.0 Mobile Safari/533.1";

type RequestOutcome = "ok" | "http_error" | "timeout" | "network_error";

function stripMatchingQuotes(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function normalizeOrigin(value: string | undefined, fallback: string, bindingName: string): string {
  let candidate = (value ?? fallback).trim();
  const assignmentPrefix = `${bindingName}=`;
  if (candidate.startsWith(assignmentPrefix)) candidate = candidate.slice(assignmentPrefix.length).trim();
  candidate = stripMatchingQuotes(candidate);

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`${bindingName} must be a valid HTTP(S) origin`);
  }
  if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.username || url.password) {
    throw new Error(`${bindingName} must be a valid HTTP(S) origin`);
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error(`${bindingName} must not include a path, query, or fragment`);
  }
  return url.origin;
}

function describeFetchError(error: unknown): { errorName: string; failureKind: string; errorMessage?: string } {
  const errorName = error instanceof Error ? error.name : "UnknownError";
  const rawMessage = error instanceof Error ? error.message : "";
  const normalized = rawMessage.toLowerCase();
  let failureKind = "unknown_network_error";
  if (normalized.includes("network connection lost")) failureKind = "connection_lost";
  else if (normalized.includes("refused")) failureKind = "connection_refused";
  else if (normalized.includes("timed out") || normalized.includes("timeout")) failureKind = "connection_timeout";
  else if (normalized.includes("dns") || normalized.includes("resolve") || normalized.includes("getaddrinfo")) failureKind = "dns";
  else if (normalized.includes("invalid url") || normalized.includes("failed to parse")) failureKind = "invalid_url";

  const errorMessage = rawMessage
    ? rawMessage.replace(/https?:\/\/\S+/gi, "[url]").replace(/\b1\d{10}\b/g, "[mobile]").slice(0, 160)
    : undefined;
  return { errorName, failureKind, ...(errorMessage ? { errorMessage } : {}) };
}

function parseBusinessEnvelope(text: string): TianjiBusinessEnvelope {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (!value || typeof value !== "object" || (typeof value.code !== "string" && typeof value.code !== "number")) {
      throw new UpstreamProtocolError();
    }
    if (value.msg !== undefined && typeof value.msg !== "string") throw new UpstreamProtocolError();
    return { code: value.code, ...(value.msg === undefined ? {} : { msg: value.msg }) };
  } catch (error) {
    if (error instanceof UpstreamProtocolError) throw error;
    throw new UpstreamProtocolError();
  }
}

function sanitizeBusinessMessage(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const sanitized = message
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\b1\d{10}\b/g, "[mobile]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return sanitized || undefined;
}

function isSendCodeSuccess(envelope: TianjiBusinessEnvelope): boolean {
  const message = envelope.msg ?? "";
  if (/失败|错误|不正确|请输入|频繁|稍后|异常|限制|上限/.test(message)) return false;
  if (/成功|已发送|发送完成/.test(message)) return true;
  return String(envelope.code) === "0" || String(envelope.code) === "200";
}

function sendCodeRejection(message: string | undefined): AppError {
  if (message && /频繁|稍后|限制|上限/.test(message)) {
    return new AppError(429, "RATE_LIMITED", "验证码请求过于频繁，请稍后再试");
  }
  if (message && /手机号|手机号码/.test(message)) {
    return new AppError(400, "UPSTREAM_REJECTED", "手机号未被上游服务接受");
  }
  return new AppError(400, "UPSTREAM_REJECTED", "上游服务未确认验证码已发送");
}

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
    this.userOrigin = normalizeOrigin(
      env.TIANJI_USER_ORIGIN,
      "http://newxiaotian.tianji-inc.com",
      "TIANJI_USER_ORIGIN",
    );
    this.iotOrigin = normalizeOrigin(env.TIANJI_IOT_ORIGIN, "http://iot.tianji-inc.com", "TIANJI_IOT_ORIGIN");
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
    const upstreamUrl = new URL(path, `${origin}/`);
    let upstreamStatus: number | undefined;
    let outcome: RequestOutcome = "network_error";
    let failure: ReturnType<typeof describeFetchError> | undefined;
    try {
      // Cloudflare's global fetch rejects method-style invocation because it receives
      // TianjiUpstream as its `this` value. Detach it before calling so this remains
      // a normal Fetch API invocation while preserving dependency injection in tests.
      const fetcher = this.fetcher;
      const response = await fetcher(upstreamUrl.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          "accept-language": "zh-CN,zh;q=0.8",
          "cache-control": "no-cache",
          "user-agent": ANDROID_USER_AGENT,
        },
        body,
        signal: controller.signal,
      });
      upstreamStatus = response.status;
      if (!response.ok) {
        outcome = "http_error";
        throw new AppError(response.status >= 500 ? 502 : 400, response.status >= 500 ? "UPSTREAM_UNAVAILABLE" : "UPSTREAM_REJECTED", response.status >= 500 ? "上游服务暂时不可用" : "请求未被上游服务接受");
      }
      const text = await response.text();
      outcome = "ok";
      return text;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (controller.signal.aborted) {
        outcome = "timeout";
        throw new RetryableNetworkError(504, "UPSTREAM_TIMEOUT", "上游服务响应超时");
      }
      outcome = "network_error";
      failure = describeFetchError(error);
      throw new RetryableNetworkError(502, "UPSTREAM_UNAVAILABLE", "上游服务暂时不可用");
    } finally {
      clearTimeout(timeout);
      const log = JSON.stringify({
        event: "tianji_request",
        route: path,
        upstreamHost: upstreamUrl.hostname,
        upstreamScheme: upstreamUrl.protocol.slice(0, -1),
        success: outcome === "ok",
        outcome,
        ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
        ...(failure ?? {}),
        durationMs: Date.now() - startedAt,
      });
      if (outcome === "ok") console.info(log);
      else console.error(log);
    }
  }

  private decrypt<T>(text: string): T {
    return parseEncryptedResponse<T>(text, (ciphertext) =>
      decryptTianjiPayload(ciphertext, this.env.TIANJI_DES_KEY, this.env.TIANJI_DES_IV),
    );
  }

  private parseLogin(text: string, mobile: string, rejectedMessage: string) {
    try {
      const user = this.decrypt<TianjiUserPayload>(text);
      if (!user?.token || !user.wallet) throw new UpstreamProtocolError();
      return { mobile: user.mobile || mobile, token: user.token, balance: stringBalance(user.wallet.balance) };
    } catch (error) {
      if (!(error instanceof UpstreamProtocolError)) throw error;
      throw new AppError(400, "UPSTREAM_REJECTED", rejectedMessage);
    }
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
    const envelope = parseBusinessEnvelope(text);
    const businessMessage = sanitizeBusinessMessage(envelope.msg);
    console.info(JSON.stringify({
      event: "tianji_business_response",
      route: "/api/v1/UserApi/sendCode",
      businessCode: String(envelope.code).slice(0, 32),
      ...(businessMessage ? { businessMessage } : {}),
      accepted: isSendCodeSuccess(envelope),
    }));
    if (!isSendCodeSuccess(envelope)) throw sendCodeRejection(businessMessage);
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
    return this.parseLogin(text, mobile, "手机号或验证码不正确");
  }

  async loginWithPassword(mobile: string, password: string) {
    const text = await this.post(
      this.userOrigin,
      "/api/v1/UserApi/loginByPwd",
      "loginByPwd",
      JSON.stringify({ mobile, pwd: password }),
      "",
      10_000,
    );
    return this.parseLogin(text, mobile, "手机号或密码不正确");
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
        assertUpstreamSessionValid(text, true);
        const user = this.decrypt<TianjiUserPayload>(text);
        if (user.wallet?.balance === undefined || user.wallet.balance === null) throw new UpstreamSessionInvalidError();
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
    assertUpstreamSessionValid(text);
    const result = this.decrypt<{ order_sn?: string }>(text);
    if (!result.order_sn) throw new UpstreamProtocolError();
    console.info(JSON.stringify({ event: "water_command", kind, success: true }));
  }
}
