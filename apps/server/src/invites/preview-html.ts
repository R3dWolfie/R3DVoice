function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface Args {
  code: string;
  creatorHandle: string;
  creatorDisplayName: string;
  expiresAt: Date | null;
  maxUses: number | null;
  uses: number;
  revokedAt: Date | null;
}

export function renderInvitePreview(a: Args): string {
  const handle = escapeHtml(a.creatorHandle);
  const display = escapeHtml(a.creatorDisplayName);
  const code = escapeHtml(a.code);

  // Footer hint
  let footer = "";
  if (a.revokedAt) {
    footer = "This invite has been revoked.";
  } else if (a.expiresAt && a.expiresAt.getTime() < Date.now()) {
    footer = "This invite has expired.";
  } else if (a.maxUses !== null && a.uses >= a.maxUses) {
    footer = "This invite has been fully used.";
  } else if (a.maxUses === 1) {
    footer = "This invite is one-time use.";
  } else if (a.expiresAt) {
    const ms = a.expiresAt.getTime() - Date.now();
    const days = Math.floor(ms / 86_400_000);
    const hours = Math.floor((ms % 86_400_000) / 3_600_000);
    footer = `Expires in ${days}d ${hours}h`;
  } else {
    footer = "Invite does not expire.";
  }

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>R3DVoice — Invite from @${handle}</title>
<style>
:root { color-scheme: dark; }
body { background:#101014; color:#eee; font-family:system-ui,sans-serif; display:grid; place-items:center; min-height:100vh; margin:0; padding:24px; }
.card { background:#181820; border:1px solid #2a2a36; border-radius:14px; max-width:420px; padding:32px; text-align:center; box-shadow: 0 24px 48px -16px #0006; }
h1 { font-size:1.25rem; margin:0 0 12px; font-weight:600; }
.handle { color:#ff5468; font-weight:600; }
p { color:#b0b0c0; margin:0 0 24px; line-height:1.5; }
.btn { display:inline-block; padding:12px 24px; border-radius:8px; text-decoration:none; font-weight:500; margin:6px; }
.primary { background:#ff5468; color:#fff; }
.ghost { border:1px solid #2a2a36; color:#eee; }
.footer { color:#787888; font-size:0.875rem; margin-top:24px; }
</style></head><body>
<div class="card">
  <h1><span class="handle">${display} (@${handle})</span> invited you to R3DVoice</h1>
  <p>Open-source voice and screenshare for friends. Self-host or join an invite from someone you trust.</p>
  <a class="btn primary" href="/login?invite=${code}">Sign in</a>
  <a class="btn ghost" href="/register?invite=${code}">Create account</a>
  <div class="footer">${escapeHtml(footer)}</div>
</div></body></html>`;
}

export function renderInviteNotFound(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>R3DVoice — Invite not found</title>
<style>body{background:#101014;color:#eee;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
.card{background:#181820;border:1px solid #2a2a36;border-radius:14px;max-width:420px;padding:32px;text-align:center}
h1{margin:0 0 12px} p{color:#b0b0c0}
</style></head><body>
<div class="card"><h1>Invite not found</h1><p>This invite may be expired, revoked, or never existed.</p></div>
</body></html>`;
}
