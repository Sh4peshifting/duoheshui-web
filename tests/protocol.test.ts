import { describe, expect, it, vi } from "vitest";
import { buildGptechMessage, buildGptechRequestBody } from "../src/worker/upstream/protocol";

describe("gptechMsg protocol", () => {
  it("builds a fresh message and form-encodes it exactly once", () => {
    const now = vi.fn().mockReturnValueOnce(1_690_000_000_000).mockReturnValueOnce(1_690_000_000_001);
    const first = buildGptechMessage("sendCode", "cipher+/=", "", now);
    const second = buildGptechMessage("sendCode", "cipher+/=", "", now);

    expect(first.header).toMatchObject({
      act: "sendCode",
      token: "",
      msg_id: 1_690_000_000_000,
      source_version: "1.4.1",
      device_type: "android",
    });
    expect(second.header.msg_id).toBe(1_690_000_000_001);

    const body = buildGptechRequestBody(first);
    const parsed = new URLSearchParams(body);
    expect(parsed.get("gptechMsg")).toBe(JSON.stringify(first));
    expect(body).not.toContain("%252B");
  });
});
