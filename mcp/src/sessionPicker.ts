import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { pathToFileURL } from 'node:url'
import { readThreadSessionId } from './codex/threadMap.js'
import { readPublicIdentity, STORAGE_DIR } from './storage.js'

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type Harness = 'claude' | 'codex'

export interface ResumableSession {
  handle: string
  harness: Harness
  project: string
  identifier: string
  modifiedAt: number
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

export async function discoverSessions(): Promise<ResumableSession[]> {
  const sessions = [ ...(await claudeSessions()), ...(await codexSessions()) ]
  return sessions.sort(
    (a, b) => b.modifiedAt - a.modifiedAt || a.handle.localeCompare(b.handle),
  )
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

function render(sessions: ResumableSession[], output: NodeJS.WritableStream): void {
  sessions.forEach((session, index) => {
    const modified = new Date(session.modifiedAt).toISOString()
    output.write(`${index + 1}. @${session.handle}\t${session.harness}\t${session.project}\t${modified}\n`)
  })
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
  const sessions = await discoverSessions()
  const exact = query ? exactMatches(sessions, query) : []
  if (exact.length > 1) {
    output.write('error: resumable handle is ambiguous; choose one of:\n')
    render(exact, output)
    return null
  }
  if (exact.length === 1) return exact[0]
  const narrowed = query ? sessions.filter((session) => matches(session, query)) : sessions
  if (narrowed.length === 0) {
    output.write('no resumable AIT session matched\n')
    return null
  }
  render(narrowed, output)
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
  void main()
}
