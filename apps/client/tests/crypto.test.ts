import { describe, expect, it } from "vitest";
import { decryptDM, encryptDM, generateKeyPair } from "../src/renderer/src/lib/crypto.js";

describe("DM E2EE", () => {
  it("recipient decrypts using the envelope sender key", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const env = encryptDM("hi bob", bob.publicKey, alice);
    expect(decryptDM(env, bob)).toBe("hi bob");
  });

  it("SENDER decrypts their own message via the counterparty key (regression)", () => {
    // box's shared secret is ECDH(myPriv, otherPub); for self-authored
    // envelopes payload.s is my own key, so decrypt must be given the
    // recipient's key or it computes ECDH(me, me) and fails — the
    // 'Sent before this device had your key' wall of 2026-07-17.
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const env = encryptDM("hi bob", bob.publicKey, alice);
    expect(decryptDM(env, alice)).toBeNull(); // without counterparty: impossible
    expect(decryptDM(env, alice, bob.publicKey)).toBe("hi bob");
  });

  it("wrong keys fail closed", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const mallory = generateKeyPair();
    const env = encryptDM("secret", bob.publicKey, alice);
    expect(decryptDM(env, mallory)).toBeNull();
    expect(decryptDM(env, mallory, alice.publicKey)).toBeNull();
  });
});
