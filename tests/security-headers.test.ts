import { describe, expect, it } from "vitest";
import staticHeaders from "../public/_headers?raw";
import { CONTENT_SECURITY_POLICY } from "../src/worker/security";

function getStaticContentSecurityPolicy(): string | undefined {
  return staticHeaders
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("Content-Security-Policy:"))
    ?.slice("Content-Security-Policy:".length)
    .trim();
}

describe("security headers", () => {
  it("keeps the static asset and Worker content security policies in sync", () => {
    expect(getStaticContentSecurityPolicy()).toBe(CONTENT_SECURITY_POLICY);
  });

  it("allows the external resources used by Turnstile and Cloudflare Web Analytics", () => {
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com");
    expect(CONTENT_SECURITY_POLICY).toContain("frame-src https://challenges.cloudflare.com");
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'self'");
  });
});
