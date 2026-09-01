import type { SessionRecord, Store } from "./types";
import { AppError } from "./errors";

const COOKIE_NAME = "duoheshui_session";
export const SESSION_TTL_SECONDS = 365 * 24 * 60 * 60;
export const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1_000;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function createSessionToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashValue(value: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

export function sessionCookie(token: string): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

export function readSessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) return rest.join("=") || null;
  }
  return null;
}

export async function authenticate(store: Store, cookieHeader: string | undefined, now: number): Promise<SessionRecord> {
  const token = readSessionToken(cookieHeader);
  if (!token) throw new AppError(401, "UNAUTHENTICATED", "请先登录");
  const session = await store.getSession(await hashValue(token));
  if (!session || session.expiresAt <= now) throw new AppError(401, "UNAUTHENTICATED", "登录状态已过期");
  return session;
}

export function maskMobile(mobile: string): string {
  return `${"*".repeat(Math.max(0, mobile.length - 4))}${mobile.slice(-4)}`;
}
