import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyMailScope } from './default-mail-scope-test.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
test('reviewed distribution defaults qualify without running the mailer fixture', () => {
  assert.doesNotThrow(() => verifyMailScope(root, {}))
})
for (const name of ['PDS_EMAIL_SMTP_URL', 'PDS_MODERATION_EMAIL_SMTP_URL']) {
  test(`${name} is outside approval`, () => assert.throws(() => verifyMailScope(root, { [name]: 'smtp://example.invalid' }), /does not cover configured SMTP/))
}
for (const file of ['bin/install.sh', 'pds/launcher.js', 'pds/package-lock.json']) {
  test(`changed reviewed scope blocks: ${file}`, () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'ait-mail-scope-'))
    try {
      for (const entry of ['bin/install.sh', 'pds/launcher.js', 'pds/package-lock.json']) {
        mkdirSync(path.dirname(path.join(temp, entry)), { recursive: true })
        copyFileSync(path.join(root, entry), path.join(temp, entry))
      }
      const target = path.join(temp, file)
      if (file.endsWith('package-lock.json')) {
        const lock = JSON.parse(readFileSync(target, 'utf8'))
        lock.packages['node_modules/@atproto/pds/node_modules/nodemailer'].version = '10.5.0'
        writeFileSync(target, JSON.stringify(lock))
      } else writeFileSync(target, readFileSync(target, 'utf8') + '\nchanged\n')
      assert.throws(() => verifyMailScope(temp, {}), /reviewed .*changed/)
    } finally { rmSync(temp, { recursive: true, force: true }) }
  })
}
