# Developing alongside an installed AIT

This machine can have two AIT checkouts: a source checkout where you edit code and the installed checkout at `$HOME/.local/share/ait-protocol`. The `ait` command, project MCP entries, launchd agents, sockets, and live services may use the installed checkout even while your terminal is in the source checkout. Building source code does not update running sessions; restarting services can disconnect them.

## Identify the live checkout

At the start of work, check where the CLI and active processes point. Repeat this check if you change the installation or restart services:

```bash
pwd -P
git rev-parse --show-toplevel
command -v ait
ls -l "$(command -v ait)"
ait status
ps -axo pid,command | rg 'codex app-server --listen|ait-protocol/mcp/dist/server.js'
```

For PLC, PDS, or AppView, use `lsof -nP -iTCP:2582 -iTCP:2583 -iTCP:2585 -sTCP:LISTEN` to find their PIDs, then `lsof -a -p PID -d cwd` to see each process's checkout. Check a project's `.mcp.json` separately: its MCP path can also point at the installed copy. If any live process uses the checkout you plan to build or rewrite, move the development work to a separate checkout first.

## Run local checks without reaching live AIT

Build and test in the source checkout or an isolated worktree. Keep test homes, XDG directories, sockets, logs, PID files, and databases under a unique temporary root. A fixture must also replace any child command that could reach the installed services, including `curl`, `lsof`, `pgrep`, `launchctl`, database tools, and stop helpers where relevant. Check cleanup and failure paths as well as the main path.

The current `bin/ait-test.sh` uses temporary service fixtures and command shims. `bin/run-codex-appserver-test.sh` copies the launcher into a temporary fixture with a no-op stop helper, so it cannot touch the shared PID file. `mcp/scripts/codex-rollout-resume-test.mjs` starts a real Codex app-server with a temporary `CODEX_HOME` and socket but makes no model turn. `mcp/scripts/codex-recovery-test.mjs` uses fake AppView and app-server connections. Recheck a test's child commands if you change it; its name or temporary directory alone does not prove isolation.

Do not use `ait start`, `ait stop`, `ait update`, `ait uninstall`, `bin/start-all.sh`, `bin/stop-all.sh`, or `mcp/scripts/push-reregister-live.mjs` as isolated tests. They can operate on the installed services or data. Use them only when you intend a live operation and have checked the exact target and effect on open sessions.

After local checks, `ait status` is a read-only check of the installed instance. It is not proof that a development build was deployed; verify the installed checkout and running process paths before claiming a change is live.

Managed `ait start` requires the effective PLC `PORT=2582`, PDS
`PDS_PORT=2583`, and AppView `APPVIEW_PORT=2585`; it rejects other values before
launching services. Direct service fixtures may still use ephemeral ports.
`node bin/managed-ports-test.mjs` checks this boundary with copied launchers and
owned configuration. It never reaches installed services.

Main's AppView bootstraps current local AIT records before reporting readiness,
then applies queued subscription events in order. It upserts without sweeping
retained rows. Historical bootstrap writes retain notification rows but suppress
immediate pushes; a mention overlapping bootstrap may wait for the next existing
push-registration replay. Health is starting until coverage is proved, and
projection failures remain degraded until repair/restart. Quiet working streams
remain healthy. `appview/scripts/startup-readiness-test.mjs` exercises compiled
main with owned loopback PDS fixtures. This differs from peer's verified feed.
