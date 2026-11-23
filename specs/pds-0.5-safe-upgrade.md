# Updating stable AIT preserves a rollback copy

Status: implementation candidate, 2026-11-21

## Why

Stable v0.1.48 installs PDS 0.4.226. The pending supported dependency release
installs 0.5.59, whose first `PDS.create` migrates the account database. The
updater stops services before it checks out and rebuilds the target, but the
target rebuild at parent `668fa3e` runs `npm ci` without preserving the old data
(`bin/update.sh:145-155`; `668fa3e:bin/install.sh:281-302`;
`pds/launcher.js:16-24`).
That removes the installed 0.4 dependency before the first 0.5 start and leaves
the operator without the quiescent rollback source required for this one-way
crossing.

The operator who runs `ait update` sees the difference in that terminal: the
command reports the private copy before rebuilding, or refuses before changing
dependencies when it cannot prove a safe copy.

The crude fix is to copy `pds/.pds` in the updater. It does not cover the old
released updater, configured external blob paths, signing-key paths, or the
actual paths PDS opens after Node and the kernel resolve symlinks and `..`.

## The proposed work

Before any dependency command, the target installer detects the exact installed
0.4 to target 0.5 crossing. It holds or adopts the normal update lock, refuses
an owned, foreign, or not-yet-listening PDS process, and makes one private copy
of the matching `pds/.env`, configured data directory, and any blob directory
outside that data tree. The ignored `pds/data/` directory keeps the copy inside
the managed installation so normal uninstall removes it. The installer refuses
any source/destination overlap, an S3 blobstore, account, sequencer, DID-cache
or actor-store overrides outside the configured data directory, or an explicit
blob temporary directory outside the copied blob directory. Every source
and destination is compared by its native physical path. A normal `..` path or
symlink remains supported, but a symlink combined with `..` is refused when the
kernel path and PDS's `path.join` path would select different storage. A missing
`PDS_DATA_DIRECTORY` is refused because upstream otherwise stores databases in
the PDS working directory, not the installer's historical `.pds` fallback.

The copy is staged, compared with its source, and only then published. An exact
completed copy may be reused after an interrupted dependency install has removed
the old installed-version metadata, but only when the current environment, data
and blob bytes still match. A different pre-existing destination is preserved
and refuses the update.

If dependency installation later fails after PDS 0.5 has migrated the account
database, a retry recognizes both migration `008` and its resulting table with
the runtime's SQLite API after acquiring the update lock and proving the PDS is stopped. Opening SQLite can update its shared-memory file even with readOnly enabled. It preserves the original pre-migration copy
without comparing it to migrated bytes and continues fix-forward. Corrupt or
unreadable migration evidence refuses instead of guessing.

An installed 0.4 PDS with every configured storage directory proven readable
and empty is treated as a fresh installation and needs no copy. Failure to read
any covered directory is a refusal, not evidence that it is empty.

The existing updater remains the owner of release verification, service stop,
and restart. Its reset advice remains valid before a start attempt; it already
switches to fix-forward before invoking the target start. The installer prints
the copy path and that one-way boundary. It never restores data automatically.

## Files touched

Five implementation files, plus one integration-owned CLI fixture:

1. `bin/install.sh`: quiescence, private copy, and dependency-order gate.
2. `pds/scripts/upgrade-compatibility-test.mjs`: actual installer and migration
   fixture from the immutable v0.1.48 PDS.
3. `ait`: complete update help.
4. `docs/operations.md`: operator behavior and recovery boundary.
5. `specs/pds-0.5-safe-upgrade.md`: this contract.

The shared `bin/ait-test.sh` fixture now supplies the real target PDS manifest
instead of an empty placeholder, so installer version checks exercise a valid
managed checkout.

## Out of scope

No recurring backup service, backup database, daemon, new CLI option or
environment override, automatic restore, retention cleanup, PLC/PostgreSQL or
AppView backup, peer transport change, or general migration framework. Later
PDS upgrades require their own evidence rather than silently reusing this gate.

## Tests

Run `node pds/scripts/upgrade-compatibility-test.mjs --baseline <isolated-v0.1.48>`.
The fixture must seed the real old PDS, invoke the actual target rebuild under
the old updater's lock contract, and prove that the matching environment, data,
signing key, and external blob bytes exist before any dependency command. It
then starts the real target twice, verifies identity, authentication, records,
blobs, migration and a new write, and reopens a restored copy with the old PDS.

The same fixture refuses before a dependency command when PDS owns its listener,
is still starting before listener bind, or another live update owns the lock.
It also refuses rather than replacing an existing rollback destination, when
any staging destination overlaps environment/data/blob sources, when installed
version evidence is absent beside persisted storage without an exact completed
copy, and when storage overrides would leave state outside the copy. The fixture
uses the actual PDS config, SQLite, actor-store and disk-blob implementations to
prove the different raw and normalized path behavior being guarded. It covers
ordinary parent paths, ordinary symlinks, symlink/`..` ambiguity, native macOS
case aliases before and after rollback-root creation, external blob temporary
storage, migrated-schema retries, and missing data configuration while
preserving both possible source trees. Forced copy/publish failures must stop
before any dependency command and must not print success.

Run `bash -n bin/install.sh ait` and the inherited installer/update suites.

## Sequencing or rollout

This is one acceptance slice with the 0.5 dependency release, not a standalone
enabler: the release is incomplete unless its old-updater journey both creates
the rollback copy and opens the preserved state on 0.5. Run the released v0.1.48
to candidate update fixture before publication.

## What was rejected

- Updater-only copying: the installed v0.1.48 updater cannot gain that code, but
  it does invoke the target installer after stopping services.
- Copying after `npm ci`: it loses the authoritative old installed version and
  allows a failure after the rollback boundary has already been crossed.
- In-place downgrade or automatic restore: old code is not proven against the
  migrated schema and restoration could discard new writes.
- A generic backup subsystem: only this evidenced crossing needs the behavior.

## Sources

- `bin/update.sh:126-174`
- `bin/install.sh:281-303`
- `bin/run-pds.sh:5-18`
- `pds/launcher.js:16-30`
- `pds/scripts/upgrade-compatibility-test.mjs:16-79,136-241`
- `docs/operations.md:34-67`
