import { UpstreamProtocolError } from "../errors";

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

export function parseEncryptedResponse<T>(
  responseText: string,
  decrypt: (ciphertext: string) => string,
): T {
  try {
    const outer = JSON.parse(responseText) as { data?: unknown };
    if (!("data" in outer)) throw new UpstreamProtocolError();
    const ciphertext = unwrapString(outer.data);
    const plaintext = decrypt(ciphertext);
    return JSON.parse(plaintext) as T;
  } catch (error) {
    if (error instanceof UpstreamProtocolError) throw error;
    throw new UpstreamProtocolError();
  }
}
