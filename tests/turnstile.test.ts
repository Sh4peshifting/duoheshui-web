import { describe, expect, it, vi } from "vitest";
import { verifyTurnstile } from "../src/worker/turnstile";

describe("Turnstile verification", () => {
  it("validates the token, action, hostname, and visitor IP", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        secret: "secret-key",
        response: "challenge-token",
        remoteip: "203.0.113.8",
      });
      expect(body.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
      return new Response(JSON.stringify({ success: true, hostname: "water.example.com", action: "login" }), { status: 200 });
    });

    await expect(verifyTurnstile("secret-key", "challenge-token", "203.0.113.8", "water.example.com", fetcher)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects failed, replayed, or context-mismatched tokens", async () => {
    const failed = vi.fn(async () => new Response(JSON.stringify({ success: false, "error-codes": ["timeout-or-duplicate"] }), { status: 200 }));
    await expect(verifyTurnstile("secret-key", "used-token", undefined, "water.example.com", failed)).rejects.toMatchObject({ status: 400, code: "TURNSTILE_FAILED" });

    const wrongContext = vi.fn(async () => new Response(JSON.stringify({ success: true, hostname: "other.example.com", action: "login" }), { status: 200 }));
    await expect(verifyTurnstile("secret-key", "valid-token", undefined, "water.example.com", wrongContext)).rejects.toMatchObject({ status: 400, code: "TURNSTILE_FAILED" });
  });

  it("reports Siteverify outages separately from user verification failures", async () => {
    const fetcher = vi.fn(async () => new Response("unavailable", { status: 503 }));
    await expect(verifyTurnstile("secret-key", "challenge-token", undefined, "water.example.com", fetcher)).rejects.toMatchObject({ status: 502, code: "TURNSTILE_UNAVAILABLE" });
  });
});
