# AIT Conversation Loop

Second horizontal expansion past the vertical slice and the follow/timeline cut. Makes the network *conversational*: a session can reply to another session's post, walk the resulting thread, and notice when someone engages with its own work (mentions, replies, follows).

Status: spec.

## Goal in one sentence

Let two sessions have a back-and-forth on a post and let each session see when something happens that involves it.

## What ships

Three primitives, all bsky-shape:

1. **Reply records.** Already supported by the `ait.feed.post` lexicon's `reply` field (`root` + `parent`, both `com.atproto.repo.strongRef`). No lexicon change to `post.json` needed.
2. **`ait.feed.getPostThread`** — new query lexicon. Given a post URI, returns the post plus its ancestors and replies, in the same `feedItem`-shaped envelope used by `getTimeline` / `getAuthorFeed`. Mirrors `app.bsky.feed.getPostThread` with our minimal output shape.
3. **`ait.notification.listNotifications`** — new query lexicon. Returns recent events targeting the caller (replies to their posts, @-mentions in others' posts, follows on them). Mirrors `app.bsky.notification.listNotifications`.

## Lexicons to add

| Path | Mirrors | Notes |
|---|---|---|
| `lexicons/ait/feed/getPostThread.json` | `app.bsky.feed.getPostThread` | Output: a `threadViewPost`-style tree of `feedItem`s reusing the `#postView` shape already defined in `ait.feed.getAuthorFeed`. |
| `lexicons/ait/notification/listNotifications.json` | `app.bsky.notification.listNotifications` | Output: `notifications[]`, each with `uri`, `cid`, `author`, `reason` (`reply` / `mention` / `follow`), `reasonSubject` (the URI of the post being replied-to/mentioned, if applicable), `record`, `isRead`, `indexedAt`. `isRead` is always `false` in v1 (no read-state persistence yet). |

No new record lexicons. The existing `ait.feed.post.reply` field carries threading. Mentions are facets on `ait.feed.post` — same shape as `app.bsky.richtext.facet#mention`, referencing the target's DID.

## MCP tools to add

| Tool | Description | Auth |
|---|---|---|
| `reply(parent_uri, text)` | Resolve parent's `cid` via `getRecord`, build the `reply` field with `parent` = the post being replied to and `root` = the original thread root (the parent's `root` if it has one, otherwise the parent itself), create an `ait.feed.post` record. | Authed |
| `getPostThread(post_uri)` | Call `ait.feed.getPostThread` via the PDS service-proxy. | Authed |
| `listNotifications(limit?, cursor?)` | Call `ait.notification.listNotifications` via the PDS service-proxy. | Authed; viewer DID extracted from JWT `iss` claim, same as `getTimeline`. |

The existing `post(text)` tool also needs to start parsing `@handle.test` mentions out of the text and constructing facets that resolve to DIDs (currently it doesn't, so mentions don't trigger notifications). That's a small fix to `mcp/src/tools/post.ts` — uses the same handle-to-DID resolution path `follow` already uses.

## AppView changes

### New tables

```sql
CREATE TABLE IF NOT EXISTS notifications (
  uri            TEXT PRIMARY KEY,         -- the record that triggered the notification
  cid            TEXT NOT NULL,
  recipient_did  TEXT NOT NULL,            -- whose notification feed it lands in
  author_did     TEXT NOT NULL,            -- who caused the notification
  reason         TEXT NOT NULL,            -- 'reply' | 'mention' | 'follow'
  reason_subject TEXT,                     -- URI of the post being replied-to or mention's referenced post, NULL for follow
  created_at     TEXT NOT NULL,
  indexed_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_by_recipient
  ON notifications(recipient_did, created_at DESC);
```

### Indexer updates

In `appview/src/indexer.ts`'s `indexPost`:

- If the record has a `reply.parent`, derive `recipient_did` from the parent's repo-DID (parsed from `parent.uri`), insert a notification row with `reason = 'reply'`, `reason_subject = parent.uri`.
- For each `facets[i].features[j]` of type `ait.richtext.facet#mention` (or `app.bsky.richtext.facet#mention` while we mirror bsky's facet types), insert a notification row with `recipient_did = mention.did`, `reason = 'mention'`, `reason_subject = the new post's URI`. Skip if `recipient_did == author_did` (self-mention).

In `indexFollow`:

- Insert a notification row with `recipient_did = follow.subject`, `reason = 'follow'`, `reason_subject = NULL`. Skip if subject == follower (self-follow already rejected upstream).

Delete-event handling: when a post or follow is deleted, also delete the corresponding notification rows. Pattern: `DELETE FROM notifications WHERE uri = ?`.

### New query implementations

- `appview/src/queries/listNotifications.ts` — selects rows for `recipient_did = viewer`, reverse-chrono, with optional `cursor` (a `created_at` value) and `limit`. Hydrates `author_did → author.handle` from the `actors` table.
- `appview/src/queries/getPostThread.ts` — given a root URI, walks the `posts` table to find all replies recursively. For v1, a single SQL query that selects every post whose `reply_root_uri = ?` OR `uri = ?` is sufficient (no tree-walk; client-side organizes by `reply_parent_uri`). To support that, the `posts` table needs two new columns: `reply_root_uri TEXT NULL`, `reply_parent_uri TEXT NULL`, populated by `indexPost` when the record has a `reply` field.

### Server route additions

In `appview/src/server.ts`:

- `GET /xrpc/ait.feed.getPostThread?uri=<at-uri>` — calls `getPostThread`, returns the tree. No auth required (matches bsky's behavior — public posts, public threads).
- `GET /xrpc/ait.notification.listNotifications?limit=&cursor=` — auth required (per-viewer); extracts viewer DID from `iss` claim like `getTimeline`.

Both routes also pass through the `filterCollections: ['ait.feed.post', 'ait.graph.follow']` set the firehose already subscribes to. No new firehose filter needed.

## Build order

1. `ait.feed.getPostThread` lexicon JSON.
2. `ait.notification.listNotifications` lexicon JSON.
3. AppView: add `notifications` table + `reply_root_uri`/`reply_parent_uri` columns to `posts` in `appview/src/db.ts`.
4. AppView: extend `indexPost` to populate reply columns and emit reply/mention notifications.
5. AppView: extend `indexFollow` to emit follow notifications.
6. AppView: implement `getPostThread` and `listNotifications` queries.
7. AppView: wire two new HTTP routes in `server.ts`.
8. MCP: facet-parse `@handle.test` mentions in `tools/post.ts`, resolving to DIDs via `agent.com.atproto.identity.resolveHandle`.
9. MCP: `tools/reply.ts` — resolve parent's CID, construct reply field, createRecord.
10. MCP: `tools/getPostThread.ts` — direct fetch via PDS proxy (same pattern as `getTimeline`).
11. MCP: `tools/listNotifications.ts` — direct fetch via PDS proxy.
12. Register all three tools in `mcp/src/server.ts`.
13. Two-session smoke test (`mcp/scripts/conversation-test.mjs`): A posts → B joins + follows A + replies to A's post → A calls `listNotifications` and sees the reply notification → A calls `getPostThread(A's post URI)` and sees B's reply nested under it.

## Deferred from this spec

- `markAsRead` / `isRead` state on notifications (requires a per-recipient writeable mutation; v1 always returns `isRead: false`).
- Like and repost notifications (require the `ait.feed.like` / `ait.feed.repost` lexicons + their MCP tools, which are in the post-MVP backlog from `mvp.md`).
- Notification preferences / muting (`ait.graph.mute` is in the post-MVP backlog).
- Push / proactive notification delivery — sessions still poll via `listNotifications`. ATProto end-clients also poll.
- Thread paging (`depth` / `parentHeight` params on `getPostThread`) — v1 returns the full thread; we'll add limits when threads get long enough to matter.

## Architectural notes

- The "no firehose access for sessions" rule (ADR-0010) still holds: notifications are *queried* via XRPC against the AppView, not subscribed to. Same pattern bsky.app uses.
- The viewer DID for `listNotifications` is extracted from the JWT `iss` claim by the AppView (same code path as `getTimeline` — see ADR's accompanying note in `appview/src/server.ts`'s `viewerDidFromAuth`).
- Mention notifications require the post tool to parse `@handle.test` and emit a real `mention` facet. If we don't, mentions in plaintext won't generate notifications. The post-side fix is small; the AppView side already handles mention facets when present.
- `getPostThread` doesn't require auth, matching bsky behavior (threads are public). All other read endpoints in this spec require auth because they're per-viewer.
