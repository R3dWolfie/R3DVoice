# Wireframe port audit — 2026-07-17

Full-coverage audit of all 76 deck wireframes (`WireFrames/` on Synology-Reddie)
against the app, after phases 0–6 of the redesign/cherry port. Statuses updated
for same-day fixes. This is the working checklist for "port everything".

## Fixed same-day (already live)
- 2.5k message menu (copy/edit/delete) · 2.5l typing indicator (WS relay)
- 2.4a peer profile popover · 4.16 invite-friends (members tab) · 4.18 cheatsheet
- 4.14 reset theme · system/error-boundary
- Bugs: UpdateToast undefined tokens, ScreenPickerDialog pre-deck classes,
  --accent-instead-of---danger error text (3 files), Splash crimson vignette,
  hardcoded About version.

## Standing style decision
Deck 3.6 defines `--accent` as ink (#1a1a1a) with Cherry only at "Subtle"
spots; the app deliberately runs `--accent` = Cherry (#e11d48) at
~brand-accents intensity. One-line flip in styles.css if Red wants deck-literal.

## A — client-only remainder
| Item | Detail |
|---|---|
| 3.6 Theme editor | Grey preset, per-token hex editor + live preview, preview card; 4.14 → export/override-count modal |
| 3.1 Devices | camera select + preview/stats (3.1a), resolution/mirror, live mic meter, speaker test, inline permission-denied blocks (3.1b) |
| 3.7 Notifications | default-room-behavior selector, sound pickers (assets), quiet hours |
| Toast host | runtime toast manager surfacing .rv-toast (success/undo/info/warn/error, copy-link confirmations) |
| Connection banners | app-wide Reconnecting/Offline variants + "Retry now" |
| 2.5g | add "Mute for me" + "View profile" to tile menu |
| 2.5j | step-list connecting screen (auth/resolve/negotiate + cancel) |
| 2.5o | slash commands |
| 2.5m | emoji category tabs |
| 2.4b | timed mute popover (1h/3h/8h/24h/∞) replacing plain select |
| 2.4d | full user menu (view profile, send DM, invite, mute, copy handle, remove friend) |
| 2.4a | shared-rooms/friend counts + block/remove buttons (block needs server) |
| 2.2a | live @handle match preview |
| 4.1 | friend-list picker instead of bare input |
| 4.3 | in-app corner invite queue (join/dismiss/dismiss-all) |
| 4.16 | standalone modal w/ "recently in voice" grouping |
| 4.17 | transfer confirm modal (type-name, impact, also-leave) |
| 4.9c1/4.9c2 | edit-invite modal, regenerate, max-uses tiers (2.3b) |
| 4.9d | restore 2-step impact→type-name |
| 2.3 | invites list: full URLs + copy + room-name resolution |
| 1.8 | dedicated key-restore screen (drag-drop, fingerprint match) |
| 1.1a | attempt counter + error code line |
| 4.10 | pre-update changelog modal (Electron) |
| Error boundary | relaunch/send-report/diagnostic id |
| 2.5d/2.5e | verify 20-person grid + multi-share at scale (needs live bodies) |

## B — small server additions (each unblocks screens)
1. Block/unblock endpoint (`blocked` enum exists, no route) → 3.3a, 4.13, 2.4a/d
2. Session list + revoke-all → 4.11
3. Delete-account endpoint → 4.12
4. TOTP backup codes → 3.3b
5. Pins (pin/unpin/list) → 2.5p
6. Message reactions → completes 2.5k
7. ~~Mentions history + directed room invites~~ DONE — 4.15 bell tabs live (feed endpoint, DirectInvite table, count-badged tabs, day groups, Join/Later, Mark-all-read watermark, bell badge, 4.16 invite-friends rows)

## C — blocked on decisions
1. SMTP provider (Migadu available) → 1.5, 1.6, 1.7 email flows
2. Private (invite-only) room tier → third privacy segment in 4.8/4.9
3. Co-owner role → 4.9b "Make co-owner", 4.17 badge

## Visual QA pass (same day) — remaining after batch 1
Fixed in batch 1: DM mute popover + header identity/avatar, composer order,
live titlebar label, add-menu chips + copy, rail presence dot, keybind
ghost rename + scope tags, settings viewport clamp, login forgot link.

DONE later same day: live occupancy (inCall via presence groupBy — lobby
rows "N in call" + dots + WS live-refresh, browse "in voice" sort), chat
history scroll-up pagination, deleted messages hidden (tombstone gaps),
DM header E2EE pill, sender-side E2EE decrypt bug + regression test.

Still open (ranked): DM header presence/status line; Theme
token editor + preview card + Grey preset + export/import; Notifications
sounds/quiet-hours/desktop-integration/default-room segmented; Devices
video section (camera select/preview/resolution/mirror) + mic meter +
speaker test; browse directory card-grid form + show-empty toggle + owner
attribution; DMs sidebar search + open-thread-in-list; friends ⋮ overflow
(pending-sent + manage links) + PTT hint strip; keybind populated
defaults; Account sign-out+clear-keys + always-visible backup button;
settings nav-foot identity card; monochrome-icon sweep (remaining emoji
glyphs).
