import { Hono } from "hono";
import { z } from "zod";
import { D1Store } from "./database";
import { AppError, normalizeError } from "./errors";
import { applySecurityHeaders, assertMutationRequest } from "./security";
import {
  SESSION_TTL_MS,
  authenticate,
  clearSessionCookie,
  createSessionToken,
  hashValue,
  maskMobile,
  readSessionToken,
  sessionCookie,
} from "./session";
import type { AppDependencies, DeviceKind, Env, Store, Upstream } from "./types";
import { TianjiUpstream } from "./upstream/client";

const mobileSchema = z.string().regex(/^1[3-9]\d{9}$/);
const loginSchema = z.object({ mobile: mobileSchema, code: z.string().regex(/^\d{4,8}$/) }).strict();
const sendCodeSchema = z.object({ mobile: mobileSchema }).strict();
const deviceSchema = z.object({ deviceKey: z.string().trim().min(1).max(2048), label: z.string().trim().max(64).optional() }).strict();
const commandSchema = z.object({ requestId: z.string().uuid() }).strict();

async function parseBody<T>(request: Request, schema: z.ZodType<T>, maxBytes = 2_048): Promise<T> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new AppError(400, "BAD_REQUEST", "请求参数无效");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new AppError(400, "BAD_REQUEST", "请求参数无效");
  try {
    return schema.parse(JSON.parse(text || "{}"));
  } catch {
    throw new AppError(400, "BAD_REQUEST", "请求参数无效");
  }
}

function fingerprint(deviceKey: string): string {
  return `******${deviceKey.slice(-6).toUpperCase()}`;
}

export function createApp(dependencies: AppDependencies = {}) {
  const app = new Hono<{ Bindings: Env }>();
  const now = dependencies.now ?? Date.now;
  const storeFor = (env: Env): Store => dependencies.store ?? new D1Store(env.DB, env.APP_DATA_KEY);
  const upstreamFor = (env: Env): Upstream => dependencies.upstream ?? new TianjiUpstream(env);

  app.use("*", async (c, next) => {
    if (c.req.path.startsWith("/api/")) await storeFor(c.env).cleanup(now());
    await next();
    applySecurityHeaders(c.res);
  });

  app.onError((unknownError, c) => {
    const error = normalizeError(unknownError);
    if (error.status >= 500) console.error(JSON.stringify({ event: "request_error", route: c.req.path, category: error.code }));
    const response = c.json({ ok: false, error: { code: error.code, message: error.message } }, error.status as 400);
    applySecurityHeaders(response);
    return response;
  });

  app.get("/api/health", (c) => c.json({ ok: true, data: { status: "healthy" } }));

  app.post("/api/auth/send-code", async (c) => {
    assertMutationRequest(c);
    const { mobile } = await parseBody(c.req.raw, sendCodeSchema, 1_024);
    const key = await hashValue(mobile);
    if (!(await storeFor(c.env).reserveSendCode(key, now()))) throw new AppError(429, "RATE_LIMITED", "验证码请求过于频繁");
    if (c.env?.SEND_CODE_GLOBAL && !(await c.env.SEND_CODE_GLOBAL.limit({ key: "global" })).success) throw new AppError(429, "RATE_LIMITED", "验证码服务繁忙，请稍后再试");
    await upstreamFor(c.env).sendCode(mobile);
    return c.json({ ok: true, data: { sent: true, retryAfter: 60 } });
  });

  app.post("/api/auth/login", async (c) => {
    assertMutationRequest(c);
    const { mobile, code } = await parseBody(c.req.raw, loginSchema);
    const user = await upstreamFor(c.env).login(mobile, code);
    const token = createSessionToken();
    const timestamp = now();
    await storeFor(c.env).putSession({
      sidHash: await hashValue(token),
      mobile: user.mobile,
      upstreamToken: user.token,
      balance: user.balance,
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: timestamp + SESSION_TTL_MS,
    });
    c.header("set-cookie", sessionCookie(token));
    return c.json({ ok: true, data: { authenticated: true, mobile: maskMobile(user.mobile), balance: user.balance } });
  });

  app.post("/api/auth/logout", async (c) => {
    assertMutationRequest(c);
    const rawToken = readSessionToken(c.req.header("cookie"));
    if (rawToken) await storeFor(c.env).deleteSession(await hashValue(rawToken));
    c.header("set-cookie", clearSessionCookie());
    return c.json({ ok: true, data: { authenticated: false } });
  });

  app.get("/api/me", async (c) => {
    try {
      const session = await authenticate(storeFor(c.env), c.req.header("cookie"), now());
      return c.json({ ok: true, data: { authenticated: true, mobile: maskMobile(session.mobile), balance: session.balance ?? "0.00" } });
    } catch (error) {
      if (error instanceof AppError && error.status === 401) return c.json({ ok: true, data: { authenticated: false } });
      throw error;
    }
  });

  app.post("/api/balance/refresh", async (c) => {
    assertMutationRequest(c);
    const store = storeFor(c.env);
    const session = await authenticate(store, c.req.header("cookie"), now());
    const balance = await upstreamFor(c.env).refreshBalance(session.mobile, session.upstreamToken);
    await store.updateBalance(session.sidHash, balance, now());
    return c.json({ ok: true, data: { balance } });
  });

  app.get("/api/devices", async (c) => {
    const store = storeFor(c.env);
    const session = await authenticate(store, c.req.header("cookie"), now());
    const devices = await store.listDevices(session.sidHash);
    const data: Record<DeviceKind, { bound: boolean; label: string; fingerprint?: string }> = {
      hot: { bound: false, label: "热水" },
      cold: { bound: false, label: "冷水" },
    };
    for (const device of devices) data[device.kind] = { bound: true, label: device.label, fingerprint: device.fingerprint };
    return c.json({ ok: true, data });
  });

  for (const kind of ["hot", "cold"] as const) {
    app.put(`/api/devices/${kind}`, async (c) => {
      assertMutationRequest(c);
      const store = storeFor(c.env);
      const session = await authenticate(store, c.req.header("cookie"), now());
      const { deviceKey, label } = await parseBody(c.req.raw, deviceSchema, 4_096);
      const existing = await store.getDevice(session.sidHash, kind);
      const timestamp = now();
      await store.putDevice({
        sidHash: session.sidHash,
        kind,
        label: label || (kind === "hot" ? "热水" : "冷水"),
        deviceKey,
        fingerprint: fingerprint(deviceKey),
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
      return c.json({ ok: true, data: { bound: true, label: label || (kind === "hot" ? "热水" : "冷水"), fingerprint: fingerprint(deviceKey) } });
    });

    app.delete(`/api/devices/${kind}`, async (c) => {
      assertMutationRequest(c);
      const store = storeFor(c.env);
      const session = await authenticate(store, c.req.header("cookie"), now());
      await store.deleteDevice(session.sidHash, kind);
      return c.json({ ok: true, data: { bound: false } });
    });

    app.post(`/api/water/${kind}/start`, async (c) => {
      assertMutationRequest(c);
      const store = storeFor(c.env);
      const session = await authenticate(store, c.req.header("cookie"), now());
      const { requestId } = await parseBody(c.req.raw, commandSchema);
      const device = await store.getDevice(session.sidHash, kind);
      if (!device) throw new AppError(404, "DEVICE_NOT_FOUND", "尚未绑定对应设备");
      const reservation = await store.reserveCommand(session.sidHash, requestId, kind, now());
      if (reservation === "duplicate") throw new AppError(409, "DUPLICATE_REQUEST", "该指令已处理");
      if (reservation === "rate_limited") throw new AppError(429, "RATE_LIMITED", "操作过于频繁，请稍后再试");
      await upstreamFor(c.env).startWater(kind, device.deviceKey, session.upstreamToken);
      return c.json({ ok: true, data: { started: true } });
    });
  }

  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) return c.json({ ok: false, error: { code: "NOT_FOUND", message: "接口不存在" } }, 404);
    if (c.env?.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
    return c.text("Not found", 404);
  });

  return app;
}
