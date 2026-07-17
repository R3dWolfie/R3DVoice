import { getConfig } from "../config.js";

// Plain, deliverability-friendly transactional emails. Inline styles only,
// no remote assets — matches the R3DVoice ink-on-paper look without tripping
// spam heuristics.
const WRAP = (inner: string): string => `
<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#f4f4f5;padding:32px 16px">
  <div style="max-width:440px;margin:0 auto;background:#fff;border:1px solid #e4e4e7;border-radius:12px;overflow:hidden">
    <div style="padding:20px 28px;border-bottom:1px solid #eee;font-weight:700;letter-spacing:.18em;font-size:12px;color:#1a1a1a">R3DVOICE</div>
    <div style="padding:28px">${inner}</div>
  </div>
  <div style="max-width:440px;margin:12px auto 0;color:#a1a1aa;font-size:11px;text-align:center">R3DVoice · self-hostable · voice.r3dwolfie.com</div>
</div>`;

const BUTTON = (href: string, label: string): string =>
  `<a href="${href}" style="display:inline-block;background:#e11d48;color:#fff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:600;font-size:14px">${label}</a>`;

export function verifyEmail(displayName: string, link: string): { subject: string; text: string; html: string } {
  return {
    subject: "Verify your R3DVoice email",
    text: `Hi ${displayName},\n\nConfirm your email to finish setting up R3DVoice:\n${link}\n\nThis link expires in 24 hours. If you didn't create an account, ignore this email.`,
    html: WRAP(
      `<p style="margin:0 0 8px;font-size:16px;font-weight:600;color:#1a1a1a">Verify your email</p>
       <p style="margin:0 0 20px;font-size:14px;color:#52525b;line-height:1.5">Hi ${displayName}, confirm this address to finish setting up your account.</p>
       <p style="margin:0 0 20px">${BUTTON(link, "Verify email")}</p>
       <p style="margin:0;font-size:12px;color:#a1a1aa">Link expires in 24 hours. Didn't sign up? Ignore this email.</p>`,
    ),
  };
}

export function passwordResetEmail(displayName: string, link: string): { subject: string; text: string; html: string } {
  return {
    subject: "Reset your R3DVoice password",
    text: `Hi ${displayName},\n\nReset your R3DVoice password:\n${link}\n\nThis link expires in 1 hour and can be used once. If you didn't request this, ignore this email — your password is unchanged.`,
    html: WRAP(
      `<p style="margin:0 0 8px;font-size:16px;font-weight:600;color:#1a1a1a">Reset your password</p>
       <p style="margin:0 0 20px;font-size:14px;color:#52525b;line-height:1.5">Hi ${displayName}, click below to choose a new password.</p>
       <p style="margin:0 0 20px">${BUTTON(link, "Reset password")}</p>
       <p style="margin:0;font-size:12px;color:#a1a1aa">Link expires in 1 hour, single use. Didn't ask? Your password is unchanged.</p>`,
    ),
  };
}

/** Small self-contained HTML page shown when a verify link is clicked. */
export function verifyResultPage(ok: boolean): string {
  const cfg = getConfig();
  const title = ok ? "Email verified" : "Link expired";
  const msg = ok
    ? "Your email is confirmed. You can return to R3DVoice and sign in."
    : "This verification link is invalid or has expired. Sign in and request a new one.";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · R3DVoice</title></head>
<body style="margin:0;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#f4f4f5;display:grid;place-items:center;min-height:100vh">
  <div style="max-width:400px;background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:32px;text-align:center">
    <div style="font-weight:700;letter-spacing:.18em;font-size:12px;color:#1a1a1a;margin-bottom:20px">R3DVOICE</div>
    <div style="font-size:40px;margin-bottom:12px">${ok ? "✓" : "⚠"}</div>
    <p style="font-size:17px;font-weight:600;color:#1a1a1a;margin:0 0 8px">${title}</p>
    <p style="font-size:14px;color:#52525b;line-height:1.5;margin:0 0 24px">${msg}</p>
    <a href="${cfg.APP_URL}" style="display:inline-block;background:#e11d48;color:#fff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:600;font-size:14px">Open R3DVoice</a>
  </div>
</body></html>`;
}
