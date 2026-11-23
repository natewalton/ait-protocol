// Verify that the candidate uses the same macOS loading chain reviewed in #78.
// Cargo evidence for these immutable bytes is recorded in docs/security.md.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [flag, directory, format] = process.argv.slice(2)
if (flag !== '--candidate' || !directory || format !== '--json') {
  throw Error('Usage: node bin/chrono-macos-artifact-test.mjs --candidate <checkout> --json')
}
const candidate = resolve(directory)
const candidateCommit = execFileSync('git', ['-C', candidate, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const packageRoot = join(candidate, 'appview/node_modules/@natewalton/iroh-direct')
const files = {
  'package.json': '773b73fa89dd73870b1f5161a17076c998dd58bf589f7c85b8b22919e4cc8d5c',
  'index.cjs': 'd425560a7f57d16ad12f0464981b40101c8ed6f4ec30deee05bab1e6dafade39',
  'iroh.darwin-arm64.node': 'e56045238f76664184eb17a33717bafcdbdc1792bffbd52a34aa9d36deaa2bad',
}
const chronoErrors = []
try {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('reviewed transport requires macOS arm64')
  for (const [filename, expected] of Object.entries(files)) {
    const digest = createHash('sha256').update(readFileSync(join(packageRoot, filename))).digest('hex')
    if (digest !== expected) throw Error(`reviewed transport hash differs for ${filename}`)
  }
} catch (error) {
  chronoErrors.push(error.message)
}
const heaplessErrors = []
try {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('Heapless disposition requires macOS arm64')
  for (const [filename, expected] of Object.entries(files)) {
    const digest = createHash('sha256').update(readFileSync(join(packageRoot, filename))).digest('hex')
    if (digest !== expected) throw Error(`Heapless disposition hash differs for ${filename}`)
  }
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  if (manifest.name !== '@natewalton/iroh-direct' || manifest.version !== '0.1.0-experimental.3') {
    throw Error('Heapless disposition is bound to @natewalton/iroh-direct@0.1.0-experimental.3')
  }
  if (JSON.stringify(manifest.os) !== JSON.stringify(['darwin']) || JSON.stringify(manifest.cpu) !== JSON.stringify(['arm64'])) {
    throw Error('Heapless disposition is bound to the darwin-arm64 addon')
  }
  const addon = join(packageRoot, 'iroh.darwin-arm64.node')
  const symbols = execFileSync('/usr/bin/nm', ['-a', addon], { encoding: 'utf8' })
  const vulnerableSymbol = symbols.split('\n').find(line =>
    /heapless/i.test(line) && /sorted_linked_list|SortedLinkedList/.test(line) && /zeroize/i.test(line))
  if (vulnerableSymbol) throw Error('addon contains heapless SortedLinkedList zeroize symbol')
} catch (error) {
  heaplessErrors.push(error.message)
}
const errors = [
  ...chronoErrors.map(error => `chrono-macos-artifact: ${error}`),
  ...heaplessErrors.map(error => `heapless-unaffected-artifact: ${error}`),
]
const status = errors.length ? 'blocked' : 'passed'
console.log(JSON.stringify({
  schemaVersion: 1,
  candidateCommit,
  status,
  checks: [
    { id: 'chrono-macos-artifact', status: chronoErrors.length ? 'blocked' : 'passed' },
    { id: 'heapless-unaffected-artifact', status: heaplessErrors.length ? 'blocked' : 'passed' },
  ],
  errors,
}))
process.exitCode = errors.length ? 1 : 0
