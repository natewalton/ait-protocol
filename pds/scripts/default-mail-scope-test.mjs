// Verify the distribution defaults covered by the approved mail-risk decision.
// This does not inspect preserved operator configuration or reproduce vulnerabilities.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function verifyMailScope(candidate, env = process.env) {
  assert.ok(!env.PDS_EMAIL_SMTP_URL && !env.PDS_MODERATION_EMAIL_SMTP_URL,
    'approval does not cover configured SMTP')
  const reviewed = {
    'bin/install.sh': 'de8415a9d42ae404f2af3147d0002f54582fa1e38fe021f42e243376a641ddb2',
    'pds/launcher.js': '68d5ce1cb794e48e76fce5b7ee2b23777a2354f0e9eeaad08d7e0df80e2b9f92',
  }
  for (const [file, digest] of Object.entries(reviewed)) {
    assert.equal(createHash('sha256').update(readFileSync(path.join(candidate, file))).digest('hex'), digest,
      `reviewed mail defaults or exposure changed: ${file}`)
  }
  const { packages } = JSON.parse(readFileSync(path.join(candidate, 'pds/package-lock.json'), 'utf8'))
  assert.equal(packages['node_modules/@atproto/pds'].version, '0.5.59', 'reviewed PDS changed')
  assert.equal(packages['node_modules/@atproto/pds'].dependencies.nodemailer, '^6.8.0', 'upstream mail dependency range changed')
  assert.equal(packages['node_modules/@atproto/pds/node_modules/nodemailer'].version, '6.10.1', 'reviewed Nodemailer changed')
}

function main() {
  const [flag, directory, format] = process.argv.slice(2)
  assert.ok(flag === '--candidate' && directory && format === '--json')
  const candidate = path.resolve(directory)
  const report = { schemaVersion: 1, candidateCommit: '', status: 'blocked',
    configuration: 'managed-default-json',
    checks: [{ id: 'default-mail-approved-scope', status: 'blocked' }],
    excluded: ['operator-configured SMTP', 'moderation SMTP'], errors: [] }
  try {
    report.candidateCommit = execFileSync('git', ['-C', candidate, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    verifyMailScope(candidate)
    report.checks[0].status = 'passed'
    report.status = 'passed'
  } catch (error) {
    report.errors.push(error.message)
  }
  console.log(JSON.stringify(report))
  process.exitCode = report.status === 'passed' ? 0 : 1
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
