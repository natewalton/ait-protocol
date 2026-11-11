#!/usr/bin/env node
// All repositories, policy, subprocesses and reports below are synthetic and temporary.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { WORKSPACES, checkCandidate, parseAudit, validatePolicy, validateInstalledDependencies, dependencyFingerprint, nativeDependencyFingerprint, snapshotCandidate, hash, childEnv } from './check-advisories.mjs'

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-advisory-test-'))
const candidate = path.join(temporary, 'candidate'), trusted = path.join(temporary, 'trusted')
await test('real npm resolves distinct isolated user and global configuration', () => {
  const result = spawnSync('npm', ['config', 'get', 'registry'], { env: childEnv(temporary), cwd: temporary, encoding: 'utf8', timeout: 15000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'https://registry.npmjs.org/')
  assert.doesNotMatch(result.stderr, /double-loading|config file resolving/)
})
const id = 'GHSA-aaaa-bbbb-cccc'
const metadata = { severity: 'high', advisoryStatus: 'active', advisoryRevision: '2026-11-10T00:00:00Z' }
const lock = { lockfileVersion: 3, packages: { '': { name: 'fixture', version: '1.0.0', dependencies: { parent: '1.0.0' } }, 'node_modules/parent': { version: '1.0.0', dependencies: { leaf: '1.0.0' } }, 'node_modules/leaf': { version: '1.0.0' } } }
const empty = () => ({ auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 }, dependencies: {prod:2,dev:0,optional:0,peer:0,peerOptional:0,total:2} } })
function audit() {
  const a = empty()
  a.vulnerabilities = { parent: { name: 'parent', severity: 'high', nodes: ['node_modules/parent'], via: ['leaf'] }, leaf: { name: 'leaf', severity: 'high', nodes: ['node_modules/leaf'], via: [{ name: 'leaf', dependency: 'leaf', url: `https://github.com/advisories/${id}`, severity: 'high' }] } }
  a.metadata.vulnerabilities.high = a.metadata.vulnerabilities.total = 2
  return a
}
const git = (...args) => {
  const r = spawnSync('git', ['-C', candidate, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}
fs.mkdirSync(candidate, { recursive: true }); fs.mkdirSync(path.join(trusted, 'docs'), { recursive: true }); fs.mkdirSync(path.join(trusted, 'bin'))
fs.writeFileSync(path.join(trusted, 'docs/security.md'), 'synthetic trusted policy identity')
for (const w of WORKSPACES) {
  fs.mkdirSync(path.join(candidate, w)); fs.writeFileSync(path.join(candidate, w, 'package.json'), JSON.stringify({ name: w, version: '1.0.0' })); fs.writeFileSync(path.join(candidate, w, 'package-lock.json'), JSON.stringify(lock))
  fs.mkdirSync(path.join(candidate, w, 'node_modules'))
  const packages = structuredClone(lock.packages); delete packages['']
  fs.writeFileSync(path.join(candidate, w, 'node_modules/.package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }))
  for (const [location, entry] of Object.entries(packages)) {
    fs.mkdirSync(path.join(candidate, w, location), { recursive: true })
    fs.writeFileSync(path.join(candidate, w, location, 'package.json'), JSON.stringify({ version: entry.version }))
  }
}
fs.writeFileSync(path.join(candidate, '.gitignore'), 'node_modules/\n')
fs.mkdirSync(path.join(candidate, 'docs')); fs.writeFileSync(path.join(candidate, 'docs/security.md'), 'malicious old policy must not be read')
fs.mkdirSync(path.join(candidate, 'bin')); fs.writeFileSync(path.join(candidate, 'bin/regression.mjs'), 'throw new Error("CANDIDATE SCRIPT EXECUTED")')
fs.writeFileSync(path.join(trusted, 'bin/regression.mjs'), `import {spawnSync} from 'node:child_process'; const candidate = process.argv[process.argv.indexOf('--candidate')+1]; const commit=spawnSync('git',['-C',candidate,'rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim(); console.log(JSON.stringify({schemaVersion:1,candidateCommit:commit,status:'passed',checks:[{id:'bound',status:'passed'}],errors:[]}));`)
git('init', '-q'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
const candidateCommit = git('rev-parse', 'HEAD')
const cleanHash = hash(fs.readFileSync(path.join(candidate, 'plc/package-lock.json')))
const basePolicy = () => ({ schemaVersion: 1, supportedReleases: [], nativeArtifacts: [], embeddedComponents: [], dispositions: [] })
function disposition() {
  const now = new Date(), until = new Date(now.getTime() + 7 * 86400000)
  return { id: 'fixture-leaf', workspace: 'plc', package: 'leaf', version: '1.0.0', advisory: id, reviewedSeverity: 'high', advisoryStatus: metadata.advisoryStatus, advisoryRevision: metadata.advisoryRevision, decision: 'mitigated', owner: '@fixture', reviewedOn: now.toISOString().slice(0, 10), expiresOn: until.toISOString().slice(0, 10), reason: 'Synthetic fixture only', exposures: ['local-and-approved-peer'], components: [{ path: 'node_modules/leaf', dependencyFingerprint: dependencyFingerprint(lock, 'node_modules/leaf') }], evidence: ['https://example.invalid/fixture'], regressions: [{ path: 'bin/regression.mjs', check: 'bound' }] }
}
function options(policy = basePolicy(), overrides = {}) {
  return { policyRoot: trusted, policy, auditRunner: w => ({ status: 0, stdout: JSON.stringify(w === 'plc' ? audit() : empty()) }), metadataReader: async () => metadata, nativeRunner: () => ({ status: 0, stdout: JSON.stringify({ schemaVersion: 1, candidateCommit, status: 'complete', artifacts: [], errors: [] }) }), ...overrides }
}
const approved = () => { const p = basePolicy(); p.dispositions.push(disposition()); return p }
async function blocked(policy, pattern, overrides) { const result = await checkCandidate(candidate, options(policy, overrides)); assert.equal(result.status, 'blocked'); assert.match(result.blockers.join('\n'), pattern); assert.equal(hash(fs.readFileSync(path.join(candidate, 'plc/package-lock.json'))), cleanHash); return result }

try {
  await test('fresh ignored installations correspond to candidate locks', () => {
    assert.deepEqual(validateInstalledDependencies(candidate), Object.fromEntries(WORKSPACES.map(w => [w, 2])))
  })
  await test('standalone candidate regression refuses stale installed package before spawn', async () => {
    const full = path.join(candidate, 'plc/node_modules/leaf/package.json'), original = fs.readFileSync(full)
    fs.writeFileSync(full, JSON.stringify({ version: '0.9.0' }))
    try {
      const result = await blocked(approved(), /stale installed package version/)
      assert.equal(result.verifications[0].result, null)
    } finally { fs.writeFileSync(full, original) }
  })
  await test('missing hidden metadata blocks imports even when an ancestor install exists', () => {
    const metadata = path.join(candidate, 'plc/node_modules/.package-lock.json'), original = fs.readFileSync(metadata)
    const ancestor = path.join(candidate, 'node_modules/parent'); fs.mkdirSync(ancestor, { recursive: true }); fs.writeFileSync(path.join(ancestor, 'package.json'), '{"version":"1.0.0"}')
    fs.unlinkSync(metadata)
    try { assert.throws(() => validateInstalledDependencies(candidate), /ENOENT|metadata/) }
    finally { fs.writeFileSync(metadata, original); fs.rmSync(path.join(candidate, 'node_modules'), { recursive: true, force: true }) }
  })
  await test('installed version, source and integrity metadata must match the lock', () => {
    const metadata = path.join(candidate, 'plc/node_modules/.package-lock.json'), original = fs.readFileSync(metadata)
    try {
      for (const key of ['version', 'resolved', 'integrity']) {
        const installed = JSON.parse(original); installed.packages['node_modules/leaf'][key] = 'stale'
        fs.writeFileSync(metadata, JSON.stringify(installed))
        assert.throws(() => validateInstalledDependencies(candidate), /stale installed dependency identity/)
      }
    } finally { fs.writeFileSync(metadata, original) }
  })
  await test('unrecorded physical packages and ghost metadata are refused', () => {
    const metadata = path.join(candidate, 'plc/node_modules/.package-lock.json'), original = fs.readFileSync(metadata)
    const extra = path.join(candidate, 'plc/node_modules/extra'); fs.mkdirSync(extra); fs.writeFileSync(path.join(extra, 'package.json'), '{"version":"1.0.0"}')
    try { assert.throws(() => validateInstalledDependencies(candidate), /unexpected\/unrecorded/) }
    finally { fs.rmSync(extra, { recursive: true }) }
    const installed = JSON.parse(original); installed.packages['node_modules/ghost'] = { version: '1.0.0' }; fs.writeFileSync(metadata, JSON.stringify(installed))
    try { assert.throws(() => validateInstalledDependencies(candidate), /missing\/unexpected/) }
    finally { fs.writeFileSync(metadata, original) }
  })
  await test('installed metadata and package directories cannot be symlinked outside the candidate', () => {
    const metadata = path.join(candidate, 'plc/node_modules/.package-lock.json'), original = fs.readFileSync(metadata)
    const outside = path.join(temporary, 'outside-install.json'); fs.writeFileSync(outside, original); fs.unlinkSync(metadata); fs.symlinkSync(outside, metadata)
    try { assert.throws(() => validateInstalledDependencies(candidate), /unsafe installed dependency/) }
    finally { fs.unlinkSync(metadata); fs.writeFileSync(metadata, original) }
    const leaf = path.join(candidate, 'plc/node_modules/leaf'), saved = path.join(temporary, 'leaf'); fs.renameSync(leaf, saved); fs.symlinkSync(saved, leaf)
    try { assert.throws(() => validateInstalledDependencies(candidate), /unsafe installed dependency/) }
    finally { fs.unlinkSync(leaf); fs.renameSync(saved, leaf) }
  })
  await test('required transitive packages cannot fall back to an ancestor installation', () => {
    const leaf = path.join(candidate, 'plc/node_modules/leaf'), saved = path.join(temporary, 'leaf'); fs.renameSync(leaf, saved)
    const metadata = path.join(candidate, 'plc/node_modules/.package-lock.json'), original = fs.readFileSync(metadata), installed = JSON.parse(original)
    delete installed.packages['node_modules/leaf']; fs.writeFileSync(metadata, JSON.stringify(installed))
    try { assert.throws(() => validateInstalledDependencies(candidate), /missing required installed dependency/) }
    finally { fs.renameSync(saved, leaf); fs.writeFileSync(metadata, original) }
  })
  await test('absent optional platform entries are allowed but missing direct dev dependencies are not', () => {
    const full = path.join(candidate, 'plc/package-lock.json'), original = fs.readFileSync(full), changed = JSON.parse(original)
    const manifest = path.join(candidate, 'plc/package.json'), manifestOriginal = fs.readFileSync(manifest)
    changed.packages['node_modules/platform-only'] = { version: '1.0.0', optional: true, os: ['not-this-platform'] }; fs.writeFileSync(full, JSON.stringify(changed))
    try {
      assert.doesNotThrow(() => validateInstalledDependencies(candidate))
      fs.writeFileSync(manifest, JSON.stringify({ name: 'plc', version: '1.0.0', devDependencies: { 'platform-only': '1.0.0' } }))
      assert.throws(() => validateInstalledDependencies(candidate), /missing direct installed dependency/)
    } finally { fs.writeFileSync(full, original); fs.writeFileSync(manifest, manifestOriginal) }
  })
  await test('clean reports pass and conservative exposure does not depend on branch/version', async () => {
    const r = await checkCandidate(candidate, options(basePolicy(), { auditRunner: () => ({ status: 0, stdout: JSON.stringify(empty()) }) })); assert.equal(r.status, 'passed'); assert.equal(r.exposure, 'local-and-approved-peer')
  })
  await test('new high advisory blocks and ignores candidate old policy', async () => blocked(basePolicy(), /no current disposition/))
  await test('root references are evaluated once; matching disposition runs current trusted regression', async () => {
    const r = await checkCandidate(candidate, options(approved())); assert.equal(r.status, 'passed'); assert.equal(r.findings.length, 1); assert.equal(r.verifications.length, 1); assert.equal(r.verifications[0].candidateCommit, candidateCommit); assert.match(r.verifications[0].testDigest, /^sha256:/)
  })
  for (const [name, change, pattern] of [
    ['accepted high risk', d => { d.decision = 'accepted-risk'; d.regressions = [] }, /accepted reachable risk/],
    ['severity escalation', d => { d.reviewedSeverity = 'moderate' }, /severity\/status\/revision/],
    ['advisory status change', d => { d.advisoryStatus = 'withdrawn' }, /severity\/status\/revision/],
    ['advisory revision change', d => { d.advisoryRevision = '2026-11-09T00:00:00Z' }, /severity\/status\/revision/],
    ['local-only decision cannot pass a new stable or peer candidate', d => { d.exposures = ['local'] }, /supported exposure/],
    ['expired decision', d => { d.reviewedOn = '2026-01-01'; d.expiresOn = '2026-01-02' }, /expired/],
    ['changed dependency path', d => { d.components[0].dependencyFingerprint = `sha256:${'0'.repeat(64)}` }, /dependency path/],
    ['absent current regression', d => { d.regressions[0].path = 'bin/absent.mjs' }, /regression missing\/blocked/],
    ['explicit blocked migration is not grandfathered', d => { d.decision = 'blocked'; d.reason = 'proof outstanding' }, /proof outstanding/],
  ]) await test(name, async () => { const p = approved(); change(p.dispositions[0]); await blocked(p, pattern) })
  await test('immutable historical mapping alone selects narrower exposure', async () => { const p = approved(); p.dispositions[0].exposures = ['local']; p.supportedReleases.push({ tag: 'v1.0.0', commit: candidateCommit, exposure: 'local' }); assert.equal((await checkCandidate(candidate, options(p))).status, 'passed') })
  for (const [name, change, pattern] of [
    ['owner required', d => { delete d.owner }, /invalid disposition/],
    ['primary evidence required', d => { d.evidence = [] }, /invalid disposition/],
    ['High validity capped at 30 days', d => { d.reviewedOn = '2026-01-01'; d.expiresOn = '2026-03-01' }, /review period/],
    ['mitigation requires regression', d => { d.regressions = [] }, /missing regression/],
  ]) await test(name, () => { const p = approved(); change(p.dispositions[0]); assert.throws(() => validatePolicy(p), pattern) })
  for (const [name, change, pattern] of [
    ['cycle', a => { a.vulnerabilities.leaf.via = ['parent'] }, /cyclic/],
    ['missing inherited root', a => { a.vulnerabilities.parent.via = ['missing'] }, /missing\/incomplete/],
    ['unknown root severity', a => { a.vulnerabilities.leaf.via[0].severity = 'unknown' }, /invalid root/],
    ['unknown parent severity', a => { a.vulnerabilities.parent.severity = 'unknown' }, /incomplete/],
    ['inconsistent totals', a => { a.metadata.vulnerabilities.high = 1 }, /incomplete/],
    ['unsupported schema', a => { a.auditReportVersion = 3 }, /incomplete/],
    ['missing lock node', a => { a.vulnerabilities.leaf.nodes = ['node_modules/missing'] }, /absent from lock/],
  ]) await test(`audit fails closed: ${name}`, () => { const a = audit(); change(a); assert.throws(() => parseAudit(a, lock, 'plc'), pattern) })
  await test('new importer at unchanged hoisted location changes dependency fingerprint', () => { const changed = structuredClone(lock); changed.packages[''].dependencies.second = '1.0.0'; changed.packages['node_modules/second'] = { version: '1.0.0', dependencies: { leaf: '1.0.0' } }; assert.notEqual(dependencyFingerprint(changed, 'node_modules/leaf'), dependencyFingerprint(lock, 'node_modules/leaf')) })
  await test('same-version source integrity changes invalidate dependency identity', () => { const changed = structuredClone(lock); changed.packages['node_modules/leaf'].integrity = 'changed'; assert.notEqual(dependencyFingerprint(changed, 'node_modules/leaf'), dependencyFingerprint(lock, 'node_modules/leaf')) })
  await test('incomplete package coverage cannot masquerade as a clean report', () => { const a = empty(); a.metadata.dependencies.total = 0; assert.throws(() => parseAudit(a, lock, 'plc'), /complete locked/) })
  await test('reviewed lower severity risk passes without claiming mitigation', async () => { const p = approved(); p.dispositions[0].decision = 'accepted-risk'; p.dispositions[0].reviewedSeverity = 'moderate'; p.dispositions[0].regressions = []; const a = audit(); for (const v of Object.values(a.vulnerabilities)) v.severity = 'moderate'; a.vulnerabilities.leaf.via[0].severity = 'moderate'; a.metadata.vulnerabilities.high = 0; a.metadata.vulnerabilities.moderate = 2; const result = await checkCandidate(candidate, options(p, { auditRunner: w => ({ status: 0, stdout: JSON.stringify(w === 'plc' ? a : empty()) }), metadataReader: async () => ({ ...metadata, severity: 'moderate' }) })); assert.equal(result.status, 'passed'); assert.equal(result.verifications.length, 0) })
  await test('process outage/timeout and malformed JSON block without modifying locks', async () => {
    await blocked(approved(), /synthetic timeout/, { auditRunner: () => { throw new Error('synthetic timeout') } }); await blocked(approved(), /JSON/, { auditRunner: () => ({ status: 0, stdout: '{' }) })
  })
  await test('regression result for a different candidate blocks', async () => blocked(approved(), /invalid regression/, { regressionRunner: () => ({ status: 0, stdout: JSON.stringify({ schemaVersion: 1, candidateCommit: '0'.repeat(40), status: 'passed', checks: [{ id: 'bound', status: 'passed' }], errors: [] }) }) }))
  await test('native incomplete or wrong-candidate data blocks', async () => {
    await blocked(approved(), /native coverage incomplete/, { nativeRunner: () => ({ status: 1, stdout: JSON.stringify({ schemaVersion: 1, candidateCommit, status: 'incomplete', artifacts: [], errors: ['synthetic unavailable tool'] }) }) }); await blocked(approved(), /invalid native/, { nativeRunner: () => ({ status: 0, stdout: JSON.stringify({ schemaVersion: 1, candidateCommit: '0'.repeat(40), status: 'complete', artifacts: [], errors: [] }) }) })
  })
  await test('embedded component still requires real regression when external audit is clean', async () => { const p = basePolicy(); p.embeddedComponents.push({ workspace: 'plc', package: 'parent', location: 'node_modules/parent', version: '1.0.0', integrity: 'fixture', regressions: [{ path: 'bin/regression.mjs', check: 'bound' }] }); await blocked(p, /container identity changed/, { auditRunner: () => ({ status: 0, stdout: JSON.stringify(empty()) }) }) })
  await test('dirty candidate and commit-preserved assume-unchanged lock mutation are rejected', () => { const full = path.join(candidate, 'plc/package-lock.json'), original = fs.readFileSync(full); fs.appendFileSync(full, '\n'); assert.throws(() => snapshotCandidate(candidate), /dirty/); git('update-index', '--assume-unchanged', 'plc/package-lock.json'); assert.throws(() => snapshotCandidate(candidate), /differs from committed/); git('update-index', '--no-assume-unchanged', 'plc/package-lock.json'); fs.writeFileSync(full, original) })
  await test('candidate remains clean at completion', () => assert.equal(git('status', '--porcelain'), ''))
  // A separate committed candidate supplies the native artifact. Native tests
  // never download code or depend on an installed Cargo toolchain.
  const nativePolicy = { package: '@natewalton/iroh-direct', version: '0.1.0-experimental.1', url: 'https://example.invalid/native.tgz', digest: `sha256:${'1'.repeat(64)}`, sourceRepo: 'https://example.invalid/source', sourceCommit: '2'.repeat(40), lockDigest: `sha256:${'3'.repeat(64)}`, target: 'aarch64-apple-darwin' }
  const nativeLock = structuredClone(lock); nativeLock.packages[''].dependencies[nativePolicy.package] = nativePolicy.url; nativeLock.packages[`node_modules/${nativePolicy.package}`] = { version: nativePolicy.version, resolved: nativePolicy.url }
  fs.writeFileSync(path.join(candidate, 'appview/package-lock.json'), JSON.stringify(nativeLock)); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'native fixture')
  const nativeCommit = git('rev-parse', 'HEAD')
  const notice = { id: 'RUSTSEC-2026-0001', package: 'fixture-crate', version: '1.0.0', path: 'Cargo.lock#fixture-crate@1.0.0', severity: 'info', kind: 'unmaintained', advisoryStatus: 'active', advisoryRevision: `sha256:${'4'.repeat(64)}` }
  const artifact = { package: nativePolicy.package, version: nativePolicy.version, digest: nativePolicy.digest, sourceCommit: nativePolicy.sourceCommit, lockDigest: nativePolicy.lockDigest, findings: [notice] }
  function nativeOptions(p, a = artifact) { return options(p, { auditRunner: w => { const e = empty(); if (w === 'appview') e.metadata.dependencies.prod = e.metadata.dependencies.total = 3; return { status: 0, stdout: JSON.stringify(e) } }, nativeRunner: () => ({ status: 0, stdout: JSON.stringify({ schemaVersion: 1, candidateCommit: nativeCommit, status: 'complete', artifacts: [a], errors: [] }) }) }) }
  const nativeBase = () => { const p = basePolicy(); p.nativeArtifacts = [nativePolicy]; return p }
  await test('unreviewed native maintenance is distinct from a High vulnerability and blocks', async () => { const r = await checkCandidate(candidate, nativeOptions(nativeBase())); assert.equal(r.status, 'blocked'); assert.match(r.blockers.join('\n'), /maintenance \(unmaintained\)/) })
  await test('current native maintenance decision uses the same disposition model', async () => { const p = nativeBase(), d = disposition(); Object.assign(d, { id: 'native-notice', ecosystem: 'rust', workspace: 'appview', package: notice.package, version: notice.version, advisory: notice.id, reviewedSeverity: 'info', advisoryRevision: notice.advisoryRevision, decision: 'accepted-risk', regressions: [], components: [{ path: notice.path, dependencyFingerprint: nativeDependencyFingerprint(artifact, notice) }] }); p.dispositions = [d]; assert.equal((await checkCandidate(candidate, nativeOptions(p))).status, 'passed') })
  await test('native advisory without known severity stays blocked', async () => { const a = structuredClone(artifact); Object.assign(a.findings[0], { kind: 'vulnerability', severity: 'unknown' }); const r = await checkCandidate(candidate, nativeOptions(nativeBase(), a)); assert.equal(r.status, 'blocked'); assert.match(r.blockers.join('\n'), /unknown native severity/) })
  await test('native unsoundness cannot inherit an informational maintenance decision', async () => { const a = structuredClone(artifact); Object.assign(a.findings[0], { kind: 'unsound', severity: 'unknown' }); const r = await checkCandidate(candidate, nativeOptions(nativeBase(), a)); assert.equal(r.status, 'blocked'); assert.match(r.blockers.join('\n'), /unknown native severity/) })
  await test('native artifact/source-lock mismatch fails closed', async () => { const a = structuredClone(artifact); a.lockDigest = `sha256:${'9'.repeat(64)}`; const r = await checkCandidate(candidate, nativeOptions(nativeBase(), a)); assert.equal(r.status, 'blocked'); assert.match(r.blockers.join('\n'), /omitted a shipped binding|identity mismatch/) })
  await test('native tests also preserve candidate cleanliness', () => assert.equal(git('status', '--porcelain'), ''))
} finally { fs.rmSync(temporary, { recursive: true, force: true }) }
