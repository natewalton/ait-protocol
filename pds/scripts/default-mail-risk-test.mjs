// Trusted characterization of the approved default mail configuration.
// A passing check means the exact reviewed result was observed.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function verifyMailObservation(report) {
  assert.equal(report.result, 'OBSERVED')
  assert.equal(report.profile, 'managed-default-json')
  assert.equal(report.smtp, 'outside-approved-scope')
  assert.equal(report.pds, '0.5.59')
  assert.equal(report.nodemailer, '6.10.1')
  assert.deepEqual(report.observations, [
    { id: 'json-html-file-access', outcome: 'reference-read-despite-disabled-access' },
    { id: 'json-html-url-access', outcome: 'reference-read-despite-disabled-access' },
  ])
  assert.equal(report.parserTimingsMs.length, 2)
  assert.ok(report.parserTimingsMs.every(n => Number.isFinite(n) && n >= 0 && n < 1500), 'address parser exceeded fixed 1.5s budget')
  assert.equal(report.checks, 6)
}

async function main() {
  const [flag, directory, format] = process.argv.slice(2)
  assert.ok(flag === '--candidate' && directory && format === '--json')
  const candidate = path.resolve(directory)
  const report = { schemaVersion: 1, candidateCommit: '', status: 'blocked',
    configuration: 'managed-default-json',
    checks: [{ id: 'default-mail-approved-result', status: 'blocked' }],
    observations: [], excluded: ['operator-configured SMTP', 'moderation SMTP'], errors: [] }
  try {
    report.candidateCommit = execFileSync('git', ['-C', candidate, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    assert.ok(!process.env.PDS_EMAIL_SMTP_URL && !process.env.PDS_MODERATION_EMAIL_SMTP_URL,
      'approval does not cover configured SMTP')
    const reviewed = {
      'bin/install.sh': 'c73772f04b67ea60970c143dfd49190dcc29d580472c3cd5c4990ae54789fbc3',
      'pds/launcher.js': '68d5ce1cb794e48e76fce5b7ee2b23777a2354f0e9eeaad08d7e0df80e2b9f92',
      'appview/src/peerNetwork.mjs': '874f6d592e5836b1fad89c371bc230dd23b7e02d3cd80f9581cdaabae7737e58',
    }
    for (const [file, digest] of Object.entries(reviewed)) {
      assert.equal(createHash('sha256').update(readFileSync(path.join(candidate, file))).digest('hex'), digest,
        `reviewed mail defaults or exposure changed: ${file}`)
    }
    const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mailer-security-test.mjs')
    const child = spawnSync(process.execPath, [fixture, '--candidate', candidate, '--default-json', '--json'],
      { encoding: 'utf8', timeout: 100000, maxBuffer: 1024 * 1024,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR } })
    assert.ifError(child.error)
    assert.equal(child.status, 0, `mailer characterization failed: ${child.signal ?? child.stderr}`)
    const observation = JSON.parse(child.stdout.trim().split('\n').at(-1))
    report.fixture = observation
    report.observations = observation.observations
    verifyMailObservation(observation)
    report.checks[0].status = 'passed'
    report.status = 'passed'
  } catch (error) {
    report.errors.push(error.message)
  }
  console.log(JSON.stringify(report))
  process.exitCode = report.status === 'passed' ? 0 : 1
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
