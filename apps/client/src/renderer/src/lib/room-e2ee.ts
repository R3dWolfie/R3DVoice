// Room SFrame key distribution. The "key" is a 32-byte random shared secret
// that LiveKit's E2EE worker uses to encrypt/decrypt media frames. The
// secret never leaves a participant's machine in cleartext - when a member
// joins, the owner (or any current key-holder) NaCl-box-encrypts the secret
// to the joiner's public key and ships it over LiveKit's data channel. The
// SFU forwards the box ciphertext like any other data packet, never seeing
// the secret.
//
// Threat model recap:
// - SFU operator cannot read media (SFrame on top) or the key (NaCl box).
// - Anyone with valid room access (owner-allowed or public-room joiner) can
//   request the key. Authorization gate is the server-side allow-list, not
//   this protocol.
// - A malicious participant in the room sees plaintext - they're a peer.
//   That's outside our threat model.
//
// What's NOT yet implemented (deferred to B.5):
// - Forward secrecy: when someone leaves, the key isn't rotated yet.

import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";
import {
  RoomEvent,
  type Participant,
  type RemoteParticipant,
  DataPacket_Kind,
} from "livekit-client";
import { encryptBytes, decryptBytes, type KeyPair, type EncryptedBytes } from "./crypto.js";
import type { LiveKitRoom } from "./livekit-room.js";

// All E2EE control messages flow over the same data channel as chat. We
// tag each payload with `kind` and ignore anything that doesn't match.
type KeyRequest = {
  kind: "e2ee:key-request";
  /** Sender's NaCl box public key (base64) - receiver encrypts the key with this. */
  pubkey: string;
};

type KeyOffer = {
  kind: "e2ee:key-offer";
  /** NaCl-box-encrypted 32-byte SFrame key. */
  encrypted: EncryptedBytes;
};

type E2EEMessage = KeyRequest | KeyOffer;

// Metadata helpers - we publish our pubkey via Participant.metadata so peers
// can preload it before any data is exchanged. Falls back to per-message
// pubkey transport (KeyRequest carries it) if metadata isn't propagated yet.
const META_PUBKEY_FIELD = "e2eePubkey";

function readPubkeyFromMeta(p: Participant): string | null {
  if (!p.metadata) return null;
  try {
    const meta = JSON.parse(p.metadata) as Record<string, unknown>;
    const pk = meta[META_PUBKEY_FIELD];
    return typeof pk === "string" ? pk : null;
  } catch {
    return null;
  }
}

function makeMetadataWithPubkey(existing: string | undefined, pubkey: string): string {
  let base: Record<string, unknown> = {};
  if (existing) {
    try { base = JSON.parse(existing) as Record<string, unknown>; } catch { /* */ }
  }
  base[META_PUBKEY_FIELD] = pubkey;
  return JSON.stringify(base);
}

const KEY_REQUEST_RETRY_MS = 3_000;
const KEY_REQUEST_MAX_ATTEMPTS = 5;

interface Options {
  roomWrapper: LiveKitRoom;
  isOwner: boolean;
  /** Local participant's NaCl box keypair (the one used for DMs). */
  keyPair: KeyPair;
  /** Notified when the room key is successfully applied (UI lights padlock). */
  onKeyApplied?: () => void;
  /** Notified on any error (UI shows red padlock). */
  onError?: (err: Error) => void;
}

export class RoomE2EE {
  private opts: Options;
  /** The shared SFrame secret. Owner generates; members receive. */
  private roomKey: Uint8Array | null = null;
  private cleanups: Array<() => void> = [];
  private requestAttempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: Options) {
    this.opts = opts;
  }

  /** Begin the protocol. Idempotent - second start() is a no-op. */
  async start(): Promise<void> {
    if (this.cleanups.length > 0) return;
    const room = this.opts.roomWrapper.room;

    // 1. Publish our pubkey via metadata so newly-arriving peers can find it.
    try {
      const next = makeMetadataWithPubkey(room.localParticipant.metadata, this.opts.keyPair.publicKey);
      await room.localParticipant.setMetadata(next);
    } catch {
      // Metadata may be locked behind server settings; KeyRequest still
      // carries the pubkey, so this isn't fatal.
    }

    // 2. Wire DataChannel + participant events.
    const onData = (
      payload: Uint8Array,
      participant?: RemoteParticipant,
      _kind?: DataPacket_Kind,
    ): void => { void this.handleData(payload, participant); };
    room.on(RoomEvent.DataReceived, onData);
    this.cleanups.push(() => room.off(RoomEvent.DataReceived, onData));

    const onParticipantConnected = (p: RemoteParticipant): void => {
      // If we're the owner and have the key, proactively offer it after a
      // short delay (giving the new peer time to set their pubkey metadata).
      if (this.roomKey && this.opts.isOwner) {
        setTimeout(() => void this.offerKeyTo(p), 750);
      }
    };
    room.on(RoomEvent.ParticipantConnected, onParticipantConnected);
    this.cleanups.push(() => room.off(RoomEvent.ParticipantConnected, onParticipantConnected));

    // 3. Owner: generate the key right now (or use existing if rejoined).
    //    Member: ask whoever's there for it.
    if (this.opts.isOwner) {
      await this.becomeOwnerWithFreshKey();
    } else {
      this.scheduleKeyRequest(0);
    }
  }

  /** Stop listening, clear retries. Doesn't disable the room's E2EE state. */
  stop(): void {
    for (const c of this.cleanups) c();
    this.cleanups = [];
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.requestAttempts = 0;
  }

  private async becomeOwnerWithFreshKey(): Promise<void> {
    const key = nacl.randomBytes(32);
    this.roomKey = key;
    try {
      await this.opts.roomWrapper.setRoomKey(key.buffer.slice(0) as ArrayBuffer);
      this.opts.onKeyApplied?.();
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error("setRoomKey failed"));
    }
  }

  private scheduleKeyRequest(delayMs: number): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.sendKeyRequest(), delayMs);
  }

  private async sendKeyRequest(): Promise<void> {
    if (this.roomKey) return; // already received
    if (this.requestAttempts >= KEY_REQUEST_MAX_ATTEMPTS) {
      this.opts.onError?.(new Error("no key holder responded after several attempts"));
      return;
    }
    this.requestAttempts++;
    const msg: KeyRequest = { kind: "e2ee:key-request", pubkey: this.opts.keyPair.publicKey };
    await this.broadcast(msg);
    // Retry until someone answers.
    this.scheduleKeyRequest(KEY_REQUEST_RETRY_MS);
  }

  private async handleData(payload: Uint8Array, participant?: RemoteParticipant): Promise<void> {
    if (!participant) return;
    let msg: E2EEMessage;
    try {
      const txt = new TextDecoder().decode(payload);
      const parsed = JSON.parse(txt) as { kind?: string };
      if (parsed.kind !== "e2ee:key-request" && parsed.kind !== "e2ee:key-offer") return;
      msg = parsed as E2EEMessage;
    } catch {
      return; // not for us
    }

    if (msg.kind === "e2ee:key-request") {
      if (!this.roomKey) return; // we don't have the key either
      const senderPubkey = msg.pubkey || readPubkeyFromMeta(participant);
      if (!senderPubkey) return;
      const encrypted = encryptBytes(this.roomKey, senderPubkey, this.opts.keyPair);
      const offer: KeyOffer = { kind: "e2ee:key-offer", encrypted };
      await this.sendTo(participant.identity, offer);
    } else {
      // key-offer
      if (this.roomKey) return; // already have one - first one wins, ignore late arrivals
      const decrypted = decryptBytes(msg.encrypted, this.opts.keyPair);
      if (!decrypted) {
        this.opts.onError?.(new Error("failed to decrypt room key offer"));
        return;
      }
      this.roomKey = decrypted;
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      try {
        // .buffer is shared underlying memory; slice() copies so the room
        // worker doesn't accidentally see the same bytes mutate.
        await this.opts.roomWrapper.setRoomKey(decrypted.buffer.slice(0) as ArrayBuffer);
        this.opts.onKeyApplied?.();
      } catch (err) {
        this.opts.onError?.(err instanceof Error ? err : new Error("setRoomKey failed"));
      }
    }
  }

  /** Owner-only: send the room key to a specific newcomer. */
  private async offerKeyTo(p: RemoteParticipant): Promise<void> {
    if (!this.roomKey) return;
    const recipientPubkey = readPubkeyFromMeta(p);
    if (!recipientPubkey) return; // they haven't published their pubkey yet
    const encrypted = encryptBytes(this.roomKey, recipientPubkey, this.opts.keyPair);
    const offer: KeyOffer = { kind: "e2ee:key-offer", encrypted };
    await this.sendTo(p.identity, offer);
  }

  private encode(msg: E2EEMessage): Uint8Array<ArrayBuffer> {
    // livekit-client 2.20+ requires a plain-ArrayBuffer-backed Uint8Array for
    // publishData (not the SharedArrayBuffer-capable ArrayBufferLike that
    // TextEncoder returns). Copy into a fresh, plain-backed array.
    const encoded = new TextEncoder().encode(JSON.stringify(msg));
    const out = new Uint8Array(encoded.length);
    out.set(encoded);
    return out;
  }

  private async broadcast(msg: E2EEMessage): Promise<void> {
    await this.opts.roomWrapper.room.localParticipant.publishData(
      this.encode(msg),
      { reliable: true },
    );
  }

  private async sendTo(identity: string, msg: E2EEMessage): Promise<void> {
    await this.opts.roomWrapper.room.localParticipant.publishData(
      this.encode(msg),
      { reliable: true, destinationIdentities: [identity] },
    );
  }
}

// Re-export the helpers callers might need.
export { readPubkeyFromMeta };
// eslint-disable-next-line no-restricted-imports
export type { KeyPair };
// suppress unused-import noise (naclUtil is loaded by encryptBytes/decryptBytes already)
void naclUtil;
