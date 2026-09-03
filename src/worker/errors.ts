export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "DEVICE_NOT_FOUND"
  | "DUPLICATE_REQUEST"
  | "RATE_LIMITED"
  | "TURNSTILE_FAILED"
  | "TURNSTILE_NOT_CONFIGURED"
  | "TURNSTILE_UNAVAILABLE"
  | "UPSTREAM_REJECTED"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_PROTOCOL_ERROR"
  | "UPSTREAM_TIMEOUT"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class UpstreamProtocolError extends AppError {
  constructor(message = "上游服务返回了无法解析的数据") {
    super(502, "UPSTREAM_PROTOCOL_ERROR", message);
    this.name = "UpstreamProtocolError";
  }
}

export class UpstreamSessionInvalidError extends AppError {
  constructor() {
    super(401, "UNAUTHENTICATED", "上游登录状态已失效，请重新登录");
    this.name = "UpstreamSessionInvalidError";
  }
}

export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) {
    const candidate = error as Error & { status?: number; code?: ErrorCode };
    if (candidate.status && candidate.code) return new AppError(candidate.status, candidate.code, candidate.message);
  }
  return new AppError(500, "INTERNAL_ERROR", "服务暂时不可用");
}
