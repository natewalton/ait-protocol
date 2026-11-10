import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { parse } from 'dotenv'
import { ensureValidDid, ensureValidHandle } from '@atproto/syntax'

// The installation's operator is a local principal, not a directory result.
// This read-only binding does not consult the AppView projection or peer state.
export function resolveLocalOperator(accountFile, configured) {
  const value = configured?.trim().replace(/^@/, '') ?? ''
  const disabled = reason => ({ did: null, legacy: false,
    diagnostic: `operator disabled: ${reason}; self-retirement remains available` })
  if (!value) return disabled('APPVIEW_OPERATOR is unset')
  const explicitDid = value.startsWith('did:')
  let reference = value
  let shorthand = false
  try {
    if (explicitDid) ensureValidDid(value)
    else {
      reference = value.toLowerCase()
      shorthand = !reference.includes('.') || /^[a-z0-9-]+\.(?:test|aitproto\.com)$/.test(reference)
      ensureValidHandle(shorthand ? `${reference.split('.')[0]}.test` : reference)
    }
  } catch {
    return disabled('APPVIEW_OPERATOR is malformed; configure a valid local account DID')
  }
  let accounts
  try {
    const db = new Database(accountFile, { readonly: true, fileMustExist: true })
    try { accounts = db.prepare('SELECT did, handle FROM actor ORDER BY did').all() }
    finally { db.close() }
  } catch {
    return disabled('the local PDS account store could not be read; check its configured path and permissions')
  }
  const matches = accounts.filter(account => explicitDid ? account.did === reference :
    typeof account.handle === 'string' && (shorthand
      ? account.handle.toLowerCase().split('.')[0] === reference.split('.')[0]
      : account.handle.toLowerCase() === reference))
  if (matches.length === 0) return disabled('APPVIEW_OPERATOR does not identify a local PDS account; configure its DID')
  if (matches.length !== 1) return disabled('APPVIEW_OPERATOR matches multiple local accounts; configure one explicit DID')
  const did = matches[0].did
  try { ensureValidDid(did) }
  catch { return disabled('the selected local account has an invalid DID') }
  return { did, legacy: !explicitDid,
    diagnostic: `operator ${did} bound to the local PDS account${explicitDid ? '' : '; legacy reference accepted, preparation will save its DID'}` }
}

// Match exactly one dotenv assignment at a time, including quoted multiline
// values. Replacing every matching assignment preserves dotenv's last-wins rule
// without leaving a stale duplicate or a dangling quoted value behind.
const assignment = /^(?:[ \t]*export[ \t]+)?[ \t]*APPVIEW_OPERATOR[ \t]*(?:=[ \t]*|:[ \t]+)(?:'(?:\\'|[^'])*'|"(?:\\"|[^"])*"|`(?:\\`|[^`])*`|[^#\r\n]*)[ \t]*(?:#[^\r\n]*)?/gm

export function planOperatorPreparation(accountFile, envFile) {
  const original = fs.readFileSync(envFile, 'utf8')
  const configured = parse(original).APPVIEW_OPERATOR
  const binding = resolveLocalOperator(accountFile, configured)
  const changed = binding.did !== null && configured !== binding.did
  const updated = changed ? original.replace(assignment, `APPVIEW_OPERATOR=${binding.did}`) : original
  if (changed) {
    assert.notEqual(updated, original, 'operator setting could not be replaced safely')
    assert.equal(parse(updated).APPVIEW_OPERATOR, binding.did, 'operator replacement does not match dotenv interpretation')
    const before = parse(original), after = parse(updated)
    delete before.APPVIEW_OPERATOR; delete after.APPVIEW_OPERATOR
    assert.deepEqual(after, before, 'operator preparation changed another environment setting')
  }
  return { envFile, original, updated, changed, binding }
}

function ownedFile(file) {
  const stat = fs.lstatSync(file)
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid(), 'operator environment must be an owned regular file')
  return stat
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r')
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

function writeSynced(file, text) {
  const fd = fs.openSync(file, 'wx', 0o600)
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

// Apply only under the supported stopped-service maintenance boundary. The plan
// is also the dry-run result; it carries the exact precondition and no writes.
export function applyOperatorPreparation(plan) {
  if (!plan.changed) return { ...plan.binding, changed: false }
  const { envFile, original, updated } = plan
  const initial = ownedFile(envFile)
  assert.equal(fs.readFileSync(envFile, 'utf8'), original, 'AppView environment changed during operator preparation; rerun while stopped')
  const digest = createHash('sha256').update(original).digest('hex')
  const backup = `${envFile}.operator-before-${digest}.local`
  try { writeSynced(backup, original) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    const stat = ownedFile(backup)
    assert.equal(stat.mode & 0o077, 0, 'operator rollback copy must be private')
    assert.equal(fs.readFileSync(backup, 'utf8'), original, 'operator rollback copy does not match the original environment')
  }
  syncDirectory(path.dirname(envFile))
  const temporary = `${envFile}.operator-${randomUUID()}.tmp`
  try {
    writeSynced(temporary, updated)
    const current = ownedFile(envFile)
    assert.equal(current.ino, initial.ino, 'AppView environment was replaced during operator preparation; rerun while stopped')
    assert.equal(fs.readFileSync(envFile, 'utf8'), original, 'AppView environment changed during operator preparation; rerun while stopped')
    fs.renameSync(temporary, envFile)
    syncDirectory(path.dirname(envFile))
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
  return { ...plan.binding, changed: true, backup }
}

export function prepareOperatorIdentity(accountFile, envFile) {
  return applyOperatorPreparation(planOperatorPreparation(accountFile, envFile))
}
