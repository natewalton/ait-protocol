import path from 'node:path'
import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'
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

// Match run-pds.sh: inherited environment followed by sourced shell config,
// with relative database paths resolved from the PDS working directory.
export function localPdsAccountFile(repo) {
  const pdsDirectory = path.join(repo, 'pds')
  let values
  try {
    values = JSON.parse(execFileSync('/bin/bash', ['-c',
      'set -euo pipefail; cd "$1"; set -a; source ./.env >/dev/null 2>&1; set +a; exec "$2" -e "$3"',
      'ait-pds-environment', pdsDirectory, process.execPath,
      'process.stdout.write(JSON.stringify({ file: process.env.PDS_ACCOUNT_DB_LOCATION, data: process.env.PDS_DATA_DIRECTORY }))',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  } catch {
    throw Error('PDS environment could not be loaded with its service wrapper rules; inspect the local env file')
  }
  return path.resolve(pdsDirectory, values.file || path.join(values.data || '.', 'account.sqlite'))
}

export function resolveInstallationOperator(repo, configured) {
  if (!configured?.trim()) return resolveLocalOperator('', configured)
  try { return resolveLocalOperator(localPdsAccountFile(repo), configured) }
  catch {
    return { did: null, legacy: false,
      diagnostic: 'operator disabled: PDS environment could not be loaded; check its configured path and permissions; self-retirement remains available' }
  }
}
