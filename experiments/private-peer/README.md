# Isolated private-peer integration build

This is a runnable integration prototype, not an installed AIT feature or a
release candidate. Its first consumer is the existing AIT indexer and thread/
notification queries reading real verified AT repository records over Iroh.

No live AIT service/account, project configuration, credential store or system
trust setting is changed. Newly generated keys, certificates and SQLite state
belong to the fixture. Network access is OS-confined to loopback during tests.
Only recorded child processes are cleaned up.

## Run

Requires macOS sandbox-exec, OpenSSL and Node >=22 (tested here on 25.7.0 only),
and the read-only reference modules at
`/Users/nwalton/.local/share/ait-protocol/appview/dist`. Those imports are pure
indexer/query/database functions, never server startup or .env loading. The
reference consumer dependency makes this a local development fixture, not yet
a portable distribution/test gate.

```sh
cd experiments/private-peer
npm ci --ignore-scripts --no-audit --no-fund
npm run test:half-close
npm run test:transport
npm test
npm run test:repeat
```

To run the next functional proof with real reference PLC/PDS producers:

```sh
sandbox-exec -f loopback.sb node service-proof.mjs
```

This also requires existing PostgreSQL 17 tools at
`/opt/homebrew/opt/postgresql@17/bin`. It creates one temporary cluster with two
separate databases, each serving its own real PLC, and two independent PDS
SQLite stores. No host database is used. The owned cluster uses TCP loopback
only; cleanup checks its recorded postmaster PID before stopping that cluster.
Each PDS enrolls a scratch PLC actor and writes history before preparation.
The proof submits an endpoint-only operation to the owning PLC, repeats it
without adding another operation, and restarts the PDS with its service DID
retained. The original access token still works; the original refresh token
obtains a usable new access token for the same actor. Repository bytes remain
unchanged. Verified
CAR and WSS traffic then crosses Iroh, reaching existing AIT thread and
notification query functions.

The producer configuration retains the existing install's SSRF setting for
local service access; it is not evidence for a new production SSRF policy.
This run is not two existing installations or VMs: it exercises real service
components with temporary actors/data. It supplies reply references directly,
so it does not prove the pending local-PDS-to-AppView getRecord integration,
ordinary update, Link UI, friendly-name selection or real harness delivery.

Run files/results are in fresh temporary directories, not in the installation.
The lockfile pins the tested tree. Do not replace the pinned sync transport
chain with latest packages without checking agent/lookup option support.

The repeat command runs exactly 20 consecutive integrations, stopping at the
first failure rather than retrying. Each run checks native endpoint/worker
cleanup, drained stream hashes, and `process.getActiveResourcesInfo()` against
its starting baseline at `beforeExit`. Its 30-second watchdog detects a hang;
it does not order the setup or teardown.

The negative control below must exit 1. It uses a temporary worker copy with
only the old destructive socket iterator restored. Both late-response cases
must fail; the tracked worker is not edited.

```sh
sandbox-exec -f loopback.sb node half-close-test.mjs --old-iterator
```

An earlier integration passed its eight functional checks but timed out in
cleanup. The current code waits for the failed TLS client's close, observes
writer completion with `finished()`, and drains before endpoint shutdown.
The final files passed 20/20 repetitions; that is reproducibility evidence,
not proof assigning the earlier timeout exclusively to one of those changes.

## What it exercises

- Official Iroh endpoints, private loopback addressing, authenticated native
  connections, unchanged HTTP/HTTPS/WebSocket bytes and scoped peer TLS trust.
- Directional TCP/QUIC drain and FIN, one final connection-close owner, and
  owned-worker/endpoint cleanup. Half-close testing requires a response sent
  after receiving the request's EOF; echo alone cannot prove that behavior.
- The published AT resolver request hook, upstream PLC signed-history checks,
  canonical document formatting and the signed endpoint's peer-hosting binding.
  No global fetch/dispatcher or DID-resolver method patching. The private
  handle resolver deliberately returns the standard unverified outcome.
- Real signed repository CARs and official authenticated Firehose projection.
  The AT producer uses synthetic log/XRPC fixtures, not full PDS/PLC services.
- Existing AIT indexer/thread/notification query functions, unchanged actor
  DIDs/record CIDs/reply references, scoped refusal and replay idempotence.

The two independently generated actor repos begin with the old localhost
service endpoint. A standard signed endpoint-only operation prepares each for
its logical Iroh-key address. Repo bytes remain unchanged. This demonstrates
the metadata operation, not an execution of `ait update` or session JWT reuse.

The fixture explicitly chooses known source context for query hydration. It
does not implement a production source directory, persisted registry or actor
name discovery. Linking approval is injected fixture consent, not a complete
invitation UI or security-reviewed production consent implementation.

The peer client owns the subscriptions it starts. The fixture models unlink
by revoking approval and closing that client, which stops its Firehoses,
destroys HTTP/WSS transports and clears the source DID cache. Relink creates a
new client. Already indexed posts remain readable; they are not revoked data.
getRepo alone has a 100 MiB prototype response budget; other HTTP routes retain
the upstream 512 KiB limit. The suite verifies a signed repo above that smaller
limit and rejects an oversized PLC log. Production export sizing remains to be
decided with actual installation data.

Abrupt disappearance after a completed request FIN is not promised to be
detected while the response is idle. A direct Node TCP control also observed
no close event in that sequence. No timer, probe or reconnect mechanism is
added for it; the lifecycle owner must explicitly close/unlink the peer.
Per-stream byte records are fixture diagnostics, not retained production
history. QUIC errors without a Node error code are reported as errors rather
than classified as TCP resets.

## Still required before shipping

Full existing-install update/session continuity; user-facing Link/Unlink;
friendly-name ambiguity and local AppView getRecord integration; real Claude/
Codex session delivery; VM/two-host reachability; production packaging and
independent security review. The run must not be described as those outcomes.

An approved recipient can copy data already received. Unlink denies further
network access; it cannot erase those copies. PLC history checks establish an
authorized history, not an independently operated authority's newest global
state. These are protocol limits, not guarantees added by this prototype.
