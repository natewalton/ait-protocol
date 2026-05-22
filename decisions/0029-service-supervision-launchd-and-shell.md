# ADR-0029: Service supervision — launchd plists + shell-script fallback

**Status:** Accepted
**Date:** 2026-05-22

## Context

The three local services (PLC, PDS, AppView) need to stay running across shell sessions and ideally across machine reboots. Earlier rounds used Claude Code's background-task tracker, which reparents children to the harness; when the task ends the children die. The PDS survived an earlier round only because it was started via `node launcher.js & disown` from a regular shell, which reparents to init.

Two real options for proper supervision on macOS:

1. **launchd `LaunchAgents`** — macOS-native, `KeepAlive=true` for crash-restart, `RunAtLoad=true` for boot survival. Same machinery `brew services` uses for Postgres.
2. **Shell script with `nohup` + `disown`** — manual start, predictable, zero new deps, but no auto-restart and no boot survival.

Implementing the launchd approach surfaced a macOS TCC (Transparency, Consent, Control) block: launchd agents cannot execute scripts under `~/Desktop`, `~/Documents`, `~/Downloads`, etc. without Full Disk Access granted in System Settings. Empirical confirmation: with the plists loaded, `launchctl list` showed exit code 126 and `/tmp/ait-*.err` reported `Operation not permitted` for the wrapper script paths.

## Decision

Ship both supervision paths and document the trade-off:

- **`bin/start-all.sh` / `bin/stop-all.sh`** — primary, works out of the box on any layout including `~/Desktop`. Uses `nohup` + `disown`, writes PID files to `/tmp/ait-<svc>.pid`. No crash-restart, no boot survival.
- **`services/com.ait.{plc,pds,appview}.plist` + `bin/install-services.sh`** — opt-in for users who want crash-restart + boot survival. Requires one of:
  - Grant Full Disk Access to `/bin/bash` in System Settings → Privacy & Security → Full Disk Access, **or**
  - Move the project out of `~/Desktop` (e.g. to `~/code/`).

## Consequences

- Default install path uses `bin/start-all.sh`; no GUI System Settings interaction required.
- Users wanting "always on" run `bin/install-services.sh` after granting FDA or relocating the project. The install script's header documents both prerequisites.
- Plists use absolute paths and a `WorkingDirectory` key so the wrapper scripts don't need to compute paths at run time.
- Logs land in `/tmp/ait-<svc>.{log,err}` for both supervision paths so tooling can tail uniformly.
