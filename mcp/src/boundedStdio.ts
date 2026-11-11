import { Readable } from 'node:stream'
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from '@modelcontextprotocol/sdk/shared/stdio.js'

const SLAB_BYTES = 64 * 1024

// Coalesce each bounded line once. The SDK still parses admitted JSON, checks
// JSON-RPC, and produces its own byte-overflow error/transport closure.
export function createBoundedStdio(
  source: Readable,
  onRejected: (result: JsonPreflightResult) => Promise<void>,
): Readable {
  const maximum = STDIO_DEFAULT_MAX_BUFFER_SIZE
  let slabs: Buffer[] = [], used = 0, size = 0
  let pending: Buffer | undefined, offset = 0, ended = false
  let rejection: Promise<void> | undefined
  const clear = () => { slabs = []; used = 0; size = 0 }
  const output = new Readable({
    highWaterMark: 1,
    read() { queueMicrotask(pump) },
    destroy(error, callback) {
      source.off('data', onData); source.off('end', onEnd); source.off('error', onError)
      source.pause(); pending = undefined; clear(); callback(error)
    },
  })
  function append(bytes: Buffer, from: number, count: number): void {
    while (count) {
      if (!slabs.length || used === slabs[slabs.length - 1].length) {
        slabs.push(Buffer.allocUnsafe(SLAB_BYTES)); used = 0
      }
      const last = slabs[slabs.length - 1], copied = Math.min(count, last.length - used)
      bytes.copy(last, used, from, from + copied)
      used += copied; size += copied; from += copied; count -= copied
    }
  }
  function seal(): Buffer {
    const last = slabs.length - 1
    slabs[last] = slabs[last].subarray(0, used)
    const frame = slabs.length === 1 ? slabs[0] : Buffer.concat(slabs, size)
    clear()
    return frame
  }
  function pump(): void {
    if (output.destroyed || rejection) return
    while (pending && offset < pending.length) {
      const newline = pending.indexOf(10, offset)
      const end = newline < 0 ? pending.length : newline + 1
      const copied = Math.min(end - offset, maximum + 1 - size)
      append(pending, offset, copied); offset += copied
      if (size > maximum) {
        // Forward at most maximum+1 actual bytes. The official SDK rejects
        // these before JSON parsing, using its unchanged framing diagnostic.
        const frame = seal(); pending = undefined; source.pause()
        output.push(frame)
        return
      }
      if (newline >= 0 && offset === end) {
        const frame = seal(), result = scanJsonFrame(frame)
        if (result.error) {
          source.pause()
          // Await the public transport's output drain before consuming more
          // rejected requests, so errors cannot create an unbounded write queue.
          rejection = Promise.resolve().then(() => onRejected(result))
          void rejection.catch(error => output.destroy(error)).finally(() => {
            rejection = undefined; pump()
          })
          return
        }
        if (!output.push(frame)) { source.pause(); return }
      }
    }
    pending = undefined
    if (ended) {
      if (size) output.push(seal()) // Preserve an unterminated EOF fragment.
      output.push(null)
    } else source.resume()
  }
  function onData(chunk: Buffer | string): void {
    source.pause()
    if (pending && offset < pending.length) {
      output.destroy(new Error('MCP input stream advanced while backpressured'))
      return
    }
    pending = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); offset = 0
    pump()
  }
  function onEnd(): void { ended = true; pump() }
  function onError(error: Error): void { output.destroy(error) }
  source.on('data', onData); source.on('end', onEnd); source.on('error', onError)
  source.pause()
  return output
}

export interface JsonPreflightResult {
  error?: string
  hasId: boolean
  id?: string | number | null
}

// Bounded-memory JSON shape walk. SDK remains responsible for JSON/JSON-RPC
// validation; this walk never materializes maps, arrays, or string contents.
// Continue scanning broad objects after the budget fails to locate a late root
// id. Deeper rejected subtrees are skipped with compact bracket matching.
export function scanJsonFrame(bytes: Buffer): JsonPreflightResult {
  const MAX_NODES = 65_536, MAX_DEPTH = 64
  const kind = new Uint8Array(MAX_DEPTH), state = new Uint8Array(MAX_DEPTH)
  let offset = 0, depth = 0, nodes = 0, rootDone = false, rootObject = false
  let reason: string | undefined, invalid = false
  let keyIsId = false, idStart = -1, idEnd = -1
  let overflowBrackets: Buffer | undefined
  const whitespace = (byte: number) => byte === 32 || byte === 9 || byte === 10 || byte === 13
  const hex = (byte: number) => byte >= 48 && byte <= 57 ? byte - 48
    : byte >= 65 && byte <= 70 ? byte - 55 : byte >= 97 && byte <= 102 ? byte - 87 : -1
  const token = () => { if (++nodes > MAX_NODES) reason ??= `JSON value/key count exceeds ${MAX_NODES}` }
  const string = (): boolean => {
    offset++
    while (offset < bytes.length) {
      const byte = bytes[offset++]
      if (byte === 34) return true
      if (byte < 32) return false
      if (byte !== 92) continue
      const escape = bytes[offset++]
      if (escape === 117) {
        for (let i = 0; i < 4; i++) if (offset >= bytes.length || hex(bytes[offset++]) < 0) return false
      } else if (escape !== 34 && escape !== 92 && escape !== 47 && escape !== 98 && escape !== 102 && escape !== 110 && escape !== 114 && escape !== 116) return false
    }
    return false
  }
  const isIdKey = (start: number, end: number): boolean => {
    let at = start + 1, index = 0
    while (at < end - 1) {
      let code = bytes[at++]
      if (code === 92) {
        if (bytes[at++] !== 117) return false
        code = 0
        for (let i = 0; i < 4; i++) code = code * 16 + hex(bytes[at++])
      }
      if (code !== (index++ === 0 ? 105 : 100) || index > 2) return false
    }
    return index === 2
  }
  const scalar = (): boolean => {
    const start = offset
    while (offset < bytes.length && !whitespace(bytes[offset]) && bytes[offset] !== 44 && bytes[offset] !== 93 && bytes[offset] !== 125) offset++
    const length = offset - start
    if (length === 4 && bytes[start] === 110 && bytes[start + 1] === 117 && bytes[start + 2] === 108 && bytes[start + 3] === 108) return true
    if (length === 4 && bytes[start] === 116 && bytes[start + 1] === 114 && bytes[start + 2] === 117 && bytes[start + 3] === 101) return true
    if (length === 5 && bytes[start] === 102 && bytes[start + 1] === 97 && bytes[start + 2] === 108 && bytes[start + 3] === 115 && bytes[start + 4] === 101) return true
    let at = start
    if (bytes[at] === 45) at++
    if (at >= offset) return false
    if (bytes[at] === 48) at++
    else {
      if (bytes[at] < 49 || bytes[at] > 57) return false
      while (at < offset && bytes[at] >= 48 && bytes[at] <= 57) at++
    }
    if (bytes[at] === 46) {
      at++
      const first = at
      while (at < offset && bytes[at] >= 48 && bytes[at] <= 57) at++
      if (at === first) return false
    }
    if (bytes[at] === 101 || bytes[at] === 69) {
      at++
      if (bytes[at] === 43 || bytes[at] === 45) at++
      const first = at
      while (at < offset && bytes[at] >= 48 && bytes[at] <= 57) at++
      if (at === first) return false
    }
    return at === offset && at > start
  }
  while (offset < bytes.length && !invalid) {
    if (whitespace(bytes[offset])) { offset++; continue }
    const top = depth - 1, byte = bytes[offset]
    if (depth === 0 && rootDone) { invalid = true; break }
    if (depth && state[top] === 2) { // object colon
      if (byte !== 58) { invalid = true; break }
      state[top] = 3; offset++; continue
    }
    if (depth && (state[top] === 4 || state[top] === 7)) { // comma or end
      if (byte === 44) { state[top] = kind[top] ? 6 : 1; offset++; continue }
      if (byte === (kind[top] ? 93 : 125)) { depth--; offset++; continue }
      invalid = true; break
    }
    if (depth && kind[top] === 0 && state[top] < 2) { // object key
      if (state[top] === 0 && byte === 125) { depth--; offset++; continue }
      if (byte !== 34) { invalid = true; break }
      const start = offset
      if (!string()) { invalid = true; break }
      token(); keyIsId = depth === 1 && rootObject && isIdKey(start, offset)
      state[top] = 2; continue
    }
    if (depth && kind[top] === 1 && state[top] === 5 && byte === 93) { depth--; offset++; continue }
    // A value consumes its parent's slot before descending into its children.
    const rootIdValue = depth === 1 && rootObject && keyIsId
    if (rootIdValue) { idStart = -1; idEnd = -1 }
    if (depth) state[top] = kind[top] ? 7 : 4
    else { rootDone = true; rootObject = byte === 123 }
    token()
    if (byte === 123 || byte === 91) {
      if (depth === MAX_DEPTH) {
        reason ??= `JSON nesting exceeds ${MAX_DEPTH}`
        // One bit per encoded nesting level validates bracket pairing while
        // skipping an already-rejected subtree. At most frameBytes/8 memory;
        // no nested values/keys are materialized or considered for request id.
        const brackets = overflowBrackets ??= Buffer.alloc(Math.ceil(bytes.length / 8))
        const setBracket = (level: number, array: boolean) => {
          if (array) brackets[level >>> 3] |= 1 << (level & 7)
          else brackets[level >>> 3] &= ~(1 << (level & 7))
        }
        setBracket(0, byte === 91)
        let skipped = 1; offset++
        while (offset < bytes.length && skipped) {
          const b = bytes[offset]
          if (b === 34) { if (!string()) { invalid = true; break } }
          else {
            if (b === 123 || b === 91) setBracket(skipped++, b === 91)
            if (b === 125 || b === 93) {
              const array = (brackets[(skipped - 1) >>> 3] & (1 << ((skipped - 1) & 7))) !== 0
              if (b !== (array ? 93 : 125)) { invalid = true; break }
              skipped--
            }
            offset++
          }
        }
        if (skipped) invalid = true
      } else { kind[depth] = byte === 91 ? 1 : 0; state[depth++] = byte === 91 ? 5 : 0; offset++ }
    } else {
      const start = offset
      if (!(byte === 34 ? string() : scalar())) { invalid = true; break }
      if (rootIdValue) { idStart = start; idEnd = offset }
    }
    keyIsId = false
  }
  if (depth || !rootDone) invalid = true
  const result: JsonPreflightResult = { ...(reason ? { error: reason } : {}), hasId: false }
  if (reason && !invalid && idStart >= 0) {
    // Only one bounded primitive is decoded, never the containing object.
    try {
      const id: unknown = JSON.parse(bytes.toString('utf8', idStart, idEnd))
      if (id === null || typeof id === 'string' || typeof id === 'number' && Number.isFinite(id)) {
        result.hasId = true; result.id = id
      }
    } catch { /* malformed primitive remains uncorrelated */ }
  }
  return result
}
