import { describe, expect, it } from "vitest";
import { decryptTianjiPayload, encryptTianjiPayload } from "../src/worker/upstream/crypto";

const vectors = [
  [
    '{"mobile":"13800138000","type":"login"}',
    "JibQ81u7wO6og4g4ER7S7umfOtviVQi13NL9YzQdLZ1Vjgy9AMaOpA==",
  ],
  [
    '{"code":"123456","mobile":"13800138000"}',
    "LxwbH1X3vElemm7vMr1NMNzKdzQ1Pw88sLxMUsf2f5fhmqs4pmfSjdxgeDCSPJ9a",
  ],
  [
    '{"device_key":"TEST_DEVICE"}',
    "NoMgrusfOaMomM516cZP0bMfx9NVQ9VxKwl4ATfPVgQ=",
  ],
] as const;

describe("Tianji DES-CBC adapter", () => {
  for (const [plaintext, ciphertext] of vectors) {
    it(`matches the known vector for ${plaintext}`, () => {
      expect(encryptTianjiPayload(plaintext, "5yoOxt9w", "20190829")).toBe(ciphertext);
      expect(decryptTianjiPayload(ciphertext, "5yoOxt9w", "20190829")).toBe(plaintext);
    });
  }
});
