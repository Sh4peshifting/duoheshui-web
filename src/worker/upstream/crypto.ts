import CryptoJS from "crypto-js";

function parseSecret(value: string, name: string) {
  if (new TextEncoder().encode(value).length !== 8) throw new Error(`${name} must be exactly 8 bytes`);
  return CryptoJS.enc.Utf8.parse(value);
}

export function encryptTianjiPayload(plaintext: string, keyValue: string, ivValue: string): string {
  const key = parseSecret(keyValue, "TIANJI_DES_KEY");
  const iv = parseSecret(ivValue, "TIANJI_DES_IV");
  return CryptoJS.DES.encrypt(plaintext, key, {
    iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  }).ciphertext.toString(CryptoJS.enc.Base64);
}

export function decryptTianjiPayload(ciphertextBase64: string, keyValue: string, ivValue: string): string {
  const key = parseSecret(keyValue, "TIANJI_DES_KEY");
  const iv = parseSecret(ivValue, "TIANJI_DES_IV");
  const ciphertext = CryptoJS.lib.CipherParams.create({
    ciphertext: CryptoJS.enc.Base64.parse(ciphertextBase64),
  });
  const plaintext = CryptoJS.DES.decrypt(ciphertext, key, {
    iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  }).toString(CryptoJS.enc.Utf8);
  if (!plaintext) throw new Error("DES decryption produced empty or invalid UTF-8");
  return plaintext;
}
