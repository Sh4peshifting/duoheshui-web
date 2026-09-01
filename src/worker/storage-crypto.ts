const encoder = new TextEncoder();
const decoder = new TextDecoder();

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function importKey(secret: string): Promise<CryptoKey> {
  const raw = fromBase64Url(secret);
  if (raw.byteLength !== 32) throw new Error("APP_DATA_KEY must be a base64url-encoded 32-byte key");
  return crypto.subtle.importKey("raw", asArrayBuffer(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptField(value: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await importKey(secret), encoder.encode(value)));
  const tag = encrypted.slice(-16);
  const ciphertext = encrypted.slice(0, -16);
  return `v1.${toBase64Url(iv)}.${toBase64Url(ciphertext)}.${toBase64Url(tag)}`;
}

export async function decryptField(value: string, secret: string): Promise<string> {
  const [version, ivValue, ciphertextValue, tagValue] = value.split(".");
  if (version !== "v1" || !ivValue || !ciphertextValue || !tagValue) throw new Error("Unsupported encrypted field");
  const ciphertext = fromBase64Url(ciphertextValue);
  const tag = fromBase64Url(tagValue);
  const combined = new Uint8Array(ciphertext.byteLength + tag.byteLength);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.byteLength);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: asArrayBuffer(fromBase64Url(ivValue)) },
    await importKey(secret),
    asArrayBuffer(combined),
  );
  return decoder.decode(plaintext);
}
