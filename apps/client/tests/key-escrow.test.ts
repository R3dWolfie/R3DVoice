import { describe, it, expect } from "vitest";
import { generateKeyPair, wrapSecretKey, unwrapSecretKey } from "../src/renderer/src/lib/crypto.js";

describe("password-synced key escrow", () => {
  it("round-trips the secret key with the correct password", async () => {
    const kp = generateKeyPair();
    const w = await wrapSecretKey(kp.secretKey, "correct horse battery staple");
    const back = await unwrapSecretKey(w, "correct horse battery staple");
    expect(back).toBe(kp.secretKey);
  });

  it("returns null for the wrong password (cannot recover the key)", async () => {
    const kp = generateKeyPair();
    const w = await wrapSecretKey(kp.secretKey, "the-right-password-123");
    expect(await unwrapSecretKey(w, "the-wrong-password-123")).toBeNull();
  });

  it("uses a fresh salt + nonce each wrap (ciphertext differs, same key back)", async () => {
    const kp = generateKeyPair();
    const a = await wrapSecretKey(kp.secretKey, "pw");
    const b = await wrapSecretKey(kp.secretKey, "pw");
    expect(a.wrapped).not.toBe(b.wrapped);
    expect(a.salt).not.toBe(b.salt);
    expect(await unwrapSecretKey(a, "pw")).toBe(await unwrapSecretKey(b, "pw"));
  });

  it("rejects tampered ciphertext", async () => {
    const kp = generateKeyPair();
    const w = await wrapSecretKey(kp.secretKey, "pw");
    const tampered = { ...w, wrapped: w.wrapped.replace(/.$/, (c) => (c === "A" ? "B" : "A")) };
    expect(await unwrapSecretKey(tampered, "pw")).toBeNull();
  });
});
