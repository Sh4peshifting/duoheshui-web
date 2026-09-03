import { AppError } from "./errors";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const VERIFY_TIMEOUT_MS = 8_000;

type TurnstileResult = {
  success?: boolean;
  hostname?: string;
  action?: string;
  "error-codes"?: string[];
};

export async function verifyTurnstile(
  secret: string,
  token: string,
  remoteIp: string | undefined,
  expectedHostname: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (!secret) throw new AppError(503, "TURNSTILE_NOT_CONFIGURED", "人机验证尚未配置");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const verifyFetch = fetcher;
    const response = await verifyFetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret,
        response: token,
        ...(remoteIp ? { remoteip: remoteIp } : {}),
        idempotency_key: crypto.randomUUID(),
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new AppError(502, "TURNSTILE_UNAVAILABLE", "人机验证服务暂时不可用");

    let result: TurnstileResult;
    try {
      result = await response.json<TurnstileResult>();
    } catch {
      throw new AppError(502, "TURNSTILE_UNAVAILABLE", "人机验证服务暂时不可用");
    }
    if (!result.success) {
      const unavailable = result["error-codes"]?.includes("internal-error");
      throw new AppError(
        unavailable ? 502 : 400,
        unavailable ? "TURNSTILE_UNAVAILABLE" : "TURNSTILE_FAILED",
        unavailable ? "人机验证服务暂时不可用" : "人机验证失败，请重新验证",
      );
    }
    if (result.action !== "login" || result.hostname !== expectedHostname) {
      throw new AppError(400, "TURNSTILE_FAILED", "人机验证失败，请重新验证");
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(502, "TURNSTILE_UNAVAILABLE", "人机验证服务暂时不可用");
  } finally {
    clearTimeout(timeout);
  }
}
