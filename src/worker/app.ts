import { Hono } from "hono";
import { z } from "zod";
import { D1Store } from "./database";
import { AppError, normalizeError, UpstreamSessionInvalidError } from "./errors";
import { applySecurityHeaders, assertMutationRequest } from "./security";
import {
  SESSION_TTL_MS,
  authenticate,
  clearSessionCookie,
  createSessionToken,
  hashAccount,
  hashValue,
  maskMobile,
  readSessionToken,
  sessionCookie,
} from "./session";
import type { AppDependencies, DeviceRecord, Env, Store, Upstream } from "./types";
import { TianjiUpstream } from "./upstream/client";

const mobileSchema = z.string().regex(/^1[3-9]\d{9}$/);
const loginSchema = z.object({ mobile: mobileSchema, code: z.string().regex(/^\d{4,8}$/) }).strict();
const passwordLoginSchema = z.object({ mobile: mobileSchema, password: z.string().min(1).max(128) }).strict();
const sendCodeSchema = z.object({ mobile: mobileSchema }).strict();
const deviceKeySchema = z.string().trim().min(1).max(2048);
const deviceLabelSchema = z.string().trim().min(1).max(64);
const createDeviceSchema = z.object({
  label: deviceLabelSchema,
  hotKey: deviceKeySchema.optional(),
  coldKey: deviceKeySchema.optional(),
}).strict().refine((value) => value.hotKey || value.coldKey);
const updateDeviceSchema = z.object({
  label: deviceLabelSchema.optional(),
  hotKey: deviceKeySchema.nullable().optional(),
  coldKey: deviceKeySchema.nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0);
const commandSchema = z.object({ requestId: z.string().uuid() }).strict();
const temporaryCommandSchema = commandSchema.extend({ kind: z.enum(["hot", "cold"]), deviceKey: deviceKeySchema }).strict();
const deviceIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,80}$/);

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

function parseDeviceId(value: string): string {
  const parsed = deviceIdSchema.safeParse(value);
  if (!parsed.success) throw new AppError(400, "BAD_REQUEST", "设备 ID 无效");
  return parsed.data;
}

function deviceView(device: DeviceRecord) {
  return {
    id: device.id,
    label: device.label,
    enabled: device.enabled,
    hot: { bound: Boolean(device.hot), ...(device.hot ? { fingerprint: device.hot.fingerprint } : {}) },
    cold: { bound: Boolean(device.cold), ...(device.cold ? { fingerprint: device.cold.fingerprint } : {}) },
  };
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

  app.onError(async (unknownError, c) => {
    const error = normalizeError(unknownError);
    if (unknownError instanceof UpstreamSessionInvalidError) {
      const rawToken = readSessionToken(c.req.header("cookie"));
      if (rawToken) {
        try {
          await storeFor(c.env).deleteSession(await hashValue(rawToken));
        } catch {
          console.error(JSON.stringify({ event: "session_invalidation_cleanup_failed", route: c.req.path }));
        }
      }
      c.header("set-cookie", clearSessionCookie());
    }
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
      accountHash: await hashAccount(user.mobile),
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

  app.post("/api/auth/login/password", async (c) => {
    assertMutationRequest(c);
    const { mobile, password } = await parseBody(c.req.raw, passwordLoginSchema);
    const user = await upstreamFor(c.env).loginWithPassword(mobile, password);
    const token = createSessionToken();
    const timestamp = now();
    await storeFor(c.env).putSession({
      sidHash: await hashValue(token),
      accountHash: await hashAccount(user.mobile),
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
      const store = storeFor(c.env);
      const session = await authenticate(store, c.req.header("cookie"), now());
      const balance = await upstreamFor(c.env).refreshBalance(session.mobile, session.upstreamToken);
      await store.updateBalance(session.sidHash, balance, now());
      return c.json({ ok: true, data: { authenticated: true, mobile: maskMobile(session.mobile), balance } });
    } catch (error) {
      if (error instanceof AppError && error.status === 401 && !(error instanceof UpstreamSessionInvalidError)) {
        return c.json({ ok: true, data: { authenticated: false } });
      }
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
    const devices = await store.listDevices(session.accountHash);
    return c.json({ ok: true, data: { devices: devices.map(deviceView) } });
  });

  app.post("/api/devices", async (c) => {
    assertMutationRequest(c);
    const store = storeFor(c.env);
    const session = await authenticate(store, c.req.header("cookie"), now());
    const input = await parseBody(c.req.raw, createDeviceSchema, 8_192);
    const timestamp = now();
    const record = {
      id: crypto.randomUUID(),
      accountHash: session.accountHash,
      label: input.label,
      enabled: (await store.listDevices(session.accountHash)).length === 0,
      hot: input.hotKey ? { deviceKey: input.hotKey, fingerprint: fingerprint(input.hotKey) } : null,
      cold: input.coldKey ? { deviceKey: input.coldKey, fingerprint: fingerprint(input.coldKey) } : null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await store.putDevice(record);
    return c.json({ ok: true, data: deviceView(record) }, 201);
  });

  app.patch("/api/devices/:id", async (c) => {
    assertMutationRequest(c);
    const store = storeFor(c.env);
    const session = await authenticate(store, c.req.header("cookie"), now());
    const id = parseDeviceId(c.req.param("id"));
    const input = await parseBody(c.req.raw, updateDeviceSchema, 8_192);
    const existing = await store.getDevice(session.accountHash, id);
    if (!existing) throw new AppError(404, "DEVICE_NOT_FOUND", "设备不存在");
    const hot = input.hotKey === undefined
      ? existing.hot
      : input.hotKey === null ? null : { deviceKey: input.hotKey, fingerprint: fingerprint(input.hotKey) };
    const cold = input.coldKey === undefined
      ? existing.cold
      : input.coldKey === null ? null : { deviceKey: input.coldKey, fingerprint: fingerprint(input.coldKey) };
    if (!hot && !cold) throw new AppError(400, "BAD_REQUEST", "设备至少需要绑定一个出水口");
    const updated = { ...existing, label: input.label ?? existing.label, hot, cold, updatedAt: now() };
    await store.putDevice(updated);
    return c.json({ ok: true, data: deviceView(updated) });
  });

  app.delete("/api/devices/:id", async (c) => {
    assertMutationRequest(c);
    const store = storeFor(c.env);
    const session = await authenticate(store, c.req.header("cookie"), now());
    const id = parseDeviceId(c.req.param("id"));
    if (!(await store.getDevice(session.accountHash, id))) throw new AppError(404, "DEVICE_NOT_FOUND", "设备不存在");
    await store.deleteDevice(session.accountHash, id);
    return c.json({ ok: true, data: { deleted: true } });
  });

  app.post("/api/devices/:id/activate", async (c) => {
    assertMutationRequest(c);
    const store = storeFor(c.env);
    const session = await authenticate(store, c.req.header("cookie"), now());
    const id = parseDeviceId(c.req.param("id"));
    if (!(await store.setActiveDevice(session.accountHash, id))) throw new AppError(404, "DEVICE_NOT_FOUND", "设备不存在");
    return c.json({ ok: true, data: { enabled: true } });
  });

  app.post("/api/water/temporary/start", async (c) => {
    assertMutationRequest(c);
    const store = storeFor(c.env);
    const session = await authenticate(store, c.req.header("cookie"), now());
    const { requestId, kind, deviceKey } = await parseBody(c.req.raw, temporaryCommandSchema, 4_096);
    const reservation = await store.reserveCommand(session.sidHash, requestId, kind, now());
    if (reservation === "duplicate") throw new AppError(409, "DUPLICATE_REQUEST", "该指令已处理");
    if (reservation === "rate_limited") throw new AppError(429, "RATE_LIMITED", "操作过于频繁，请稍后再试");
    await upstreamFor(c.env).startWater(kind, deviceKey, session.upstreamToken);
    return c.json({ ok: true, data: { started: true } });
  });

  for (const kind of ["hot", "cold"] as const) {
    app.post(`/api/water/${kind}/start`, async (c) => {
      assertMutationRequest(c);
      const store = storeFor(c.env);
      const session = await authenticate(store, c.req.header("cookie"), now());
      const { requestId } = await parseBody(c.req.raw, commandSchema);
      const device = await store.getActiveDevice(session.accountHash);
      const outlet = device?.[kind];
      if (!device || !outlet) throw new AppError(404, "DEVICE_NOT_FOUND", "当前设备尚未绑定对应出水口");
      const reservation = await store.reserveCommand(session.sidHash, requestId, kind, now());
      if (reservation === "duplicate") throw new AppError(409, "DUPLICATE_REQUEST", "该指令已处理");
      if (reservation === "rate_limited") throw new AppError(429, "RATE_LIMITED", "操作过于频繁，请稍后再试");
      await upstreamFor(c.env).startWater(kind, outlet.deviceKey, session.upstreamToken);
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
