// Resource preflight only: do not materialize CBOR values before the upstream
// decoder and schema/signature checks. These limits define the supported peer
// input envelope; they are fixed independently of the adversarial test results.
export const INPUT_BOUNDS = Object.freeze({
  bytes: 100 * 1024 * 1024,
  depth: 64,
  frameNodes: 65_536,
  carHeaderBytes: 1_024,
  carBlockBytes: 1_000_000,
  carCidBytes: 36, // @atproto/repo's reader slices exactly 36 bytes per CID.
  carBlocks: 65_536,
  blockNodes: 4_096,
  carNodes: 1_048_576,
})

function limit(message) {
  const error = new Error(`Peer input limit: ${message}`)
  error.code = 'AIT_PEER_INPUT_LIMIT'
  throw error
}

function input(bytes) {
  if (!(bytes instanceof Uint8Array)) limit('expected Uint8Array bytes')
  if (bytes.byteLength > INPUT_BOUNDS.bytes) limit(`encoded bytes exceed ${INPUT_BOUNDS.bytes}`)
}

// At most depth+1 counters, regardless of advertised container size. Byte/text
// strings are skipped by offset; no decoded string, byte copy, map, array, CID
// or per-token object is created. Upstream remains responsible for semantics
// (UTF-8, canonical numbers, map keys, CID tags, schemas and authentication).
function scan(bytes, start, end, values, maxNodes, aggregate) {
  let offset = start, nodes = 0
  const remaining = [values]
  const take = count => {
    if (count > end - offset) limit('truncated CBOR value')
    const at = offset
    offset += count
    return at
  }
  const argument = additional => {
    if (additional < 24) return additional
    const width = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : additional === 27 ? 8 : 0
    if (!width) limit('indefinite or reserved CBOR length')
    const at = take(width)
    let value = 0
    for (let i = 0; i < width; i++) {
      value = value * 256 + bytes[at + i]
      if (!Number.isSafeInteger(value)) limit('CBOR length exceeds safe integer range')
    }
    return value
  }
  while (remaining.length) {
    if (remaining[remaining.length - 1] === 0) { remaining.pop(); continue }
    remaining[remaining.length - 1]--
    if (++nodes > maxNodes || ++aggregate.nodes > aggregate.max) limit('CBOR node count exceeded')
    const token = bytes[take(1)], major = token >>> 5, additional = token & 31
    if (major === 0 || major === 1) {
      // Lex-CBOR permits 64-bit integer values. They do not describe an
      // allocation, so skip their bytes instead of coercing them to Number.
      if (additional < 24) continue
      const width = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : additional === 27 ? 8 : 0
      if (!width) limit('reserved CBOR integer encoding')
      take(width)
      continue
    }
    if (major === 7) {
      if (additional < 24) continue
      const width = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : additional === 27 ? 8 : 0
      if (!width) limit('indefinite or reserved CBOR simple value')
      take(width)
      continue
    }
    const length = argument(additional)
    if (major === 2 || major === 3) { take(length); continue }
    const children = major === 4 ? length : major === 5 ? length * 2 : 1 // A tag owns one following value.
    if (!Number.isSafeInteger(children)) limit('CBOR container length exceeds safe integer range')
    // Check the advertised minimum work BEFORE allocating or entering a loop.
    // Every declared child needs at least one token byte and one node.
    if (children > end - offset || children > maxNodes - nodes || children > aggregate.max - aggregate.nodes) limit('CBOR container exceeds remaining byte/node budget')
    if (remaining.length > INPUT_BOUNDS.depth) limit(`CBOR nesting exceeds ${INPUT_BOUNDS.depth}`)
    if (children) remaining.push(children)
  }
  if (offset !== end) limit(`expected exactly ${values} CBOR value${values === 1 ? '' : 's'}`)
}

export function assertFrameBounds(bytes) {
  input(bytes)
  // Frame.fromBytes() expects a header and body, but decodeAll() allocates all
  // values before rejecting extra ones. Enforce the sequence length first.
  scan(bytes, 0, bytes.byteLength, 2, INPUT_BOUNDS.frameNodes, { nodes: 0, max: INPUT_BOUNDS.frameNodes })
  return bytes
}

export function assertRepoCarBounds(bytes) {
  input(bytes)
  let offset = 0, blocks = 0
  const aggregate = { nodes: 0, max: INPUT_BOUNDS.carNodes }
  const section = (maximum, description) => {
    let size = 0, multiplier = 1, width = 0, byte
    do {
      if (offset >= bytes.byteLength) limit(`truncated CAR ${description} length`)
      byte = bytes[offset++]; width++
      size += (byte & 127) * multiplier
      if (!Number.isSafeInteger(size) || size > maximum || width > 8) limit(`CAR ${description} length exceeds ${maximum}`)
      multiplier *= 128
    } while (byte & 128)
    if (width > 1 && byte === 0) limit(`non-canonical CAR ${description} length`)
    if (size > bytes.byteLength - offset) limit(`truncated CAR ${description}`)
    if (!size) limit(`empty CAR ${description}`)
    return size
  }
  const headerSize = section(INPUT_BOUNDS.carHeaderBytes, 'header')
  scan(bytes, offset, offset + headerSize, 1, INPUT_BOUNDS.blockNodes, aggregate)
  offset += headerSize
  while (offset < bytes.byteLength) {
    if (++blocks > INPUT_BOUNDS.carBlocks) limit(`CAR block count exceeds ${INPUT_BOUNDS.carBlocks}`)
    const size = section(INPUT_BOUNDS.carBlockBytes + INPUT_BOUNDS.carCidBytes, 'block')
    if (size <= INPUT_BOUNDS.carCidBytes) limit('CAR block has no CBOR payload after its 36-byte CID')
    scan(bytes, offset + INPUT_BOUNDS.carCidBytes, offset + size, 1, INPUT_BOUNDS.blockNodes, aggregate)
    offset += size
  }
  return bytes
}
