import speakeasy from "speakeasy";
import qrcode from "qrcode";

const ISSUER = "R3DVoice";

export function generateTotpSecret(): string {
  // 20 bytes ASCII secret => standard Google Authenticator length.
  // We persist the base32 form so the raw HMAC key never round-trips through
  // application code as anything other than its display encoding.
  return speakeasy.generateSecret({ length: 20 }).base32;
}

export function buildOtpAuthUrl(email: string, secret: string): string {
  return speakeasy.otpauthURL({
    secret,
    label: email,
    issuer: ISSUER,
    encoding: "base32",
    algorithm: "sha1",
    digits: 6,
    period: 30,
  });
}

export async function buildQrDataUrl(otpAuthUrl: string): Promise<string> {
  return qrcode.toDataURL(otpAuthUrl, { width: 256, margin: 1 });
}

export function verifyTotpCode(secret: string, code: string): boolean {
  const trimmed = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(trimmed)) return false;
  try {
    // window: 1 = ±30s drift tolerance.
    return speakeasy.totp.verify({
      secret,
      encoding: "base32",
      token: trimmed,
      window: 1,
    });
  } catch {
    return false;
  }
}

/**
 * Like verifyTotpCode, but returns the exact 30s step counter the code matched
 * (or null if invalid). Callers persist the last-consumed step to reject
 * replays of a still-valid code within its ~90s window.
 */
export function verifyTotpCodeStep(secret: string, code: string): number | null {
  const trimmed = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(trimmed)) return null;
  try {
    // window: 1 = ±30s drift tolerance. verifyDelta returns { delta } (the
    // signed offset from the current step) when the code is valid, else undefined.
    const result = speakeasy.totp.verifyDelta({
      secret,
      encoding: "base32",
      token: trimmed,
      window: 1,
    });
    if (!result) return null;
    const currentStep = Math.floor(Date.now() / 1000 / 30);
    return currentStep + result.delta;
  } catch {
    return null;
  }
}
