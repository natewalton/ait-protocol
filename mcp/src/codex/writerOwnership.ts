// Read-only early ownership evidence. Codex still arbitrates writer ownership
// atomically at thread/resume; no filesystem observation can eliminate races.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export interface LocalCodexServerInfo { codexHome: string; pid: number }
export interface CodexWriterOwner { pid: number; application: string }

const execute = promisify(execFile)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TIMEOUT_MS = 2000
const MAX_OUTPUT = 1024 * 1024

interface CommandResult { code: number; stdout: string; stderr: string }
async function command(program: string, args: string[]): Promise<CommandResult> {
  try {
    const result = await execute(program, args, { encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const result = error as Error & { code?: string | number; killed?: boolean; stdout?: string; stderr?: string }
    if (result.killed || typeof result.code !== 'number') {
      throw new Error(`could not check Codex writer ownership (${program}: ${result.killed ? 'timed out' : result.code ?? 'failed'})`)
    }
    return { code: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }
}

async function openFiles(files: string[]): Promise<Map<string, Set<number>>> {
  const owners = new Map<string, Set<number>>()
  for (let start = 0; start < files.length; start += 128) {
    const batch = files.slice(start, start + 128)
    const allowed = new Set(batch)
    const result = await command('lsof', ['-w', '-nP', '-F', 'pnaf', '--', ...batch])
    if (![0, 1].includes(result.code) || result.stderr.trim()) {
      // A file may disappear while Codex releases it. Retry the surviving
      // paths only; errors about a still-existing path must not mean "free".
      const remaining = batch.filter(file => {
        try { fs.lstatSync(file); return true } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
          throw new Error('could not check Codex writer ownership (ownership files inaccessible)')
        }
      })
      if (remaining.length < batch.length) {
        const retried = await openFiles(remaining)
        for (const [file, pids] of retried) owners.set(file, pids)
        continue
      }
      throw new Error('could not check Codex writer ownership (lsof could not inspect the ownership files)')
    }
    let pid: number | null = null
    let record: { pid: number; access?: string; file?: string } | null = null
    const finishRecord = (): void => {
      if (record === null) return
      if (record.access === undefined || record.file === undefined) {
        throw new Error('could not check Codex writer ownership (incomplete lsof file record)')
      }
      // Codex's writer guard opens the file read/write. Merely inspecting a
      // stale ownership file through less/tail must not label it as owned.
      if (record.access === 'u' || record.access === 'w') {
        const set = owners.get(record.file) ?? new Set<number>()
        set.add(record.pid); owners.set(record.file, set)
      }
      record = null
    }
    for (const line of result.stdout.split('\n')) {
      if (!line) continue
      if (/^p[1-9][0-9]*$/.test(line)) {
        finishRecord()
        pid = Number(line.slice(1))
        if (!Number.isSafeInteger(pid)) throw new Error('could not check Codex writer ownership (invalid process id)')
      } else if (/^f(?:0|[1-9][0-9]*)$/.test(line) && pid !== null) {
        finishRecord()
        if (!Number.isSafeInteger(Number(line.slice(1)))) throw new Error('could not check Codex writer ownership (invalid file descriptor)')
        record = { pid }
      } else if (/^a[ruw ]$/.test(line) && record !== null && record.access === undefined) {
        record.access = line.slice(1)
      } else if (line.startsWith('n') && record !== null && record.file === undefined && allowed.has(line.slice(1))) {
        record.file = line.slice(1)
      } else {
        throw new Error('could not check Codex writer ownership (unexpected lsof response)')
      }
    }
    finishRecord()
  }
  return owners
}

async function application(pid: number): Promise<string | null | undefined> {
  const result = await command('ps', ['-p', String(pid), '-o', 'comm='])
  if (result.code === 1 && !result.stdout.trim() && !result.stderr.trim()) return null
  if (result.code !== 0 || result.stderr.trim() || !result.stdout.trim() || /[\r\n]/.test(result.stdout.trim())) {
    throw new Error('could not check Codex writer ownership (process identity unavailable)')
  }
  // A known executable plus a write-capable ownership descriptor is useful
  // early evidence. An unrelated process opening this file is not Codex.
  const executable = path.basename(result.stdout.trim())
  if (!['codex', 'CodexCLI', 'codex.exe'].includes(executable)) return undefined
  const app = /(?:^|\/)ChatGPT\.app\//.test(result.stdout) ? 'ChatGPT'
    : /(?:^|\/)Codex\.app\//.test(result.stdout) ? 'Codex'
    : 'a Codex process'
  return app
}

export async function probeCodexWriters(
  info: LocalCodexServerInfo | null,
  threadIds: readonly string[],
): Promise<Map<string, CodexWriterOwner>> {
  const result = new Map<string, CodexWriterOwner>()
  if (info === null) return result // Unsupported metadata: the resume RPC remains authoritative.
  if (!path.isAbsolute(info.codexHome) || /[\0\r\n]/.test(info.codexHome) || !Number.isSafeInteger(info.pid) || info.pid <= 0) {
    throw new Error('could not check Codex writer ownership (invalid app-server identity)')
  }
  const files = new Map<string, string[]>()
  for (const id of threadIds) {
    if (!UUID.test(id)) throw new Error('could not check Codex writer ownership (invalid thread id)')
    const advertised = path.join(info.codexHome, 'thread-writer-locks', `${id.toLowerCase()}.lock`)
    let file: string
    try {
      if (!fs.lstatSync(advertised).isFile()) throw new Error('could not check Codex writer ownership (unexpected ownership file type)')
      file = fs.realpathSync(advertised)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      if (error instanceof Error && error.message.startsWith('could not check Codex writer ownership')) throw error
      throw new Error('could not check Codex writer ownership (ownership file inaccessible)')
    }
    const ids = files.get(file) ?? []
    ids.push(id); files.set(file, ids)
  }
  const owners = await openFiles([...files.keys()])
  const labels = new Map<number, string | null | undefined>()
  for (const [file, pids] of owners) for (const pid of pids) {
    if (pid === info.pid) continue // This server can reuse its existing writer.
    if (!labels.has(pid)) labels.set(pid, await application(pid))
    const label = labels.get(pid)
    if (label === undefined) continue // An alive unrelated executable is not positive Codex evidence.
    if (label === null) {
      // A writer can exit naturally between lsof and ps. Resolve that race
      // without asking the user to intervene or trusting a stale PID.
      const current = await openFiles([file])
      for (const replacement of current.get(file) ?? []) {
        if (replacement === info.pid) continue
        const replacementLabel = await application(replacement)
        if (typeof replacementLabel !== 'string') continue
        for (const id of files.get(file)!) result.set(id, { pid: replacement, application: replacementLabel })
      }
    } else {
      for (const id of files.get(file)!) result.set(id, { pid, application: label })
    }
  }
  return result
}
