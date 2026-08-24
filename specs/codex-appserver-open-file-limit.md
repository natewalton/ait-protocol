# Keep every Codex session's skills available

Status: Shipped in the commit containing this spec

Date: 2026-08-24

Files: 3 (`bin/run-codex-appserver.sh`,
`bin/run-codex-appserver-test.sh`, and this spec)

## Why

Nate, operating any AIT-backed Codex session, expects the shared app-server to
load every installed skill. All three supported start paths reach
`bin/run-codex-appserver.sh`: launchd invokes it directly
(`services/com.ait.codex-appserver.plist.template:7-10` at `4030fff`), the
standard stack calls it through `start_one`
(`bin/start-all.sh:63-66` at `4030fff`), and an individual Codex session starts
it when the shared PID is absent (`bin/codex-session.sh:56-64` at `4030fff`).

The wrapper currently proceeds from strict shell setup to its final app-server
`exec` without changing the inherited descriptor limit
(`bin/run-codex-appserver.sh:13-46` at `4030fff`). On 2026-08-24 at
14:22:33 -0700, `launchctl limit maxfiles` reported a soft limit of 256 and an
unlimited hard limit. The shared server, PID 51649 with parent PID 1, held 120
numbered descriptors: 68 pipes and 52 other descriptors, with 22 direct child
processes. Its current error log contained 96 `Too many open files` or
`os error 24` lines among 1,251 total lines. The failures included reads of
installed `SKILL.md` files, so sessions silently lose capabilities as the shared
server approaches launchd's inherited limit.

Verdict: fix it in the common launcher. This is a resource ceiling inherited at
process creation, not evidence that the named skill files are invalid.

## The proposed work

Raise only the wrapper process's soft open-file limit to 8,192 before it starts
or replaces any app-server. The final `exec` preserves that per-process limit,
so the shared server and its children receive it whether the wrapper came from
launchd, `bin/start-all.sh`, or `bin/codex-session.sh`. Keep the existing hard
limit unchanged. Under `set -e`, startup fails visibly if a host's hard limit
cannot support 8,192 instead of starting another undersized server.

This is the crude solution and it is sufficient: the measured hard limit is
unlimited, every supported start path already shares one wrapper, and the
observed failure is the 256-descriptor ceiling itself.

Nate sees no new control or screen. After the shared server's next
operator-controlled restart, the Codex conversation's skill-loading warning
area stops showing `Skipped loading ... Too many open files` as concurrency
grows, and every available skill remains usable.

## Files touched

Three files are within the repository's existing small launcher-change shape:

- `bin/run-codex-appserver.sh` raises the inherited soft descriptor limit.
- `bin/run-codex-appserver-test.sh` proves a low-limit caller reaches the fake
  final app-server process with a soft limit of 8,192.
- `specs/codex-appserver-open-file-limit.md` freezes the evidence, acceptance
  vector, rollout, rollback, and exclusions.

## Out of scope

- Restarting PID 51649 during this build. That would disconnect active AIT and
  Codex sessions and needs an operator-selected maintenance moment.
- Changing the machine-wide launchd limit or the launchd plist. Those routes do
  not cover terminal and per-session starts as completely as the common wrapper.
- Redesigning app-server child-process lifetime or descriptor use. The failure
  is removed by the available per-process capacity; no separate leak is proven.
- Stopping the two legacy per-session app-servers on temporary sockets. They are
  distinct from the shared launcher and do not affect this acceptance vector.
- Opening a pull request.

## Tests

The focused regression test lowers its own soft limit to 256, gives the wrapper
an isolated temporary socket, and uses the same test file as a fake `codex`
executable. It must observe `8192` after the wrapper's real final `exec`. The
isolated socket prevents the wrapper's stop helper from touching the live shared
server.

The change is accepted only when all of these pass:

1. Before the launcher edit,
   `bash bin/run-codex-appserver-test.sh` fails with observed limit 256.
2. After the edit, the same command passes with observed limit 8,192.
3. The focused test also constrains the hard limit to 512 and proves the wrapper
   exits before the fake app-server starts.
4. `bash -n bin/run-codex-appserver.sh bin/run-codex-appserver-test.sh` passes.
5. `npm --prefix mcp run build` passes so the launcher's required app-server MCP
   artifact is current.
6. A clean checkout of the frozen commit repeats checks 2 through 5 and contains
   exactly the three counted paths relative to its parent.

## Sequencing or rollout

Build and review on `fix/codex-appserver-fd-limit`, merge the frozen commit to
`main` without a pull request, push `origin/main`, and verify the remote ref.
The repository release is complete at that point. The running PID 51649 remains
on its inherited limit until the operator exits active sessions and restarts it
through the supported wrapper. Rollback is a revert of the merged commit; a
subsequent operator-controlled restart restores the prior launcher behavior.

## What was rejected

- Put `SoftResourceLimits/NumberOfFiles` only in the launchd plist: rejected
  because `start-all.sh` and `codex-session.sh` also launch the server.
- Raise launchd's machine-wide limit: rejected because this service alone needs
  the capacity and a global mutation is unnecessary.
- Run `ulimit -n 8192` in an operator's terminal: rejected because it cannot
  change an already-running process and does not cover later launchd starts.
- Set both soft and hard limits: rejected because the unlimited hard limit is
  already sufficient and need not be reduced.
- Restart immediately after merging: rejected because it would terminate the
  active sessions the shared server exists to host.

## Sources

- `bin/run-codex-appserver.sh:9-12,13-46` at `4030fff` for supported callers and
  current inherited-limit behavior.
- `services/com.ait.codex-appserver.plist.template:7-25`,
  `bin/start-all.sh:63-66`, and `bin/codex-session.sh:56-64` at `4030fff` for all
  three start paths.
- Local production-shaped checks on 2026-08-24 at 14:22:33 -0700:
  `launchctl limit maxfiles`; `ps -ww -o pid,ppid,lstart,command -p 51649`;
  `lsof -nP -a -p 51649 -d 0-99999`; `pgrep -P 51649`; and searches of
  `/tmp/ait-codex-appserver.err`.
