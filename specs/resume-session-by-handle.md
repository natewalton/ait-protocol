# Resume an AIT session by its handle

Status: ready for peer review, 2026-09-03. Tracked by [#24](https://github.com/natewalton/ait-protocol/issues/24).

## Why

An operator who wants to return to an AIT session currently has to keep its
terminal open or retain a harness identifier. The AIT launchers can safely
resume a known session, but they do not provide one place to find it:

- Claude accepts a UUID, a name within the current project, or the newest
  transcript in the current project (`bin/claude-session.sh:28-123`). Its AIT
  launcher deliberately refuses Claude's bare picker because the selected UUID
  would not reach the MCP identity resolver (`bin/claude-session.sh:73-93`).
- Codex accepts an exact thread ID and otherwise starts a new session
  (`bin/codex-session.sh:26-48`). Its native picker does not start the AIT
  per-session driver or attach through the shared app-server path
  (`bin/codex-session.sh:80-85,120-125`).

The upstream tools already own session history and resume behavior. Claude
stores resumable conversations as per-project JSONL transcripts, and Codex
stores rollout files containing the thread ID and working directory. AIT already
stores the missing relationship: identity envelopes contain the public handle
(`mcp/src/storage.ts:48-58`), while Codex additionally records thread ID to AIT
session ID (`mcp/src/codex/threadMap.ts:1-13,26-48`).

On this machine on 2026-09-03, the existing files contain 130 AIT identity
envelopes, 59 top-level Claude conversation transcripts, 84 nested Claude
subagent transcripts, and 62 Codex thread maps. Matching the existing session-ID
hash convention resolves 9 top-level Claude conversations and 30 Codex sessions
to an AIT handle; none of the nested subagent transcripts has an AIT identity.
All 39 bound sessions also have an existing recorded project directory and meet
the proposed “resumable now” contract; no handle occurs twice in that set. AIT
handles belong only to top-level sessions, so subagent transcripts are not
eligible discovery inputs. The existing files are enough to build the selection
view at read time. A new AIT session registry would duplicate harness state and
become another record to repair.

The crude solution is the chosen one: add one `ait resume` command that joins
the existing local records, lets the operator select by handle, and then invokes
the existing safe launcher with the exact harness identifier.

## Proposed work

Add:

```text
ait resume [query]
```

With no query, the command shows every locally resumable AIT-bound Claude and
Codex session, newest activity first. Each numbered row shows the AIT handle,
harness, original project path, and when its harness record was last modified.
The prompt accepts a row number or a new text query. A query filters
case-insensitively by handle, harness, or project path. An exact handle,
conversation UUID, or Codex thread ID selects immediately.

Only sessions which can be resumed are shown. A row requires all of:

1. an installed supported harness;
2. that harness's own top-level conversation transcript or rollout record;
3. a matching AIT identity envelope with a valid public handle; and
4. an existing original project directory.

Claude discovery reads only JSONL files directly inside each project directory;
it does not recurse into a conversation's `subagents` directory. Malformed,
partial, unbound, and deleted harness records are ignored. They are not repaired
or deleted. If no row matches, the command says that no resumable AIT session
matched and exits without launching anything. If an exact handle somehow maps
to more than one harness session, the command refuses the ambiguous resume and
shows the matching rows.

For Claude, the original project path comes from the first transcript record
that contains `cwd`. The encoded project-directory name is only a storage slug
and must not be decoded into a path; that transformation is lossy for project
names containing characters such as `_`, `.`, and `-`. Codex uses the `cwd`
recorded in its rollout metadata.

After selection, `ait resume` changes to the recorded project directory and
invokes the same private install/launcher path already used by the public new-
session commands, supplying the exact resume identifier internally:

- Claude launcher: `--resume <conversation-uuid>`
- Codex launcher: `--resume <thread-id>`

The selector never decrypts or prints credentials. It reads only the plaintext
handle already present in the identity envelope, computes the existing
session-ID-derived identity path, and passes the selected identifier directly to
the launcher. The launchers remain the only code that applies harness options,
restores the AIT identity, starts the Codex driver, or owns terminal signals and
exit status.

`ait resume` becomes AIT's only public resume surface. `ait claude` and
`ait codex` mean “start a new session.” Their current public resume tokens
(`--resume`, `-r`, `--resume-last`, and `--session`) refuse before reaching the
launcher and print the equivalent `ait resume` command. Delete Claude's private
name and newest-transcript selection and Codex's legacy `--session` alias. The
private launchers keep only the exact `--resume <id>` entry point used by the
selector; it is not a second documented interface.

`ait resume` is an interactive terminal command. `Ctrl-C` or EOF cancels without
starting a harness. It adds no flags. A user who already knows the handle,
Claude conversation UUID, or Codex thread ID passes it as the optional query.

## Files touched

Nine files:

1. `ait` adds the command and help page, dispatches the selection through the existing private install/launcher path, and redirects the former public resume forms to this command.
2. `bin/claude-session.sh` retains exact UUID resume for internal dispatch and removes its duplicate name and newest-transcript selectors.
3. `mcp/src/codex/host.ts` retains exact thread resume and removes the legacy `--session` alias.
4. `mcp/src/storage.ts` exposes a read-only public-identity lookup for a supplied session UUID so discovery reuses the existing identity-path convention.
5. `mcp/src/sessionPicker.ts` discovers the two harness record shapes, renders the selector, and returns the selected harness, project, and identifier to `ait`.
6. `mcp/scripts/session-picker-test.mjs` exercises discovery, selection, cancellation, and launcher dispatch with isolated fixture homes.
7. `bin/ait-test.sh` covers public help, new-session passthrough, and migration errors for removed resume forms.
8. `README.md` replaces the harness-specific resume recipes with `ait resume`.
9. `specs/resume-session-by-handle.md` records this contract.

The systems model has four concepts: a harness session record, its existing AIT
identity binding, one selector, and the existing launcher dispatch. No fifth
catalog or lifecycle concept is introduced.

## Out of scope

- Deleting, archiving, expiring, or otherwise cleaning up old sessions. That is
  a separate user outcome.
- Keeping a session alive, deciding whether it is live, or preventing a user
  from resuming a session which is already open. Live reachability is #20.
- Renaming, forking, importing, exporting, or editing harness sessions.
- Listing Claude or Codex sessions which never joined AIT.
- Listing Claude subagent transcripts, which are not top-level interactive
  sessions the operator can resume through the launcher.
- Preserving sessions after the underlying harness removes its own transcript or
  rollout.
- Persisting an AIT session catalog, last-used value, index, cache, preference,
  alias, or cross-machine session record.
- Reimplementing either harness's resume operation or interactive TUI.
- Supporting the former public resume flags indefinitely; this release replaces
  them with one command and a migration message.

## Tests

Build MCP, run `node mcp/scripts/session-picker-test.mjs`, and run
`bin/ait-test.sh`.

The focused test uses isolated `HOME`, `XDG_DATA_HOME`, Claude transcript, Codex
rollout, identity-envelope, and executable harness fixtures. It proves:

1. A Claude transcript and matching AIT identity appear with handle, project,
   harness, and transcript modification time.
2. A Codex rollout, thread map, and matching AIT identity appear with the same
   fields and are ordered by rollout modification time.
3. Newest activity sorts first across both harnesses; the list is not limited to
   the current project or an age window.
4. Exact handle selection dispatches from recorded project paths containing
   spaces and `_` or `.` to the correct existing launcher with the exact UUID
   or thread ID, without shell interpretation or Claude slug decoding.
5. Exact Claude UUID and Codex thread ID selection resolve to the same rows
   without requiring a harness-specific command.
6. A partial query narrows the rows and numbered selection dispatches the chosen
   session.
7. Missing harness binaries, identity files, harness records, and project
   directories do not produce resumable rows. Nested Claude subagent directories
   are not scanned or listed.
8. Malformed records and a duplicate handle mapping fail closed without exposing
   credential fields or launching anything.
9. No match, EOF, and `Ctrl-C` leave every fixture unchanged and launch nothing.
10. Every former `ait claude` and `ait codex` resume form exits 2 before launch
    and names its `ait resume` replacement; ordinary new-session arguments still
    pass through unchanged.
11. Removing either harness-to-identity join makes its corresponding regression
   fail.

The production oracle joins one Claude and one Codex session in different
projects, exits both, runs `ait resume`, and resumes each by its displayed AIT
handle. Each session must reopen in its original project and report its original
handle without another `join` call. A pre-existing non-AIT harness session must
not appear, and neither may a nested Claude subagent transcript.

## Rollout

Ship as one patch release after the released oracle passes for both supported
harnesses. The new command reads existing data and requires no migration. A
rollback removes the command; the harness transcripts, Codex maps, and AIT
identities remain unchanged. Rolling back also restores the former public
harness-specific resume forms.

Done means the released `ait resume` finds and resumes both real stopped test
sessions by handle, each retains its original AIT identity and project, the same
controlling reviewer reproduces that result, and issue #24 links the released
version and evidence.

## Rejected options

- Rejected: an AIT-owned session database. It would duplicate the two harness
  histories and add synchronization and repair without improving resume.
- Rejected: delegating directly to the native pickers. Claude's picker does not
  give the AIT launcher the explicit UUID needed for identity continuity, and
  Codex's picker bypasses the AIT driver and shared app-server attachment.
- Rejected: adding session management to aitty. Resume is a local machine and
  terminal operation; the installed `ait` command already owns both launchers.
- Rejected: a separate `ait sessions` listing command. Browsing exists only to
  choose what `ait resume` launches, so separating it would make the user run two
  commands for one outcome.
- Rejected: recording more metadata at join time. The handle binding and harness
  history already provide the required values, including for existing sessions.
- Rejected: recursively scanning Claude project directories. The 84 nested JSONL
  files measured on 2026-09-03 are subagent transcripts, not top-level sessions
  the operator can resume, and AIT does not permit subagents to register handles.
- Rejected: displaying or searching Claude's separate session name. The local
  Claude and Codex history directories contain 1.1 GB and 1.9 GB respectively
  on 2026-09-03, and no Claude session-name index is present. Scanning message
  bodies for a second label would slow the normal picker while the canonical
  AIT handle already identifies the session.
- Rejected: live-state filtering. An old but stopped session is the primary
  target of this feature, while an old but connected session remains legitimately
  live under #20.

## Sources

- [Issue #24](https://github.com/natewalton/ait-protocol/issues/24), the operator's session-recovery problem.
- [Claude Code: Manage sessions](https://code.claude.com/docs/en/sessions), native picker, naming, all-project discovery, transcript location, and retention behavior.
- [OpenAI Codex resume CLI source](https://github.com/openai/codex/blob/main/codex-rs/exec/src/cli.rs), native resume selector and identifier forms.
- Current source locators cited above, inspected at `7caba4e495bc2ec8e5476c2a0c54b31d6e1a0ada` on 2026-09-03.
- Read-only local count command reported in **Why**, run on 2026-09-03 without reading credential ciphertext.
