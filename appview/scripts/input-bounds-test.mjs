#!/usr/bin/env node
// Small local byte fixtures only. No decoder, native addon, network or services.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { INPUT_BOUNDS, assertFrameBounds, assertRepoCarBounds } from '../src/inputBounds.mjs'

const bytes = hex => Buffer.from(hex.replaceAll(' ', ''), 'hex')
const op = bytes('a1 62 6f70 01') // {op:1}
const record = bytes('a1 64 74657874 62 6f6b') // {text:'ok'}
const cid = Buffer.concat([bytes('01711220'), createHash('sha256').update(record).digest()])
const header = Buffer.concat([bytes('a2 65 726f6f7473 81 d82a 5825 00'), cid, bytes('67 76657273696f6e 01')])
assert(header.length < 128)
const car = Buffer.concat([Buffer.from([header.length]), header, Buffer.from([cid.length + record.length]), cid, record])
const frame = Buffer.concat([op, record])
function rejected(check, value, pattern) {
  assert.throws(() => check(value), error => error.code === 'AIT_PEER_INPUT_LIMIT' && pattern.test(error.message))
}

await test('limits are declared and frozen before evaluating fixtures', () => {
  assert(Object.isFrozen(INPUT_BOUNDS))
  assert.deepEqual(INPUT_BOUNDS, { bytes: 104857600, depth: 64, frameNodes: 65536, carHeaderBytes: 1024, carBlockBytes: 1000000, carCidBytes: 36, carBlocks: 65536, blockNodes: 4096, carNodes: 1048576 })
})
await test('structurally bounded CAR and two-value frame return the original bytes', () => {
  assert.equal(assertRepoCarBounds(car), car)
  assert.equal(assertFrameBounds(frame), frame)
})
await test('nonzero-offset Uint8Array views use their own byte range', () => {
  const padded = Buffer.concat([bytes('ffff'), frame, bytes('ffff')])
  const view = new Uint8Array(padded.buffer, padded.byteOffset + 2, frame.length)
  assert.equal(assertFrameBounds(view), view)
})
await test('byte strings containing CBOR-looking bytes stay opaque', () => {
  const opaque = Buffer.concat([op, bytes('45 9f ffff 9b ff')])
  assert.equal(assertFrameBounds(opaque), opaque)
})
await test('64-bit integer values and finite float token widths do not become allocation sizes', () => {
  for (const value of ['1bffffffffffffffff', '3bffffffffffffffff', 'f93c00', 'fa3f800000', 'fb3ff0000000000000']) {
    assertFrameBounds(Buffer.concat([op, bytes(value)]))
  }
})
await test('CID tags are bounded as one tag plus one following value', () => {
  const value = Buffer.concat([op, bytes('d82a582500'), cid])
  assert.equal(assertFrameBounds(value), value)
})
await test('frame rejects absent, missing and extra CBOR sequence values before object decoding', () => {
  rejected(assertFrameBounds, Buffer.alloc(0), /truncated/)
  rejected(assertFrameBounds, op, /truncated/)
  rejected(assertFrameBounds, Buffer.concat([frame, bytes('f6')]), /exactly 2/)
})
await test('indefinite and reserved encodings are rejected consistently with lex-cbor', () => {
  for (const hex of ['9fff', 'bfff', '7fff', '5fff', '1c', 'fc', 'ff']) rejected(assertFrameBounds, Buffer.concat([op, bytes(hex)]), /indefinite|reserved/)
})
await test('advertised unsafe/oversized containers fail before traversing contents', () => {
  rejected(assertFrameBounds, Buffer.concat([op, bytes('9b0020000000000000')]), /safe integer/)
  rejected(assertFrameBounds, Buffer.concat([op, bytes('9affffffff')]), /budget/)
  rejected(assertFrameBounds, Buffer.concat([op, bytes('bb001fffffffffffff')]), /safe integer/)
  rejected(assertFrameBounds, Buffer.concat([op, bytes('5b0020000000000000')]), /safe integer/)
})
await test('truncated primitive arguments, tags and byte/text values fail locally', () => {
  for (const hex of ['18', '1b00', 'd8', 'd82a', 'fa0000', '63ab', '590001']) rejected(assertFrameBounds, Buffer.concat([op, bytes(hex)]), /truncated|budget/)
})
await test('container nesting has a fixed bound without recursive call-stack growth', () => {
  const atLimit = Buffer.concat([op, Buffer.alloc(INPUT_BOUNDS.depth, 0x81), bytes('f6')])
  assertFrameBounds(atLimit)
  rejected(assertFrameBounds, Buffer.concat([op, Buffer.alloc(INPUT_BOUNDS.depth + 1, 0x81), bytes('f6')]), /nesting/)
})
await test('small complete containers exceeding the frame node envelope fail preflight', () => {
  // 64 KiB fixture, not an exhaustion payload. One array advertises the entire
  // budget although the frame header/body nodes have already consumed part.
  const value = Buffer.concat([op, bytes('9a00010000'), Buffer.alloc(65536, 0xf6)])
  rejected(assertFrameBounds, value, /budget/)
})
await test('CAR varints/header lengths are bounded before slicing or decoding', () => {
  rejected(assertRepoCarBounds, Buffer.alloc(0), /truncated CAR header length/)
  rejected(assertRepoCarBounds, bytes('80'), /truncated CAR header length/)
  rejected(assertRepoCarBounds, bytes('8000'), /non-canonical/)
  rejected(assertRepoCarBounds, bytes('8108'), /header length exceeds 1024/)
  rejected(assertRepoCarBounds, bytes('04a0'), /truncated CAR header/)
  rejected(assertRepoCarBounds, bytes('00'), /empty CAR header/)
})
await test('CAR blocks require a bounded nonempty CBOR value after the upstream 36-byte CID', () => {
  const prefix = Buffer.concat([Buffer.from([header.length]), header])
  rejected(assertRepoCarBounds, Buffer.concat([prefix, bytes('24'), cid]), /no CBOR payload/)
  rejected(assertRepoCarBounds, Buffer.concat([prefix, bytes('25'), cid]), /truncated CAR block/)
  // 1,000,037 is one more than the fixed payload+CID limit; no payload needed.
  rejected(assertRepoCarBounds, Buffer.concat([prefix, bytes('e5843d')]), /block length exceeds/)
})
await test('CAR block CBOR preflight rejects trailing values and excessive declared work', () => {
  const prefix = Buffer.concat([Buffer.from([header.length]), header])
  const payloads = [bytes('f6f6'), bytes('9a00001000')]
  for (const body of payloads) rejected(assertRepoCarBounds, Buffer.concat([prefix, Buffer.from([cid.length + body.length]), cid, body]), /exactly 1|budget/)
})
await test('rejection does not corrupt the next allowed call', () => {
  rejected(assertFrameBounds, bytes('9bffffffffffffffff'), /safe integer/)
  assert.equal(assertFrameBounds(frame), frame)
  assert.equal(assertRepoCarBounds(car), car)
})
