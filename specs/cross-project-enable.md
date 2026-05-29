# AIT Cross-Project Enable

Documents the one-line command that opts an arbitrary project into AIT, so any Claude Code session (CLI or Desktop) opened in that project loads the `ait-protocol` MCP server. No new scripts ship — Claude Code's native `claude mcp add --scope project` writes the correct `.mcp.json` already.

Status: spec.

## Goal in one sentence

A user with a separate project who wants AIT available there runs one `claude mcp add` command from that project's root, and from then on every session in that project — CLI or Desktop — loads the AIT MCP server.

## Why no script

The earlier draft of this spec proposed `bin/enable-ait-in.sh` and `bin/disable-ait-in.sh`. Empirical check (run from `~/Desktop/throw-away` against the AIT repo's `mcp/dist/server.js`):

```
claude mcp add --scope project ait-protocol -- node --enable-source-maps /Users/nwalton/Desktop/ait-protocol/mcp/dist/server.js
```

…writes `.mcp.json` in the project root with the exact shape we wanted, refuses to clobber on re-run (`"MCP server ait-protocol already exists in .mcp.json"`), merges cleanly when other servers are present, and pairs with `claude mcp remove ait-protocol -s project` for opt-out. Every concern the script proposal addressed is handled by the CLI. Building a wrapper would be net negative — more code, more drift surface, no gain.

## Why per-project, not user-scope

User-scope MCP registration diverges between Claude Code CLI and Claude Desktop. Verified state of this machine:

- `~/Library/Application Support/Claude/claude_desktop_config.json` has a top-level `mcpServers` map (currently holds `apple-reminders` and `posthog`) — Desktop GUI's own registration surface.
- `~/.claude.json` has 53 project entries and no top-level `mcpServers`. Per-project entries only carry `enabledMcpjsonServers` / `disabledMcpjsonServers` / `hasTrustDialogAccepted` — gates on per-project `.mcp.json`, not a user-scope registry.

Per-project `.mcp.json` sidesteps the divergence. Both surfaces share the Claude Code runtime — this very spec was authored from a `CLAUDE_CODE_ENTRYPOINT=claude-desktop` session that has the `ait-protocol` MCP tools loaded, which only happens because the runtime read this repo's `.mcp.json`. One file in the target project, both surfaces covered.

## What ships

- README's `### Open AIT in your project` subsection under `## Getting started` — the canonical onboarding step, since 99% of expected sessions run in non-AIT projects. Replaces the prior AIT-repo-centric `### Open a Claude Code session` subsection. Documents the `claude mcp add` invocation, the build prereq, the trust dialog note, and the `claude mcp remove` invocation for opt-out. The AIT repo itself stays pre-wired via its own `.mcp.json` (the 1% case — for hacking on AIT) and is mentioned in a parenthetical.
- This spec file as the rationale record.

No scripts. No code. No test additions beyond what the CLI guarantees.

## The command

```
claude mcp add --scope project ait-protocol -- \
  node --enable-source-maps /Users/nwalton/Desktop/ait-protocol/mcp/dist/server.js
```

Run once from inside the target project's root. The path is the absolute path to this AIT checkout — NOT `${CLAUDE_PROJECT_DIR:-...}`, because in any other project's session `CLAUDE_PROJECT_DIR` resolves to that other project's root and the `:-` fallback never fires.

No `--env` flags. The MCP's in-code defaults at [mcp/src/atproto/pdsClient.ts](../mcp/src/atproto/pdsClient.ts) (`PDS_URL=http://localhost:2583`, `APPVIEW_DID=did:plc:aitappview000000000001`) match the values [.mcp.json](../.mcp.json) currently exports, so omitting the env block lets intentional default changes propagate to opted-in projects without needing a re-run.

## Resulting file

`.mcp.json` written in the target project's root:

```json
{
  "mcpServers": {
    "ait-protocol": {
      "type": "stdio",
      "command": "node",
      "args": [
        "--enable-source-maps",
        "/Users/nwalton/Desktop/ait-protocol/mcp/dist/server.js"
      ],
      "env": {}
    }
  }
}
```

`"type": "stdio"` is the explicit form of the default transport — same value the loader assumes when the field is omitted from this repo's `.mcp.json`. Harmless addition.

## Preconditions

- **MCP built.** `mcp/dist/server.js` must exist. If missing: `(cd /Users/nwalton/Desktop/ait-protocol/mcp && npm install && npm run build)`. The CLI doesn't check this — the failure surfaces at session start as "MCP server failed to load."
- **Local services up.** [bin/start-all.sh](../bin/start-all.sh) (or the launchd agents from [bin/install-services.sh](../bin/install-services.sh)) running PLC, PDS, and AppView on localhost.
- **Trust dialog.** Claude Code shows a one-time directory-trust dialog on first session in any new project. That gate fires on directory open and covers `.mcp.json` along with other config; the `claude mcp add` step does not bypass it. Verified empirically: 8 of 53 project entries in `~/.claude.json` have `hasTrustDialogAccepted: true` without any `.mcp.json` on disk, confirming the dialog is broader than MCP loading.

## Opt-out

```
claude mcp remove ait-protocol -s project
```

Run from the target project's root. Removes the `ait-protocol` entry from `.mcp.json`. The file is left on disk with an empty `mcpServers` object if no other servers remain — cosmetic only; doesn't affect anything else.

## Stale-build caveat

After `git pull` in the AIT repo, opted-in projects continue to load whatever `mcp/dist/server.js` was last built. Rebuild after pulling: `(cd /Users/nwalton/Desktop/ait-protocol/mcp && npm run build)`. README should mention this once.

## What this does NOT do

- **No user-scope mechanization.** Surface diverges between CLI and Desktop; not worth the complexity for what each project can opt into in one command.
- **No multi-machine support.** Baked-in absolute path is loopback by virtue of the running services binding to localhost (verified: PLC :2582, PDS :2583, AppView :2585 all listening on `*`). Cross-machine waits for the future ADR on service discovery promised in [ADR-0034](../decisions/0034-identity-scope-per-session-per-instance.md).
- **No auto-enable across projects.** Each project is opt-in by explicit command. Same principle as the existing per-project `.mcp.json` trust flow.

## Verification log

Throwaway test in `~/Desktop/throw-away` (subsequently cleaned up):

| Test | Result |
|---|---|
| `claude mcp add --scope project ait-protocol -- node --enable-source-maps <abs-path>` writes correct `.mcp.json` | ✅ Top-level `mcpServers.ait-protocol` with `command=node`, `args=[--enable-source-maps, <abs-path>]`. |
| Re-run is idempotent | ✅ Errors out with `"MCP server ait-protocol already exists in .mcp.json"`. No clobber. |
| Adding a second server preserves the first | ✅ Both `ait-protocol` and `some-other` coexisted after sequential adds. |
| `claude mcp remove ait-protocol -s project` removes only that entry | ✅ Other servers untouched. |
| File-shape compatibility with Desktop loader | ✅ This Desktop session loads `ait-protocol` from the AIT repo's `.mcp.json` right now; CLI-written shape differs only by the harmless `"type": "stdio"` field. |
