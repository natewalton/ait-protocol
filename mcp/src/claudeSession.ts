// Claude owns sessions and continuation records. AIT owns only the durable
// runtime→identity binding, just as the Codex thread map does.
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { ownerDirectory, describeOwner, ownerEligible, publishOwner, readCheckpoint, commitCheckpoint, type DeliveryOwner, type Checkpoint } from './claudeDelivery.js'

const SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const uuid = (value: unknown): string | null => typeof value === 'string' && SHAPE.test(value.toLowerCase()) ? value.toLowerCase() : null
const directory = () => path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'ait-mcp')
function absolute(value: string): string {
  try { return fs.realpathSync(value) } catch { return path.resolve(value) }
}
const config = () => absolute(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'))
const identityFile = (id: string) => path.join(directory(), `identity-${createHash('sha256').update(id).digest('hex').slice(0, 16)}.json`)
const bindingFile = (id: string) => path.join(directory(), `claude-thread-${id}.json`)
export const CLAUDE_POLL_WARNING = 'AIT account preserved. Automatic mentions are unavailable in this worker; use listNotifications. Pending notifications remain available.'

const parentPid = process.ppid
let command: string | undefined
export function claudeParentCommand(): string {
  if (process.ppid !== parentPid) return ''
  if (command !== undefined) return command
  try { command = execFileSync('ps', ['-o', 'command=', '-p', String(parentPid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) }
  catch { command = '' }
  return command
}
export function claudeRuntimeUuid(): string | null {
  const own = uuid(process.env.CLAUDE_CODE_SESSION_ID)
  if (own && job(own)) return own
  // Ordinary sessions retain the existing Desktop/CLI resume resolution.
  const resumed = uuid(/--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(claudeParentCommand())?.[1])
  return resumed ?? own

}
export function effectiveNotificationMode(): 'push' | 'poll' | 'codex' {
  if (process.env.AIT_NOTIFICATION_MODE === 'codex') return 'codex'
  return process.env.AIT_NOTIFICATION_MODE === 'push' && claudeChannelsRequested() ? 'push' : 'poll'
}
export function claudeChannelsRequested(): boolean {
  // The test override is explicitly a non-harness transport fixture.
  if (process.env.AIT_MCP_TEST_SESSION_ID) return true
  // Claude rewrites its process title, so argv cannot prove channel activation.
  // A normal foreground launch retains the declared mode. Native jobs expose
  // the flags they actually inherit, independent of foreground title changes.
  const own = uuid(process.env.CLAUDE_CODE_SESSION_ID), state = own ? job(own) : null
  if (state === 'unreadable') return false
  if (!state || state.state === 'stopped') return true
  const args = state.respawnFlags ?? []
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--channels' && args[i] !== '--dangerously-load-development-channels') continue
    for (let j = i + 1; j < args.length && !args[j].startsWith('-'); j++) {
      if (args[j] === 'server:ait-protocol') return true
    }
  }
  return false
}
interface Binding { runtime: string; identity: string; source: string; project: string; config: string }
export function readClaudeBinding(id: string): Binding | null {
  const canonical = uuid(id)
  if (!canonical) return null
  id = canonical
  let value: Binding
  try { value = JSON.parse(fs.readFileSync(bindingFile(id), 'utf8')) as Binding }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  if (!value || typeof value !== 'object') throw new Error('Invalid Claude continuation binding; preserve it for repair.')
  const runtime = uuid(value.runtime), identity = uuid(value.identity), source = uuid(value.source)
  if (runtime !== id || !identity || !source || identity === id || typeof value.project !== 'string' || !path.isAbsolute(value.project) || typeof value.config !== 'string' || !path.isAbsolute(value.config)) throw new Error('Invalid Claude continuation binding; preserve it and repair the reported account conflict.')
  if (absolute(value.config) !== config()) return null
  if (fs.existsSync(identityFile(id))) throw new Error('Claude continuation conflicts with an already joined account; no identity was reassigned.')
  value = { ...value, runtime, identity, source }

  return value
}
export function claudeIdentityUuid(id: string): string {
  const visited = new Set<string>()
  while (true) {
    if (visited.has(id)) throw new Error('Claude continuation binding cycle')
    visited.add(id)
    const binding = readClaudeBinding(id)
    if (!binding) return id
    id = binding.identity
  }
}
interface Continuation { type: string; sessionId: string; continuedInSessionId: string; timestamp?: unknown }
interface ContinuationEdge { next: string; at: number | null }
interface Candidate { id: string; file: string }
interface ReadState { size: number; mtime: number; ino: number; edge: ContinuationEdge | null }
const reads = new Map<string, ReadState>()
// Fixed memory blocks; only candidate metadata is decoded. A growing file is
// read from its previous size, not scanned again. Misses are not persisted.
function continuation(candidate: Candidate): ContinuationEdge | null {
  let stat: fs.Stats
  try { stat = fs.lstatSync(candidate.file) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  if (!stat.isFile() || stat.isSymbolicLink()) return null
  const key = candidate.file
  const previous = reads.get(key)
  if (previous?.size === stat.size && previous.mtime === stat.mtimeMs && previous.ino === stat.ino) return previous.edge
  const unchangedPrefix = previous?.ino === stat.ino && previous.size < stat.size
  const lower = unchangedPrefix ? Math.max(0, previous!.size - 8192) : 0
  const fd = fs.openSync(candidate.file, 'r'), block = Buffer.allocUnsafe(65536 + 8192)
  let position = stat.size, suffix: Buffer = Buffer.alloc(0), edge = unchangedPrefix ? previous!.edge : null
  try {
    while (position > lower) {
      const n = Math.min(position - lower, 65536); position -= n
      const read = fs.readSync(fd, block, 0, n, position); suffix.copy(block, read)
      const bytes = block.subarray(0, read + suffix.length)
      if (bytes.indexOf('"continuedInSessionId"') >= 0) {
        for (const line of bytes.toString('utf8').split('\n').reverse()) {
          if (!line.includes('"continuedInSessionId"')) continue
          let value: Continuation
          try { value = JSON.parse(line) as Continuation } catch { continue }
          if (value.type === 'continued-in' && uuid(value.sessionId) === candidate.id && uuid(value.continuedInSessionId)) {
            if (uuid(value.continuedInSessionId) === candidate.id) throw new Error('Claude continuation points to itself')
            const timestamp = typeof value.timestamp === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.timestamp) ? Date.parse(value.timestamp) : NaN
            edge = { next: uuid(value.continuedInSessionId)!, at: Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value.timestamp ? timestamp : null }; position = lower; break
          }
        }
      }
      suffix = Buffer.from(block.subarray(0, Math.min(read, 8192)))
    }
  } finally { fs.closeSync(fd) }
  reads.set(key, { size: stat.size, mtime: stat.mtimeMs, ino: stat.ino, edge })
  return edge
}
function continuedTo(candidate: Candidate): string | null {
  return continuation(candidate)?.next ?? null
}
// A transcript edge records historical account lineage. Only an edge from this
// Claude process's lifetime can retire its delivery. MCP reconnect time is not
// evidence: the owning Claude process may still be the retired original.
let parentBirth: number | null | undefined
function claudeParentBirth(): number | null {
  if (process.ppid !== parentPid) return null
  if (parentBirth !== undefined) return parentBirth
  parentBirth = null
  if (!/^(?:\S*\/)?claude(?:\s|$)/.test(claudeParentCommand().trim())) return null
  try {
    const output = execFileSync('ps', ['-o', 'lstart=', '-p', String(parentPid)], {
      encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    }).trim()
    const match = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) +(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +(\d{1,2}) +(\d{2}):(\d{2}):(\d{2}) +(\d{4})$/.exec(output)
    if (!match) return null
    const [, month, day, hour, minute, second, year] = match
    const value = Date.UTC(Number(year), ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(month), Number(day), Number(hour), Number(minute), Number(second))
    // ps prints whole seconds. Same-second continuations stay conservative.
    const parsed = new Date(value)
    if (Number.isFinite(value) && value <= Date.now() && parsed.getUTCFullYear() === Number(year) && parsed.getUTCDate() === Number(day) && parsed.getUTCHours() === Number(hour) && parsed.getUTCMinutes() === Number(minute) && parsed.getUTCSeconds() === Number(second)) parentBirth = value
  } catch { /* Unknown process birth cannot authorize reclaiming delivery. */ }
  return parentBirth
}
function entries(dir: string): fs.Dirent[] {
  try { return fs.readdirSync(dir, { withFileTypes: true }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
}
function job(id: string): { sessionId?: string; state?: string; forkSessionId?: string; forkParentSessionId?: string; interactiveLineage?: boolean; cwd?: string; respawnFlags?: string[]; createdAt?: string } | 'unreadable' | null {
  const file = path.join(config(), 'jobs', id.slice(0, 8), 'state.json')
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!value || typeof value !== 'object') return 'unreadable'
    if (value.respawnFlags !== undefined && (!Array.isArray(value.respawnFlags) || !value.respawnFlags.every((flag: unknown) => typeof flag === 'string'))) return 'unreadable'
    if (value.cwd !== undefined && typeof value.cwd !== 'string') return 'unreadable'
    if (!uuid(value.sessionId)) return 'unreadable'
    return uuid(value.sessionId) === id ? { ...value, sessionId: id } : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return 'unreadable' // Absence is ordinary; unreadable native context is not foreground evidence.
  }
}
function candidates(): Candidate[] {
  const result: Candidate[] = []
  for (const project of entries(path.join(config(), 'projects'))) {
    if (!project.isDirectory()) continue
    const dir = path.join(config(), 'projects', project.name)
    for (const file of entries(dir)) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue
      const id = uuid(file.name.slice(0, -6))
      if (id) result.push({ id, file: path.join(dir, file.name) })
    }
  }
  for (const item of entries(path.join(config(), 'jobs'))) {
    if (!item.isDirectory()) continue
    const dir = path.join(config(), 'jobs', item.name)
    let state: { sessionId?: string; cwd?: string }
    try { state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) } catch { continue }
    const id = state && typeof state === 'object' ? uuid(state.sessionId) : null
    if (!id) continue
    for (const file of entries(dir)) if (file.isFile() && uuid(file.name.slice(0, -6)) === id && file.name.endsWith('.jsonl')) result.push({ id, file: path.join(dir, file.name) })
  }
  return result
}
export class ClaudeHandoverPending extends Error {
  constructor() { super('Claude is moving this session to the background. AIT is waiting for its continuation record; retry the tool. Do not join a new account.'); this.name = 'ClaudeHandoverPending' }
}
export function resolveClaudeIdentity(id: string): string {
  const existing = readClaudeBinding(id)
  if (existing) return claudeIdentityUuid(id)
  if (fs.existsSync(identityFile(id))) return id // Never reassign an already joined account.
  const own = uuid(process.env.CLAUDE_CODE_SESSION_ID)
  const state = own === id ? job(own) : null
  if (!state) return id
  if (state === 'unreadable') throw new ClaudeHandoverPending()
  // Independent /fork is explicitly identified by Claude's own job metadata.
  if (uuid(state?.forkSessionId) === id && uuid(state?.forkParentSessionId)) return id
  if (!state.interactiveLineage) return id
  const files = candidates(), roots = new Map<string, string>()
  const project = absolute(state?.cwd ?? process.cwd())
  // Follow native edges from AIT-bound roots. An intermediate worker need not
  // have called an AIT tool before its own continuation is recorded.
  for (const start of files) {
    let root: string
    try {
      if (!(fs.existsSync(identityFile(start.id)) || readClaudeBinding(start.id))) continue
      root = claudeIdentityUuid(start.id)
    } catch (error) {
      if (continuedTo(start) === id) throw error
      console.error(`AIT skipped Claude source ${start.id}: ${(error as Error).message}`)
      continue
    }
    const visited = new Set<string>()
    let source: Candidate | undefined = start
    while (source) {
      if (visited.has(source.id)) throw new Error('Claude continuation binding cycle')
      visited.add(source.id)
      const next = continuedTo(source)
      if (next === id) { roots.set(root, source.id); break }
      if (!next) break
      source = files.find(candidate => candidate.id === next)
    }
  }
  if (roots.size > 1) throw new Error('Conflicting Claude continuation sources; no account was reassigned.')
  const root = [...roots.keys()][0]
  if (root) {
    if (root === id) throw new Error('Claude continuation binding cycle')
    const binding: Binding = { runtime: id, identity: root, source: roots.get(root)!, project, config: config() }
    fs.mkdirSync(directory(), { recursive: true, mode: 0o700 })
    const file = bindingFile(id), temporary = `${file}.tmp.${process.pid}`
    try {
      fs.writeFileSync(temporary, JSON.stringify(binding), { mode: 0o600, flag: 'wx' })
      try { fs.linkSync(temporary, file) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const winner = readClaudeBinding(id)
        if (!winner || winner.identity !== root || winner.source !== binding.source) throw new Error('Conflicting Claude continuation binding; no account was reassigned.')
      }
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
    return root
  }
  // An explicit handover from a conversation that never joined AIT is not
  // missing evidence. Its continued worker may perform its own first join.
  for (const candidate of files) {
    const createdAt = Date.parse(state.createdAt ?? '')
    try { if (Number.isFinite(createdAt) && fs.statSync(candidate.file).mtimeMs < createdAt - 2000) continue }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    if (continuedTo(candidate) === id) return id
  }
  if (state.interactiveLineage && !state.forkParentSessionId) throw new ClaudeHandoverPending()
  return id
}
const owners = new Map<string, DeliveryOwner>()
let ownershipWarning: string | undefined
function deliveryOwner(runtime: string): DeliveryOwner | null {
  const root = claudeIdentityUuid(runtime), file = identityFile(root)
  if (!fs.existsSync(file)) return null // A session that has not joined can keep waiting.
  const did: unknown = JSON.parse(fs.readFileSync(file, 'utf8')).did
  if (typeof did !== 'string' || !did.startsWith('did:')) throw new Error('Claude delivery identity has no valid DID')
  const dir = ownerDirectory(directory(), did), key = dir + runtime
  const cached = owners.get(key)
  if (cached) return cached
  const born = claudeParentBirth()
  if (born === null) throw new Error('cannot verify the owning Claude process; resume through ait resume to enable automatic mentions')
  let epoch = born
  const binding = readClaudeBinding(runtime)
  if (binding) for (const source of candidates().filter(candidate => candidate.id === binding.source)) {
    const edge = continuation(source)
    if (edge?.next === runtime && edge.at !== null) epoch = Math.max(epoch, edge.at)
  }
  if (epoch > Date.now()) throw new Error('Claude handover time is in the future; check the machine clock before resuming automatic mentions')
  const owner = describeOwner(dir, runtime, born, parentPid, epoch)
  owners.set(key, owner)
  return owner
}
function ownershipUnavailable(error: unknown): false {
  const message = error instanceof Error ? error.message : String(error)
  if (ownershipWarning !== message) {
    ownershipWarning = message
    console.error('AIT automatic mentions unavailable: ' + message)
  }
  return false
}
const ownTranscripts = new Map<string, Candidate[]>()
function nativeRuntimeCurrent(runtime: string): boolean {
  if (process.ppid !== parentPid) return false
  const key = config() + runtime
  const own = ownTranscripts.get(key) ?? candidates().filter(candidate => candidate.id === runtime)
  if (own.length) ownTranscripts.set(key, own)
  for (const candidate of own) {
    const edge = continuation(candidate)
    if (!edge) continue
    const born = claudeParentBirth()
    if (edge.at === null || born === null || edge.at >= born) return false
  }
  return true
}
export function isClaudeRuntimeCurrent(): boolean {
  if (process.env.AIT_MCP_TEST_SESSION_ID || process.env.AIT_NOTIFICATION_MODE === 'codex') return true
  try {
    const runtime = claudeRuntimeUuid()
    if (!runtime || !nativeRuntimeCurrent(runtime)) return false
    const owner = deliveryOwner(runtime)
    return owner === null || ownerEligible(owner)
  } catch (error) { return ownershipUnavailable(error) }
}
// Called only by the existing push registration path, after identity resolution.
// Publishing is atomic; readers never observe a half-written owner record.
export function claimClaudeDelivery(initial: Checkpoint): boolean {
  if (process.env.AIT_MCP_TEST_SESSION_ID || process.env.AIT_NOTIFICATION_MODE === 'codex') return true
  try {
    const runtime = claudeRuntimeUuid()
    if (!runtime || !nativeRuntimeCurrent(runtime)) return false
    const owner = deliveryOwner(runtime)
    if (!owner) return false
    publishOwner(owner, initial)
    return isClaudeRuntimeCurrent()
  } catch (error) { return ownershipUnavailable(error) }
}
// Return null only before this account has delivery state. Once a claim exists,
// a stale runtime must never fall back to rewriting the credential-file cursor.
export function commitClaudeDeliveryCursor(expected: string | null | undefined, cursor: string): boolean | null {
  if (process.env.AIT_MCP_TEST_SESSION_ID || process.env.AIT_NOTIFICATION_MODE !== 'push') return null
  const runtime = claudeRuntimeUuid()
  if (!runtime) return false
  const owner = deliveryOwner(runtime)
  if (!owner || readCheckpoint(owner.dir) === null) return null
  if (!isClaudeRuntimeCurrent()) return false
  return commitCheckpoint(owner, expected, cursor) && isClaudeRuntimeCurrent()
}
export function claudeContinuedSessions(): Binding[] {
  const result: Binding[] = []
  for (const entry of entries(directory())) if (entry.isFile() && /^claude-thread-[0-9a-f-]{36}\.json$/.test(entry.name)) {
    try {
      const value = readClaudeBinding(entry.name.slice('claude-thread-'.length, -5))
      if (value) result.push(value)
    } catch (error) { console.error(`AIT skipped Claude binding ${entry.name}: ${(error as Error).message}`) }
  }
  return result
}
