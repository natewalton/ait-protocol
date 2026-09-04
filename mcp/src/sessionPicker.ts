import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { pathToFileURL } from 'node:url'
import { readThreadSessionId } from './codex/threadMap.js'
import { readPublicIdentity, STORAGE_DIR } from './storage.js'

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const APPVIEW_URL = process.env.APPVIEW_URL ?? 'http://localhost:2585'

export type Harness = 'claude' | 'codex'

export interface ResumableSession {
  handle: string
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
      const identifier = fileEntry.name.slice(0, -'.jsonl'.length)
      if (!UUID_SHAPE.test(identifier)) continue
      const transcript = path.join(projectDir, fileEntry.name)
      const project = await firstClaudeCwd(transcript)
      const identity = readPublicIdentity(identifier)
      if (!project || !existingDirectory(project) || !identity) continue
      let modifiedAt: number
      try {
        modifiedAt = fs.statSync(transcript).mtimeMs
      } catch {
        continue
      }
      result.push({
        handle: identity.handle,
        harness: 'claude',
        project,
        identifier: identifier.toLowerCase(),
        modifiedAt,
      })
    }
  }
  return result
}

function firstJsonLine(file: string): unknown | null {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return null
  }
  try {
    const chunks: Buffer[] = []
    let total = 0
    const buffer = Buffer.alloc(8192)
    while (total < 1024 * 1024) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (count === 0) break
      const part = buffer.subarray(0, count)
      const newline = part.indexOf(10)
      if (newline >= 0) {
        chunks.push(part.subarray(0, newline))
        break
      }
      chunks.push(Buffer.from(part))
      total += count
    }
    const line = Buffer.concat(chunks).toString('utf8').replace(/\r$/, '')
    return JSON.parse(line)
  } catch {
    return null
  } finally {
    fs.closeSync(fd)
  }
}

function rolloutFiles(root: string): string[] {
  const result: string[] = []
  const visit = (directory: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) result.push(full)
    }
  }
  visit(root)
  return result
}

async function codexSessions(): Promise<ResumableSession[]> {
  if (!commandInstalled('codex')) return []
  const root = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')
  const rollouts = rolloutFiles(path.join(root, 'sessions'))
  let maps: fs.Dirent[]
  try {
    maps = fs.readdirSync(STORAGE_DIR, { withFileTypes: true })
  } catch {
    return []
  }
  const mappedThreads = maps
    .filter((entry) => entry.isFile() && /^codex-thread-[A-Za-z0-9-]+\.json$/.test(entry.name))
    .map((entry) => entry.name.slice('codex-thread-'.length, -'.json'.length))
    .filter((threadId) => UUID_SHAPE.test(threadId) && readThreadSessionId(threadId))
  const result: ResumableSession[] = []
  for (const rollout of rollouts) {
    const metadata = firstJsonLine(rollout) as {
      type?: unknown
      payload?: { id?: unknown; session_id?: unknown; cwd?: unknown }
    } | null
    if (metadata?.type !== 'session_meta' || !metadata.payload) continue
    const threadId =
      typeof metadata.payload.id === 'string'
        ? metadata.payload.id
        : typeof metadata.payload.session_id === 'string'
          ? metadata.payload.session_id
          : ''
    if (!UUID_SHAPE.test(threadId) || !mappedThreads.includes(threadId)) continue
    const project = metadata.payload.cwd
    const sessionId = readThreadSessionId(threadId)
    const identity = sessionId ? readPublicIdentity(sessionId) : null
    if (!existingDirectory(project) || !identity) continue
    let modifiedAt: number
    try {
      modifiedAt = fs.statSync(rollout).mtimeMs
    } catch {
      continue
    }
    result.push({
      handle: identity.handle,
      harness: 'codex',
      project,
      identifier: threadId,
      modifiedAt,
    })
  }
  return result
}

export async function discoverSessions(): Promise<SessionDiscovery> {
  const sessions = [ ...(await claudeSessions()), ...(await codexSessions()) ]
  const liveHandles = new Set(
    (
      await Promise.all(
        [...new Set(sessions.map((session) => session.handle.toLocaleLowerCase()))].map(
          async (handle) => {
            const url = new URL('/xrpc/ait.actor.searchActors', APPVIEW_URL)
            url.searchParams.set('q', handle)
            url.searchParams.set('limit', '100')
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
            return body.actors?.some(
              (actor) => actor.handle.toLocaleLowerCase() === handle && actor.live,
            )
              ? handle
              : null
          },
        ),
      )
    ).filter((handle): handle is string => handle !== null),
  )
  const sorted = sessions.sort(
    (a, b) => b.modifiedAt - a.modifiedAt || a.handle.localeCompare(b.handle),
  )
  return {
    offline: sorted.filter(
      (session) => !liveHandles.has(session.handle.toLocaleLowerCase()),
    ),
    live: sorted.filter(
      (session) => liveHandles.has(session.handle.toLocaleLowerCase()),
    ),
  }
}

function matches(session: ResumableSession, query: string): boolean {
  const value = query.trim().replace(/^@/, '').toLocaleLowerCase()
  return [session.handle, session.harness, session.project].some((field) =>
    field.toLocaleLowerCase().includes(value),
  )
}

function exactMatches(sessions: ResumableSession[], query: string): ResumableSession[] {
  const value = query.trim().replace(/^@/, '').toLocaleLowerCase()
  return sessions.filter(
    (session) =>
      session.handle.toLocaleLowerCase() === value ||
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
    handle: `@${session.handle}`,
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

function selectInteractive(
  sessions: ResumableSession[],
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<ResumableSession | null> {
  return new Promise((resolve) => {
    const prompt = readline.createInterface({ input, crlfDelay: Infinity })
    let settled = false
    const finish = (value: ResumableSession | null, status = 0): void => {
      if (settled) return
      settled = true
      prompt.close()
      process.exitCode = status
      resolve(value)
    }
    const onSignal = (): void => {
      output.write('resume cancelled; no harness was started\n')
      finish(null, 130)
    }
    process.once('SIGINT', onSignal)
    prompt.on('SIGINT', onSignal)
    prompt.once('close', () => {
      process.removeListener('SIGINT', onSignal)
      prompt.removeListener('SIGINT', onSignal)
      if (!settled) {
        output.write('resume cancelled; no harness was started\n')
        finish(null)
      }
    })
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

export async function chooseSession(
  query: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Promise<ResumableSession | null> {
  const { offline: sessions, live } = await discoverSessions()
  const liveExact = query ? exactMatches(live, query) : []
  if (liveExact.length > 0) {
    output.write(`@${liveExact[0].handle} is live in another session; not resumable\n`)
    return null
  }
  const exact = query ? exactMatches(sessions, query) : []
  if (exact.length > 1) {
    output.write('error: resumable handle is ambiguous; choose one of:\n')
    render(exact, output)
    return null
  }
  if (exact.length === 1) return exact[0]
  const narrowed = query ? sessions.filter((session) => matches(session, query)) : sessions
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
