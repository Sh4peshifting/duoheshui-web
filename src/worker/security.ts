import type { Context } from "hono";
import { AppError } from "./errors";

export function assertMutationRequest(c: Context): void {
  const origin = c.req.header("origin");
  const expected = new URL(c.req.url).origin;
  if (!origin || origin !== expected || c.req.header("x-duoheshui-client") !== "web") {
    throw new AppError(403, "FORBIDDEN", "请求未通过安全校验");
  }
}

export function applySecurityHeaders(response: Response): void {
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("permissions-policy", "camera=(self)");
  response.headers.set("x-frame-options", "DENY");
  response.headers.set(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  );
}
