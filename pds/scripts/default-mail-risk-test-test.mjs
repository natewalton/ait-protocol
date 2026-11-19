import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyMailObservation } from './default-mail-risk-test.mjs'

const valid = () => ({
  result: 'OBSERVED', profile: 'managed-default-json', smtp: 'outside-approved-scope',
  pds: '0.5.59', nodemailer: '6.10.1', checks: 6, parserTimingsMs: [10, 12],
  observations: [
    { id: 'json-html-file-access', outcome: 'reference-read-despite-disabled-access' },
    { id: 'json-html-url-access', outcome: 'reference-read-despite-disabled-access' },
  ],
})
test('exact approved default JSON result retains both known failures', () => assert.doesNotThrow(() => verifyMailObservation(valid())))
for (const [name, change] of [
  ['missing case', r => { r.checks-- }],
  ['SMTP clearance', r => { r.smtp = 'tested' }],
  ['different profile', r => { r.profile = 'smtp' }],
  ['missing observation', r => { r.observations.pop() }],
  ['duplicate observation', r => { r.observations.push(r.observations[0]) }],
  ['changed observation', r => { r.observations[0].outcome = 'different' }],
  ['changed dependency', r => { r.nodemailer = '10.5.0' }],
  ['parser over budget', r => { r.parserTimingsMs[0] = 1500 }],
  ['missing parser result', r => { r.parserTimingsMs.pop() }],
  ['fixture failure', r => { r.result = 'FAIL' }],
]) test(name + ' blocks', () => {
  const report = valid()
  change(report)
  assert.throws(() => verifyMailObservation(report))
})
