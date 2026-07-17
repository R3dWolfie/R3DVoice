import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from "react";
import type { DirectInviteDTO, MentionFeedItemDTO } from "@r3dvoice/shared";
import { useAuthStore } from "../lib/auth-context.js";
import { ApiClient } from "../lib/api.js";
import {
  useNotificationsStore,
  unseenCount,
  wireNotificationsToTransport,
} from "../lib/notifications-store.js";
import { useUnreadStore } from "../lib/unread-store.js";
import { Avatar } from "./Avatar.js";

// Bell panel per WireFrames 4.15: header with unread count + "Mark all read",
// count-badged tabs (All / Invites / Mentions / Friends), day-grouped rows —
// friend requests (Accept/Decline), room invites (Join/Later, expiry line),
// mentions (room context + excerpt), unread-DM rollups — and a footer link
// into notification settings.
type Tab = "all" | "invites" | "mentions" | "friends";

function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60_000) return "just now";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

function expiresIn(iso: string): string | null {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return "expired";
  const h = Math.ceil(ms / 3_600_000);
  return h >= 2 ? `expires in ${h}h` : `expires in ${Math.max(1, Math.ceil(ms / 60_000))}m`;
}

function dayBucket(iso: string): "Today" | "Yesterday" | "Earlier" {
  const d = new Date(iso);
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.getTime() >= midnight) return "Today";
  if (d.getTime() >= midnight - 86_400_000) return "Yesterday";
  return "Earlier";
}

/** One notification row: avatar + kind-glyph, body, meta line, optional actions. */
function Row({
  avatar,
  glyph,
  children,
  meta,
  actions,
  highlight,
}: {
  avatar: ReactNode;
  glyph: string;
  children: ReactNode;
  meta: string;
  actions?: ReactNode;
  highlight?: boolean;
}): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        gap: "var(--s-3)",
        padding: "var(--s-3)",
        borderRadius: "var(--r-sm)",
        background: highlight ? "var(--accent-tint)" : "transparent",
        marginBottom: "var(--s-1)",
        alignItems: "flex-start",
      }}
    >
      <span style={{ position: "relative", flexShrink: 0 }}>
        {avatar}
        <span
          aria-hidden
          style={{
            position: "absolute",
            bottom: -3,
            right: -3,
            width: 15,
            height: 15,
            borderRadius: "50%",
            background: "var(--bg-elev)",
            border: "1px solid var(--border-soft)",
            display: "grid",
            placeItems: "center",
            fontSize: 9,
            color: "var(--text-dim)",
            lineHeight: 1,
          }}
        >
          {glyph}
        </span>
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "var(--t-xs)", lineHeight: 1.45, overflowWrap: "anywhere" }}>{children}</div>
        <div style={{ fontSize: "var(--t-2xs)", color: "var(--text-dim)", marginTop: 2 }}>{meta}</div>
        {actions && <div style={{ display: "flex", gap: "var(--s-2)", marginTop: "var(--s-2)" }}>{actions}</div>}
      </div>
    </div>
  );
}

function SmallBtn({
  children,
  primary,
  onClick,
}: {
  children: ReactNode;
  primary?: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      className="rv-btn"
      {...(primary ? { "data-variant": "primary" } : {})}
      style={{ height: "1.6rem", fontSize: "var(--t-2xs)", padding: "0 var(--s-3)" }}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function NotificationsPanel({
  open,
  onClose,
  onOpenDms,
  onOpenFriends,
  onJoinRoom,
  onOpenSettings,
}: {
  open: boolean;
  onClose: () => void;
  onOpenDms: () => void;
  onOpenFriends: () => void;
  onJoinRoom?: ((roomId: string) => void) | undefined;
  onOpenSettings?: (() => void) | undefined;
}): ReactElement | null {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const counts = useUnreadStore((s) => s.counts);
  const seenAt = useNotificationsStore((s) => s.seenAt);
  const mentions = useNotificationsStore((s) => s.mentions);
  const invites = useNotificationsStore((s) => s.invites);
  const friendRequests = useNotificationsStore((s) => s.friendRequests);
  const refresh = useNotificationsStore((s) => s.refresh);
  const markAllRead = useNotificationsStore((s) => s.markAllRead);
  const removeInvite = useNotificationsStore((s) => s.removeInvite);
  const removeFriendRequest = useNotificationsStore((s) => s.removeFriendRequest);
  const [tab, setTab] = useState<Tab>("all");

  const apiFor = useCallback(() => {
    const api = new ApiClient(serverUrl);
    api.setToken(token);
    return api;
  }, [serverUrl, token]);

  useEffect(() => {
    if (open) {
      wireNotificationsToTransport();
      void refresh();
    }
  }, [open, refresh]);

  if (!open) return null;

  const dmUnread = Object.entries(counts)
    .filter(([key, n]) => key.startsWith("dm:") && n > 0)
    .reduce((acc, [, n]) => acc + n, 0);
  const seen = seenAt ? Date.parse(seenAt) : 0;
  const freshMentions = mentions.filter((m) => Date.parse(m.message.createdAt) > seen);
  const totalUnseen = unseenCount({ seenAt, mentions, invites, friendRequests });

  const actFriend = async (id: string, kind: "accept" | "reject"): Promise<void> => {
    removeFriendRequest(id);
    try {
      if (kind === "accept") await apiFor().friendAccept(id);
      else await apiFor().friendReject(id);
    } catch {
      void refresh(); // restore on failure
    }
  };

  const actInvite = async (inv: DirectInviteDTO, kind: "join" | "later"): Promise<void> => {
    removeInvite(inv.id);
    try {
      if (kind === "join") {
        const res = await apiFor().directInviteAccept(inv.id);
        onClose();
        onJoinRoom?.(res.roomId);
      } else {
        await apiFor().directInviteDecline(inv.id);
      }
    } catch {
      void refresh();
    }
  };

  const tabs: Array<{ key: Tab; label: string; count: number }> = [
    { key: "all", label: "All", count: totalUnseen },
    { key: "invites", label: "Invites", count: invites.length },
    { key: "mentions", label: "Mentions", count: freshMentions.length },
    { key: "friends", label: "Friends", count: friendRequests.length },
  ];

  // Assemble visible rows for the active tab, then group by day.
  type Item =
    | { kind: "friend"; at: string; f: (typeof friendRequests)[number] }
    | { kind: "invite"; at: string; inv: DirectInviteDTO }
    | { kind: "mention"; at: string; m: MentionFeedItemDTO };
  const items: Item[] = [];
  if (tab === "all" || tab === "friends")
    for (const f of friendRequests) items.push({ kind: "friend", at: new Date().toISOString(), f });
  if (tab === "all" || tab === "invites")
    for (const inv of invites) items.push({ kind: "invite", at: inv.createdAt, inv });
  if (tab === "all" || tab === "mentions")
    for (const m of mentions) items.push({ kind: "mention", at: m.message.createdAt, m });
  items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const groups: Array<{ day: string; items: Item[] }> = [];
  for (const it of items) {
    const day = it.kind === "friend" ? "Today" : dayBucket(it.at);
    const g = groups[groups.length - 1];
    if (g && g.day === day) g.items.push(it);
    else groups.push({ day, items: [it] });
  }

  const showDmRollup = (tab === "all" || tab === "mentions") && dmUnread > 0;
  const empty = items.length === 0 && !showDmRollup;

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 60, background: "transparent" }} />
      <div
        className="rv-fade-in"
        style={{
          position: "absolute",
          left: "100%",
          top: 0,
          marginLeft: 8,
          width: 360,
          maxHeight: 480,
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: "var(--r-md)",
          boxShadow: "var(--shadow-2)",
          zIndex: 61,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "var(--s-3) var(--s-4)",
            borderBottom: "1px solid var(--border-soft)",
            display: "flex",
            alignItems: "baseline",
            gap: "var(--s-2)",
          }}
        >
          <span style={{ fontSize: "var(--t-sm)", fontWeight: 600 }}>Notifications</span>
          <span className="rv-mono" style={{ fontSize: "var(--t-2xs)", color: "var(--text-dim)" }}>
            {totalUnseen > 0 ? `${totalUnseen} unread` : "all caught up"}
          </span>
          <span style={{ flex: 1 }} />
          {totalUnseen > 0 && (
            <button
              type="button"
              className="rv-btn"
              data-variant="ghost"
              style={{ height: "1.5rem", fontSize: "var(--t-2xs)", padding: "0 var(--s-2)" }}
              onClick={() => void markAllRead()}
            >
              Mark all read
            </button>
          )}
        </div>

        {/* 4.15 count-badged tabs */}
        <div
          className="rv-tabs"
          role="tablist"
          style={{ padding: "0 var(--s-4)", gap: "var(--s-4)", borderBottom: "1px solid var(--border-soft)" }}
        >
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              className="rv-tab"
              data-active={tab === t.key}
              onClick={() => setTab(t.key)}
              style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
            >
              {t.label}
              {t.count > 0 && (
                <span
                  className="rv-mono"
                  style={{
                    fontSize: 10,
                    lineHeight: 1,
                    padding: "2px 5px",
                    borderRadius: 999,
                    background: "var(--bg-elev-2)",
                    border: "1px solid var(--border-soft)",
                    color: "var(--text-dim)",
                  }}
                >
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="rv-scroll" style={{ overflow: "auto", minHeight: 0, padding: "var(--s-2)" }}>
          {empty && (
            <div className="rv-empty" style={{ padding: "var(--s-6) var(--s-4)" }}>
              <span className="rv-empty-title">All caught up</span>
              <span className="rv-empty-hint">Friend requests, room invites and mentions land here.</span>
            </div>
          )}

          {groups.map((g) => (
            <div key={g.day}>
              <div
                className="rv-mono"
                style={{
                  fontSize: "var(--t-2xs)",
                  letterSpacing: ".14em",
                  textTransform: "uppercase",
                  color: "var(--text-faint)",
                  padding: "var(--s-2) var(--s-2) var(--s-1)",
                }}
              >
                {g.day}
              </div>
              {g.items.map((it) => {
                if (it.kind === "friend") {
                  const f = it.f;
                  return (
                    <Row
                      key={`fr-${f.friendshipId}`}
                      highlight
                      glyph="+"
                      meta="friend request"
                      avatar={
                        <Avatar
                          src={f.user.avatarUrl ?? null}
                          fallbackInitials={f.user.displayName}
                          fallbackColorSeed={f.user.id}
                          size={32}
                        />
                      }
                      actions={
                        <>
                          <SmallBtn primary onClick={() => void actFriend(f.friendshipId, "accept")}>
                            Accept
                          </SmallBtn>
                          <SmallBtn onClick={() => void actFriend(f.friendshipId, "reject")}>Decline</SmallBtn>
                        </>
                      }
                    >
                      <b style={{ fontWeight: 600 }}>{f.user.displayName}</b>
                      {f.user.handle && <span style={{ color: "var(--text-dim)" }}> @{f.user.handle}</span>} sent
                      you a friend request.
                    </Row>
                  );
                }
                if (it.kind === "invite") {
                  const inv = it.inv;
                  const exp = expiresIn(inv.expiresAt);
                  return (
                    <Row
                      key={`inv-${inv.id}`}
                      highlight
                      glyph="⊕"
                      meta={`${timeAgo(inv.createdAt)} · room invite${exp ? ` · ${exp}` : ""}`}
                      avatar={
                        <Avatar
                          src={inv.from.avatarUrl}
                          fallbackInitials={inv.from.displayName}
                          fallbackColorSeed={inv.from.id}
                          size={32}
                        />
                      }
                      actions={
                        <>
                          <SmallBtn primary onClick={() => void actInvite(inv, "join")}>
                            Join
                          </SmallBtn>
                          <SmallBtn onClick={() => void actInvite(inv, "later")}>Later</SmallBtn>
                        </>
                      }
                    >
                      <b style={{ fontWeight: 600 }}>{inv.from.displayName}</b> invited you to{" "}
                      <b style={{ fontWeight: 600 }}>{inv.room.name}</b>
                      {inv.membersLive > 0 && (
                        <span style={{ color: "var(--text-dim)" }}>
                          {" "}
                          · {inv.membersLive} {inv.membersLive === 1 ? "member" : "members"} live
                        </span>
                      )}
                      .
                    </Row>
                  );
                }
                const m = it.m;
                const fresh = Date.parse(m.message.createdAt) > seen;
                const excerpt = m.message.body
                  ? m.message.body.length > 120
                    ? `${m.message.body.slice(0, 120)}…`
                    : m.message.body
                  : null;
                return (
                  <Row
                    key={`men-${m.message.id}`}
                    highlight={fresh}
                    glyph="@"
                    meta={`${timeAgo(m.message.createdAt)} · mention`}
                    avatar={
                      <Avatar
                        src={null}
                        fallbackInitials={m.message.authorName}
                        fallbackColorSeed={m.message.authorId}
                        size={32}
                      />
                    }
                  >
                    <b style={{ fontWeight: 600 }}>{m.message.authorName}</b> mentioned you
                    {m.roomName ? (
                      <>
                        {" "}
                        in <b style={{ fontWeight: 600 }}>#{m.roomName}</b>
                      </>
                    ) : (
                      " in a DM"
                    )}
                    {excerpt && <span style={{ color: "var(--text-mid)" }}>: “{excerpt}”</span>}
                  </Row>
                );
              })}
            </div>
          ))}

          {showDmRollup && (
            <button
              type="button"
              className="rv-menu-item"
              style={{ width: "100%" }}
              onClick={() => {
                onClose();
                onOpenDms();
              }}
            >
              <span style={{ width: 16, textAlign: "center", color: "var(--text-dim)" }}>✉</span>
              <span style={{ flex: 1 }}>
                {dmUnread} unread {dmUnread === 1 ? "message" : "messages"} in DMs
              </span>
            </button>
          )}
        </div>

        <div
          style={{
            padding: "var(--s-2) var(--s-3)",
            borderTop: "1px solid var(--border-soft)",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <button
            type="button"
            className="rv-btn"
            data-variant="ghost"
            style={{ height: "1.7rem", fontSize: "var(--t-2xs)" }}
            onClick={() => {
              onClose();
              onOpenFriends();
            }}
          >
            Friends page
          </button>
          <button
            type="button"
            className="rv-btn"
            data-variant="ghost"
            style={{ height: "1.7rem", fontSize: "var(--t-2xs)" }}
            onClick={() => {
              onClose();
              if (onOpenSettings) onOpenSettings();
              else onOpenDms();
            }}
          >
            Notification settings →
          </button>
        </div>
      </div>
    </>
  );
}
