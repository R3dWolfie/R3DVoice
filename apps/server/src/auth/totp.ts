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
