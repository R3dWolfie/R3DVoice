import nodemailer, { type Transporter } from "nodemailer";
import { getConfig } from "../config.js";

/**
 * Thin mail layer. Email is optional: when SMTP_HOST is unset the whole
 * feature is off - emailEnabled() is false and sendMail() is a no-op that
 * logs. That keeps self-hosters without a mail server fully functional
 * (registration auto-verifies; the reset link just isn't offered).
 */
let transporter: Transporter | null = null;

// Test seam: when set, every message is handed to this sink instead of SMTP,
// and email is treated as enabled. Lets tests read the verify/reset link
// (which carries the raw token) without a real mail server.
let testSink: ((mail: OutgoingMail) => void) | null = null;

export function __setMailSinkForTests(sink: ((mail: OutgoingMail) => void) | null): void {
  testSink = sink;
}

export function emailEnabled(): boolean {
  return Boolean(testSink) || Boolean(getConfig().SMTP_HOST);
}

function getTransporter(): Transporter | null {
  if (!emailEnabled()) return null;
  if (transporter) return transporter;
  const cfg = getConfig();
  transporter = nodemailer.createTransport({
    host: cfg.SMTP_HOST!,
    port: cfg.SMTP_PORT,
    secure: cfg.SMTP_PORT === 465, // implicit TLS on 465, STARTTLS otherwise
    auth: cfg.SMTP_USER ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS } : undefined,
  });
  return transporter;
}

/** For tests: drop the cached transport so config changes take effect. */
export function __resetMailerForTests(): void {
  transporter = null;
}

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export async function sendMail(mail: OutgoingMail): Promise<void> {
  if (testSink) {
    testSink(mail);
    return;
  }
  const t = getTransporter();
  if (!t) {
    // eslint-disable-next-line no-console
    console.info(`[email disabled] would send "${mail.subject}" to ${mail.to}`);
    return;
  }
  await t.sendMail({ from: getConfig().SMTP_FROM, ...mail });
}
