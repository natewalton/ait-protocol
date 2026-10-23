import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { pathToFileURL } from 'node:url'
import { AppServerClient, CODEX_PROTOCOL_TIMEOUT_MS, RpcError } from './codex/appServerClient.js'
import { SERVER_OVERLOADED, type ThreadReadResponse } from './codex/appServerTypes.js'
import { sharedAppServerSocketPath } from './codex/paths.js'
import { readThreadSessionId } from './codex/threadMap.js'
import { canonicalUuid, readPublicIdentity, STORAGE_DIR } from './storage.js'

// A Codex thread id is a filename component, read back verbatim from
// codex-thread-<id>.json, so it is shape-checked without being re-cased. A
// Claude session id is the opposite: it becomes an identity key, so it goes
// through canonicalUuid instead of this pattern.
const THREAD_ID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const APPVIEW_URL = process.env.APPVIEW_URL ?? 'http://localhost:2585'

export type Harness = 'claude' | 'codex'

export interface ResumableSession {
  // null: a Claude conversation that exists on disk but has never joined AIT.
  // It resumes by exact UUID so the operator can join from inside it, and is
  // otherwise invisible: no handle to list, search, or check for liveness.
  handle: string | null
  harness: Harness
  project: string
  identifier: string
  modifiedAt: number
}

interface SessionDiscovery {
  offline: ResumableSession[]
  live: ResumableSession[]
}

interface ActorBasic {
  handle: string
  live: boolean
}

async function searchActors(handle: string, retiredOnly = false): Promise<ActorBasic[]> {
  const url = new URL('/xrpc/ait.actor.searchActors', APPVIEW_URL)
  url.searchParams.set('q', handle)
  url.searchParams.set('limit', '100')
  if (retiredOnly) url.searchParams.set('retiredOnly', 'true')
  let response: Response
  try {
    response = await fetch(url)
  } catch {
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
  const root = path.join(os.homedir(), '.claude', 'projects')
  let projectEntries: fs.Dirent[]
  try {
    projectEntries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
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
      const identity = readPublicIdentity(identifier)
      let modifiedAt: number
      try {
        modifiedAt = fs.statSync(transcript).mtimeMs
      } catch {
        continue
      }
      result.push({
        handle: identity?.handle ?? null,
        harness: 'claude',
        project,
        identifier,
        modifiedAt,
      })
    }
  }
  return result
}

async function codexSessions(): Promise<ResumableSession[]> {
  if (!commandInstalled('codex')) return []
  let maps: fs.Dirent[]
  try {
    maps = fs.readdirSync(STORAGE_DIR, { withFileTypes: true })
  } catch {
    return []
  }
  const mappedThreads: Array<{ threadId: string; handle: string }> = []
  for (const entry of maps) {
    if (!entry.isFile() || !/^codex-thread-[A-Za-z0-9-]+\.json$/.test(entry.name)) continue
    const threadId = entry.name.slice('codex-thread-'.length, -'.json'.length)
    if (!THREAD_ID_SHAPE.test(threadId)) continue
    const sessionId = readThreadSessionId(threadId)
    const identity = sessionId ? readPublicIdentity(sessionId) : null
    if (identity) mappedThreads.push({ threadId, handle: identity.handle })
  }
  if (mappedThreads.length === 0) return []

  // Codex keeps its own thread store (since 0.163 a database, with the old
  // rollout files deleted after migration), so the shared app-server is asked
  // rather than the disk read directly. A server that cannot answer leaves
  // Codex out of the list in one line, and Claude sessions still resume.
  const unavailable = 'Codex sessions not listed: the shared Codex server is not answering; run: ait start\n'
  const client = new AppServerClient(sharedAppServerSocketPath())
  const result: ResumableSession[] = []
  try {
    try {
      await client.connect(CODEX_PROTOCOL_TIMEOUT_MS)
    } catch {
      process.stderr.write(unavailable)
      return []
    }
    for (const { threadId, handle } of mappedThreads) {
      let thread: ThreadReadResponse['thread']
      try {
        thread = (await client.threadRead(threadId)).thread
      } catch (err) {
        // An RPC error is the server answering for this one thread (gone,
        // unreadable); skip it. Overload, or a dropped or silent connection,
        // means the server is not answering.
        if (err instanceof RpcError && err.code !== SERVER_OVERLOADED) continue
        process.stderr.write(unavailable)
        return []
      }
      if (!existingDirectory(thread.cwd)) continue
      result.push({
        handle,
        harness: 'codex',
        project: thread.cwd,
        identifier: threadId,
        modifiedAt: thread.updatedAt * 1000,
      })
    }
  } finally {
    client.close()
  }
  return result
}

export async function discoverSessions(): Promise<SessionDiscovery> {
  const sessions = [ ...(await claudeSessions()), ...(await codexSessions()) ]
  const liveHandles = new Set<string>()
  const joinedHandles = sessions.flatMap((session) =>
    session.handle === null ? [] : [session.handle.toLocaleLowerCase()],
  )
  for (const handle of new Set(joinedHandles)) {
    const listed = (await searchActors(handle)).find(
      (actor) => actor.handle.toLocaleLowerCase() === handle,
    )
    // A retired handle is intentionally absent from the public directory, but
    // its existing session can still be live. Check that separate view only
    // for a locally known handle missing from the listed set.
    const actor = listed ?? (await searchActors(handle, true)).find(
      (candidate) => candidate.handle.toLocaleLowerCase() === handle,
    )
    if (actor?.live) liveHandles.add(handle)
  }
  const sorted = sessions.sort(
    (a, b) => b.modifiedAt - a.modifiedAt || (a.handle ?? '').localeCompare(b.handle ?? ''),
  )
  return {
    offline: sorted.filter(
      (session) => session.handle === null || !liveHandles.has(session.handle.toLocaleLowerCase()),
    ),
    live: sorted.filter(
      (session) => session.handle !== null && liveHandles.has(session.handle.toLocaleLowerCase()),
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
    handle: session.handle === null ? '(not joined)' : `@${session.handle}`,
    harness: session.harness,
    project: session.project,
    modified: dateFormat.format(new Date(session.modifiedAt)),
  }))
  const numberWidth = Math.max('#'.length, ...rows.map((row) => row.number.length))
  const handleWidth = Math.max('SESSION'.length, ...rows.map((row) => row.handle.length))
  const harnessWidth = Math.max('HARNESS'.length, ...rows.map((row) => row.harness.length))
  const projectWidth = Math.max('PROJECT'.length, ...rows.map((row) => row.project.length))

  output.write(
    `${'#'.padEnd(numberWidth)}  ${'SESSION'.padEnd(handleWidth)}  ` +
    `${'HARNESS'.padEnd(harnessWidth)}  ${'PROJECT'.padEnd(projectWidth)}  LAST USED\n`,
  )
  rows.forEach((row) => {
    output.write(
      `${row.number.padEnd(numberWidth)}  ${row.handle.padEnd(handleWidth)}  ` +
      `${row.harness.padEnd(harnessWidth)}  ${row.project.padEnd(projectWidth)}  ${row.modified}\n`,
    )
  })
  if (hiddenLive > 0) {
    output.write(`${hiddenLive} live session${hiddenLive === 1 ? '' : 's'} hidden\n`)
  }
}

function withPrompt<T>(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  run: (
    prompt: readline.Interface,
    finish: (value: T | null, status?: number) => void,
  ) => void,
): Promise<T | null> {
  const prompt = readline.createInterface({ input, crlfDelay: Infinity })
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: T | null, status = 0): void => {
      if (settled) return
      settled = true
      prompt.close()
      process.exitCode = status
      resolve(value)
    }
    const cancel = (status = 0): void => {
      output.write('\nresume cancelled; no harness was started\n')
      finish(null, status)
    }
    const onSignal = (): void => cancel(130)
    process.once('SIGINT', onSignal)
    prompt.on('SIGINT', onSignal)
    prompt.once('close', () => {
      process.removeListener('SIGINT', onSignal)
      prompt.removeListener('SIGINT', onSignal)
      if (!settled) cancel()
    })
    run(prompt, finish)
  })
}

async function selectInteractive(
  sessions: ResumableSession[],
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<ResumableSession | null> {
  return withPrompt(input, output, (prompt, finish) => {
    const readAnswer = (choices: ResumableSession[]): void => {
      prompt.once('line', (answer) => {
        const trimmed = answer.trim()
        if (/^\d+$/.test(trimmed)) {
          const selected = choices[Number(trimmed) - 1]
          if (selected) finish(selected)
          else {
            output.write('invalid session number; no harness was started\n')
            finish(null, 1)
          }
          return
        }
        const narrowed = choices.filter((session) => matches(session, trimmed))
        if (narrowed.length === 1) finish(narrowed[0])
        else if (narrowed.length > 1) {
          render(narrowed, output)
          readAnswer(narrowed)
        } else {
          output.write('no resumable AIT session matched\n')
          finish(null, 1)
        }
      })
    }
    readAnswer(sessions)
    output.write('Select a session by number or enter a search: ')
  })
}

async function confirmLiveResume(
  session: ResumableSession,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<ResumableSession | null> {
  return withPrompt(input, output, (prompt, finish) => {
    prompt.once('line', (answer) => {
      if (/^(?:y|yes)$/i.test(answer.trim())) finish(session)
      else {
        output.write('resume cancelled; no harness was started\n')
        finish(null, 1)
      }
    })
    output.write(
      `@${session.handle} checked in within the last five minutes and may still be open.\n` +
        'Resume it anyway? [y/N] ',
    )
  })
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
  if (liveExact.length === 1) return confirmLiveResume(liveExact[0], input, output)
  if (exact.length === 1) return exact[0]
  // Listings and searches show joined sessions only; a never-joined conversation
  // is reachable by its exact UUID above and nowhere else.
  const listable = sessions.filter((session) => session.handle !== null)
  const narrowed = query ? listable.filter((session) => matches(session, query)) : listable
  const hiddenLive = query ? live.filter((session) => matches(session, query)).length : live.length
  if (narrowed.length === 0) {
    output.write('no resumable AIT session matched\n')
    return null
  }
  render(narrowed, output, hiddenLive)
  return selectInteractive(narrowed, input, output)
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
