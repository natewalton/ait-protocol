import { claudeContinuedSessions, claudeIdentityUuid } from './claudeSession.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { pathToFileURL } from 'node:url'
import { AppServerClient, CODEX_PROTOCOL_TIMEOUT_MS, RpcError } from './codex/appServerClient.js'
import { SERVER_OVERLOADED, type ThreadReadResponse } from './codex/appServerTypes.js'
import { sharedAppServerSocketPath } from './codex/paths.js'
import { probeCodexWriters, type CodexWriterOwner } from './codex/writerOwnership.js'
import { readThreadSessionId } from './codex/threadMap.js'
import { canonicalUuid, readPublicIdentity, STORAGE_DIR } from './storage.js'
import { displayHandle } from './handles.js'

// A Codex thread id is a filename component, read back verbatim from
// codex-thread-<id>.json, so it is shape-checked without being re-cased. A
// Claude session id is the opposite: it becomes an identity key, so it goes
// through canonicalUuid instead of this pattern.
const THREAD_ID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const APPVIEW_URL = process.env.APPVIEW_URL ?? 'http://localhost:2585'

export type Harness = 'claude' | 'codex'

export interface ResumableSession {
  // Public immutable identity for presence joins; never persisted by discovery.
  did: string | null
  // null: a Claude conversation that exists on disk but has never joined AIT.
  // It resumes by exact UUID so the operator can join from inside it, and is
  // otherwise invisible: no handle to list, search, or check for liveness.
  handle: string | null
  harness: Harness
  project: string
  identifier: string
  modifiedAt: number
  // Ephemeral ownership evidence; never persisted into an AIT identity.
  codexWriter?: CodexWriterOwner
}

interface SessionDiscovery {
  offline: ResumableSession[]
  live: ResumableSession[]
}

interface ActorBasic {
  did: string
  handle: string
  live?: boolean
}

async function searchActors(handle: string, retiredOnly = false, signal?: AbortSignal): Promise<ActorBasic[]> {
  const url = new URL('/xrpc/ait.actor.searchActors', APPVIEW_URL)
  url.searchParams.set('q', handle)
  url.searchParams.set('limit', '100')
  if (retiredOnly) url.searchParams.set('retiredOnly', 'true')
  let response: Response
  try {
    const timeout = AbortSignal.timeout(CODEX_PROTOCOL_TIMEOUT_MS)
    response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    throw new Error('could not check which AIT sessions are live; run: ait start')
  }
  if (!response.ok) {
    throw new Error('could not check which AIT sessions are live; run: ait start')
  }
  const body = (await response.json()) as { actors?: ActorBasic[] }
  return body.actors ?? []
}

function commandInstalled(name: Harness): boolean {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue
    try {
      fs.accessSync(path.join(directory, name), fs.constants.X_OK)
      return true
    } catch {
      // Continue through PATH; an absent harness simply has no rows.
    }
  }
  return false
}

function existingDirectory(candidate: unknown): candidate is string {
  if (
    typeof candidate !== 'string' ||
    candidate.length === 0 ||
    !path.isAbsolute(candidate)
  ) return false
  try {
    return fs.statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

async function firstClaudeCwd(file: string): Promise<string | null> {
  const stream = fs.createReadStream(file, { encoding: 'utf8' })
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      try {
        const record = JSON.parse(line) as { cwd?: unknown }
        if (typeof record.cwd === 'string' && record.cwd.length > 0) return record.cwd
      } catch {
        // A malformed or partial record is ignored; later valid records remain
        // eligible, while malformed-only transcripts stay undiscoverable.
      }
    }
  } finally {
    lines.close()
    stream.destroy()
  }
  return null
}

async function claudeSessions(): Promise<ResumableSession[]> {
  if (!commandInstalled('claude')) return []
  const root = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects')
  let projectEntries: fs.Dirent[]
  try {
    projectEntries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    projectEntries = []
  }
  const result: ResumableSession[] = []
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue
    const projectDir = path.join(root, projectEntry.name)
    let files: fs.Dirent[]
    try {
      files = fs.readdirSync(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const fileEntry of files) {
      if (!fileEntry.isFile() || !fileEntry.name.endsWith('.jsonl')) continue
      const identifier = canonicalUuid(fileEntry.name.slice(0, -'.jsonl'.length))
      if (!identifier) continue
      const transcript = path.join(projectDir, fileEntry.name)
      const project = await firstClaudeCwd(transcript)
      if (!project || !existingDirectory(project)) continue
      let identity
      try { identity = readPublicIdentity(identifier) }
      catch (error) { process.stderr.write(`Claude session ${identifier} skipped: ${(error as Error).message}\n`); continue }
      let modifiedAt: number
      try {
        modifiedAt = fs.statSync(transcript).mtimeMs
      } catch {
        continue
      }
      result.push({
        did: identity?.did ?? null,
        handle: identity?.handle ?? null,
        harness: 'claude',
        project,
        identifier,
        modifiedAt,
      })
    }
  }
  const bindings = claudeContinuedSessions()
  const superseded = new Set(bindings.map(binding => binding.source))
  const current = new Map<string, (typeof bindings)[number]>()
  const conflicts = new Set<string>()
  for (const binding of bindings) {
    if (superseded.has(binding.runtime)) continue
    if (current.has(binding.identity)) {
      conflicts.add(binding.identity)
      process.stderr.write(`Claude account ${binding.identity} skipped: multiple current continuations; preserve the bindings for repair.\n`)
    }
    current.set(binding.identity, binding)
  }
  const sessions = result.filter(session => !current.has(claudeIdentityUuid(session.identifier)))
  for (const binding of current.values()) {
    if (conflicts.has(binding.identity)) continue
    if (!existingDirectory(binding.project)) continue
    let identity
    try { identity = readPublicIdentity(binding.runtime) }
    catch (error) { process.stderr.write(`Claude session ${binding.runtime} skipped: ${(error as Error).message}\n`); continue }
    if (!identity) continue
    sessions.push({ did: identity.did, handle: identity.handle, harness: 'claude', project: binding.project,
      identifier: binding.runtime, modifiedAt: fs.statSync(path.join(STORAGE_DIR, `claude-thread-${binding.runtime}.json`)).mtimeMs })
  }
  return sessions
}

async function codexSessions(signal?: AbortSignal): Promise<ResumableSession[]> {
  if (!commandInstalled('codex')) return []
  let maps: fs.Dirent[]
  try {
    maps = fs.readdirSync(STORAGE_DIR, { withFileTypes: true })
  } catch {
    return []
  }
  const mappedThreads: Array<{ threadId: string; did: string; handle: string }> = []
  for (const entry of maps) {
    if (!entry.isFile() || !/^codex-thread-[A-Za-z0-9-]+\.json$/.test(entry.name)) continue
    const threadId = entry.name.slice('codex-thread-'.length, -'.json'.length)
    if (!THREAD_ID_SHAPE.test(threadId)) continue
    const sessionId = readThreadSessionId(threadId)
    const identity = sessionId ? readPublicIdentity(sessionId) : null
    if (identity) mappedThreads.push({ threadId, did: identity.did, handle: identity.handle })
  }
  if (mappedThreads.length === 0) return []

  // Codex keeps its own thread store (since 0.163 a database, with the old
  // rollout files deleted after migration), so the shared app-server is asked
  // rather than the disk read directly. A server that cannot answer leaves
  // Codex out of the list in one line, and Claude sessions still resume.
  const unavailable = 'Codex sessions not listed: the shared Codex server is not answering; run: ait start\n'
  const client = new AppServerClient(sharedAppServerSocketPath())
  const result: ResumableSession[] = []
  const abort = (): void => client.close()
  signal?.throwIfAborted()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    try {
      await client.connect(CODEX_PROTOCOL_TIMEOUT_MS)
    } catch {
      if (signal?.aborted) throw signal.reason
      process.stderr.write(unavailable)
      return []
    }
    for (const { threadId, did, handle } of mappedThreads) {
      signal?.throwIfAborted()
      let thread: ThreadReadResponse['thread']
      try {
        thread = (await client.threadRead(threadId)).thread
      } catch (err) {
        if (signal?.aborted) throw signal.reason
        // An RPC error is the server answering for this one thread (gone,
        // unreadable); skip it. Overload, or a dropped or silent connection,
        // means the server is not answering.
        if (err instanceof RpcError && err.code !== SERVER_OVERLOADED) continue
        process.stderr.write(unavailable)
        return []
      }
      if (!existingDirectory(thread.cwd)) continue
      result.push({
        did,
        handle,
        harness: 'codex',
        project: thread.cwd,
        identifier: threadId,
        modifiedAt: thread.updatedAt * 1000,
      })
    }
    try {
      const owners = await probeCodexWriters(await client.localServerInfo(), result.map(session => session.identifier))
      for (const session of result) session.codexWriter = owners.get(session.identifier)
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      process.stderr.write(`Codex sessions not listed: ${error instanceof Error ? error.message : String(error)}. Check lsof/ps availability and retry ait resume.\n`)
      return []
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    client.close()
  }
  return result
}

export async function discoverSessions(signal?: AbortSignal): Promise<SessionDiscovery> {
  const sessions = [ ...(await claudeSessions()), ...(await codexSessions(signal)) ]
  const liveDids = new Set<string>()
  const joined = new Map(sessions.flatMap((session) =>
    session.did === null || session.handle === null
      ? []
      : [[session.did, session.handle.split('.')[0].toLocaleLowerCase() + '.'] as const],
  ))
  for (const [did, query] of joined) {
    signal?.throwIfAborted()
    // Search the label prefix across old/new namespaces, then join by DID.
    // A namesake is never evidence that this local session is live.
    const listed = (await searchActors(query, false, signal)).find(
      (actor) => actor.did === did,
    )
    // A retired handle is intentionally absent from the public directory, but
    // its existing session can still be live. Check that separate view only
    // for a locally known DID missing from the listed set.
    const actor = listed ?? (await searchActors(query, true, signal)).find(
      (candidate) => candidate.did === did,
    )
    if (actor?.live) liveDids.add(did)
  }
  const sorted = sessions.sort(
    (a, b) => b.modifiedAt - a.modifiedAt || (a.handle ?? '').localeCompare(b.handle ?? ''),
  )
  return {
    offline: sorted.filter(
      (session) => session.codexWriter !== undefined || session.did === null || !liveDids.has(session.did),
    ),
    live: sorted.filter(
      (session) => session.codexWriter === undefined && session.did !== null && liveDids.has(session.did),
    ),
  }
}

function matches(session: ResumableSession, query: string): boolean {
  if (session.handle === null) return false
  const value = query.trim().replace(/^@/, '').toLocaleLowerCase()
  return [session.handle, session.harness, session.project].some((field) =>
    field.toLocaleLowerCase().includes(value),
  )
}

function exactMatches(sessions: ResumableSession[], query: string): ResumableSession[] {
  const value = query.trim().replace(/^@/, '').toLocaleLowerCase()
  return sessions.filter(
    (session) =>
      session.handle?.toLocaleLowerCase() === value ||
      (session.handle !== null && displayHandle(session.handle).toLocaleLowerCase() === value) ||
      session.identifier.toLocaleLowerCase() === value,
  )
}

function render(
  sessions: ResumableSession[],
  output: NodeJS.WritableStream,
  hiddenLive = 0,
): void {
  const dateFormat = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  })
  const rows = sessions.map((session, index) => ({
    number: `${index + 1}.`,
    handle: session.handle === null ? '(not joined)' : `@${displayHandle(session.handle)}`,
    harness: session.harness,
    status: session.codexWriter ? `Open in ${session.codexWriter.application}` : '',
    project: session.project,
    modified: dateFormat.format(new Date(session.modifiedAt)),
  }))
  const numberWidth = Math.max('#'.length, ...rows.map((row) => row.number.length))
  const handleWidth = Math.max('SESSION'.length, ...rows.map((row) => row.handle.length))
  const statusWidth = Math.max('STATUS'.length, ...rows.map(row => row.status.length))
  const harnessWidth = Math.max('HARNESS'.length, ...rows.map((row) => row.harness.length))
  const projectWidth = Math.max('PROJECT'.length, ...rows.map((row) => row.project.length))

  output.write(
    `${'#'.padEnd(numberWidth)}  ${'SESSION'.padEnd(handleWidth)}  ` +
    `${'STATUS'.padEnd(statusWidth)}  ${'HARNESS'.padEnd(harnessWidth)}  ${'PROJECT'.padEnd(projectWidth)}  LAST USED\n`,
  )
  rows.forEach((row, index) => {
    output.write(
      `${row.number.padEnd(numberWidth)}  ${row.handle.padEnd(handleWidth)}  ` +
      `${row.status.padEnd(statusWidth)}  ${row.harness.padEnd(harnessWidth)}  ${row.project.padEnd(projectWidth)}  ${row.modified}\n`,
    )
    if (sessions[index].handle !== null && rows.filter((other) => other.handle === row.handle).length > 1) {
      output.write(`    @${sessions[index].handle} — ${sessions[index].identifier}\n`)
    }
  })
  if (hiddenLive > 0) {
    output.write(`${hiddenLive} live session${hiddenLive === 1 ? '' : 's'} hidden\n`)
  }
}

type ReadAnswer = () => Promise<string | null>

// One serial reader spans selection, liveness confirmation and handoff. Awaiting
// a recheck must neither lose piped answers nor act after cancellation.
async function withAnswers<T>(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  run: (read: ReadAnswer, signal: AbortSignal) => Promise<T | null>,
): Promise<T | null> {
  const prompt = readline.createInterface({ input, crlfDelay: Infinity })
  const answers = prompt[Symbol.asyncIterator]()
  let interrupted = false
  const controller = new AbortController()
  const onSignal = (): void => { interrupted = true; process.exitCode = 130; controller.abort(); prompt.close() }
  process.once('SIGINT', onSignal)
  prompt.on('SIGINT', onSignal)
  const read: ReadAnswer = async () => {
    if (interrupted) return null
    const answer = await answers.next()
    return answer.done ? null : answer.value
  }
  try {
    const selected = await run(read, controller.signal)
    return interrupted ? null : selected
  } catch (error) {
    if (interrupted) return null
    throw error
  } finally {
    prompt.close()
    process.removeListener('SIGINT', onSignal)
    prompt.removeListener('SIGINT', onSignal)
    if (interrupted) output.write('\nresume cancelled; no harness was started\n')
  }
}

function cancelled(output: NodeJS.WritableStream, status = 0): null {
  if (process.exitCode === 130) return null
  output.write('\nresume cancelled; no harness was started\n')
  if (process.exitCode !== 130) process.exitCode = status
  return null
}

async function selectInteractive(
  sessions: ResumableSession[], read: ReadAnswer, output: NodeJS.WritableStream,
): Promise<ResumableSession | null> {
  let choices = sessions
  output.write('Select a session by number or enter a search: ')
  for (;;) {
    const answer = await read()
    if (answer === null) return cancelled(output)
    const trimmed = answer.trim()
    if (/^\d+$/.test(trimmed)) {
      const selected = choices[Number(trimmed) - 1]
      if (selected) return selected
      output.write('invalid session number; no harness was started\n')
      process.exitCode = 1
      return null
    }
    const narrowed = choices.filter(session => matches(session, trimmed))
    if (narrowed.length === 1) return narrowed[0]
    if (narrowed.length === 0) {
      output.write('no resumable AIT session matched\n')
      process.exitCode = 1
      return null
    }
    choices = narrowed
    render(choices, output)
  }
}

async function confirmLiveResume(
  session: ResumableSession, read: ReadAnswer, output: NodeJS.WritableStream,
): Promise<ResumableSession | null> {
  output.write(`@${displayHandle(session.handle!)} checked in within the last five minutes and may still be open.\nResume it anyway? [y/N] `)
  const answer = await read()
  if (answer !== null && /^(?:y|yes)$/i.test(answer.trim())) return session
  return cancelled(output, answer === null ? 0 : 1)
}

async function resolveWriterHandoff(
  selected: ResumableSession, read: ReadAnswer, output: NodeJS.WritableStream, signal: AbortSignal,
): Promise<ResumableSession | null> {
  let session = selected
  while (session.codexWriter) {
    const handle = `@${displayHandle(session.handle!)}`
    output.write(`${handle} is already open in ${session.codexWriter.application}.\n` +
      `You can continue there. To use AIT here, finish and close only that conversation there first.\n` +
      'Press Enter to recheck and resume, or type n to cancel: ')
    const answer = await read()
    if (answer === null) return cancelled(output)
    if (answer.trim() !== '') return cancelled(output, 1)
    // A fresh discovery uses the server's current home/PID and rechecks AIT
    // presence too: a different live AIT driver still needs explicit consent.
    const current = await discoverSessions(signal)
    const offline = current.offline.find(s => s.harness === session.harness && s.identifier === session.identifier)
    const live = current.live.find(s => s.harness === session.harness && s.identifier === session.identifier)
    if (live) return confirmLiveResume(live, read, output)
    if (!offline) {
      output.write(`Could not recheck ${handle}; no harness was started. Retry: ait resume ${handle}\n`)
      process.exitCode = 1
      return null
    }
    session = offline
  }
  return session
}

export async function chooseSession(
  query: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Promise<ResumableSession | null> {
  const { offline: sessions, live } = await discoverSessions()
  const liveExact = query ? exactMatches(live, query) : []
  const exact = query ? exactMatches(sessions, query) : []
  if (liveExact.length + exact.length > 1) {
    output.write('error: resumable handle is ambiguous; choose one of:\n')
    render([...liveExact, ...exact], output)
    return null
  }
  return withAnswers(input, output, async (read, signal) => {
    if (liveExact.length === 1) {
      const confirmed = await confirmLiveResume(liveExact[0], read, output)
      return confirmed && resolveWriterHandoff(confirmed, read, output, signal)
    }
    if (exact.length === 1) return resolveWriterHandoff(exact[0], read, output, signal)
    const listable = sessions.filter(session => session.handle !== null)
    const narrowed = query ? listable.filter(session => matches(session, query)) : listable
    const hiddenLive = query ? live.filter(session => matches(session, query)).length : live.length
    if (narrowed.length === 0) {
      output.write('no resumable AIT session matched\n')
      return null
    }
    render(narrowed, output, hiddenLive)
    const selected = await selectInteractive(narrowed, read, output)
    return selected && resolveWriterHandoff(selected, read, output, signal)
  })
}

async function main(): Promise<void> {
  const selection = await chooseSession(process.argv[2] ?? '')
  if (!selection) {
    if (process.exitCode === undefined) process.exitCode = 1
    return
  }
  process.stdout.write(`${selection.harness}\t${selection.project}\t${selection.identifier}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main().catch((err: unknown) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  })
}
