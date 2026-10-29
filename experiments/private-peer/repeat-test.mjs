// Fixed-count reproducibility check, never a retry-until-pass loop.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
const root = mkdtempSync(path.join(tmpdir(), 'ait-private-peer-repeat-'))
const runs = []
for (let index = 1; index <= 20; index++) {
  const result = spawnSync('/usr/bin/sandbox-exec', ['-f', 'loopback.sb', process.execPath, 'integration-test.mjs'], {
    cwd: import.meta.dirname, encoding: 'utf8', timeout: 30000,
  })
  writeFileSync(path.join(root, `${index}.log`), result.stdout + result.stderr)
  const last = result.stdout.trim().split('\n').at(-1)
  const summary = last?.startsWith('{') ? JSON.parse(last) : {}
  const detail = summary.root ? JSON.parse(readFileSync(path.join(summary.root, 'result.json'))) : undefined
  runs.push({ index, status: result.status, signal: result.signal,
    error: result.error?.message, root: summary.root, resourceCheck: detail?.resourceCheck })
  writeFileSync(path.join(root, 'result.json'), JSON.stringify({ runs }, null, 2))
  assert.equal(result.status, 0, `run ${index} failed; see ${root}/${index}.log`)
  assert.equal(summary.passed, 8)
  console.log(`PASS ${index}/20: eight integration checks, cleanup and resource baseline`)
}
console.log(JSON.stringify({ passed: runs.length, root }))
