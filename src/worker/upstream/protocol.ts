import { UpstreamProtocolError, UpstreamSessionInvalidError } from "../errors";

export interface GptechMessage {
  data: string;
  header: {
    act: string;
    device_type: "android";
    msg_id: number;
    source_model: "lg_LM-G820";
    source_sys_version: "rkq1.210420.001";
    source_version: "1.4.1";
    token: string;
    uuid: "";
  };
}

export function buildGptechMessage(
  act: string,
  encryptedData: string,
  token = "",
  now: () => number = Date.now,
): GptechMessage {
  return {
    data: encryptedData,
    header: {
      act,
      device_type: "android",
      msg_id: now(),
      source_model: "lg_LM-G820",
      source_sys_version: "rkq1.210420.001",
      source_version: "1.4.1",
      token,
      uuid: "",
    },
  };
}

export function buildGptechRequestBody(message: GptechMessage): string {
  return new URLSearchParams({ gptechMsg: JSON.stringify(message) }).toString();
}

function unwrapString(value: unknown): string {
  let current = value;
  for (let depth = 0; depth < 2; depth++) {
    if (typeof current !== "string") break;
    const trimmed = current.trim();
    if (!trimmed) throw new UpstreamProtocolError();
    if (!(trimmed.startsWith('"') && trimmed.endsWith('"'))) return trimmed;
    try {
      current = JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  if (typeof current !== "string") throw new UpstreamProtocolError();
  return current.trim();
}

function parseEnvelope(responseText: string): Record<string, unknown> {
  try {
    const value = JSON.parse(responseText) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new UpstreamProtocolError();
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof UpstreamProtocolError) throw error;
    throw new UpstreamProtocolError();
  }
}

function responseMessage(envelope: Record<string, unknown>): string {
  for (const key of ["msg", "message", "error", "info"]) {
    if (typeof envelope[key] === "string" && envelope[key].trim()) return envelope[key].trim();
  }
  return "";
}

function missingPayload(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== "string") return false;
  let normalized = value.trim();
  for (let depth = 0; depth < 2; depth++) {
    if (!normalized || normalized.toLowerCase() === "null") return true;
    if (!(normalized.startsWith('"') && normalized.endsWith('"'))) break;
    try {
      const unwrapped = JSON.parse(normalized) as unknown;
      if (typeof unwrapped !== "string") return unwrapped === null;
      normalized = unwrapped.trim();
    } catch {
      break;
    }
  }
  return !normalized || normalized.toLowerCase() === "null";
}

export function assertUpstreamSessionValid(responseText: string, requireUserPayload = false): void {
  const envelope = parseEnvelope(responseText);
  const header = envelope.header;
  const auth = header && typeof header === "object" && !Array.isArray(header)
    ? (header as Record<string, unknown>).auth
    : undefined;
  const message = responseMessage(envelope).toLowerCase();
  const tokenFailure = message.includes("token") && [
    "错误", "失效", "无效", "过期", "invalid", "error", "expired",
  ].some((keyword) => message.includes(keyword));

  if (Number(auth) === 1 || tokenFailure || (requireUserPayload && missingPayload(envelope.data))) {
    throw new UpstreamSessionInvalidError();
  }
}

export function parseEncryptedResponse<T>(
  responseText: string,
  decrypt: (ciphertext: string) => string,
): T {
  try {
    const outer = parseEnvelope(responseText);
    if (!("data" in outer)) throw new UpstreamProtocolError();
    const ciphertext = unwrapString(outer.data);
    const plaintext = decrypt(ciphertext);
    return JSON.parse(plaintext) as T;
  } catch (error) {
    if (error instanceof UpstreamProtocolError) throw error;
    throw new UpstreamProtocolError();
  }
}
