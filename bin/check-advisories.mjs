#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const WORKSPACES = ['plc', 'pds', 'appview', 'mcp']
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical']
const HIGH = new Set(['high', 'critical'])
const trustedRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`
const fail = message => { throw new Error(message) }
const object = x => x && typeof x === 'object' && !Array.isArray(x)
const text = x => typeof x === 'string' && x.trim().length > 0
const digest = x => /^sha256:[a-f0-9]{64}$/.test(x || '')
const commit = x => /^[a-f0-9]{40}$/.test(x || '')
const date = x => /^\d{4}-\d{2}-\d{2}$/.test(x || '') && Number.isFinite(Date.parse(x)) && new Date(x).toISOString().slice(0, 10) === x
const severity = x => SEVERITIES.includes(x)
const githubSeverity = x => x === 'medium' ? 'moderate' : x
const relative = x => text(x) && !path.isAbsolute(x) && !x.split('/').includes('..') && !x.includes('\\')

export function loadPolicy(root) {
  const blocks = [...fs.readFileSync(path.join(root, 'docs/security.md'), 'utf8').matchAll(/<!-- security-policy -->\s*```json\s*([\s\S]*?)```/g)]
  if (blocks.length !== 1) fail('exactly one security-policy JSON block is required')
  return validatePolicy(JSON.parse(blocks[0][1]))
}

export function validatePolicy(policy) {
  if (!object(policy) || policy.schemaVersion !== 1 || !['supportedReleases', 'nativeArtifacts', 'embeddedComponents', 'dispositions'].every(k => Array.isArray(policy[k]))) fail('unsupported/incomplete security policy')
  const targets = new Map()
  for (const r of policy.supportedReleases) {
    if (!/^v\d+\.\d+\.\d+(?:-peer\.[1-9]\d*)?$/.test(r.tag || '') || !commit(r.commit) || !['local', 'local-and-approved-peer'].includes(r.exposure) || targets.has(r.tag)) fail('invalid/duplicate supported release')
    if ([...targets.values()].some(x => x.commit === r.commit && x.exposure !== r.exposure)) fail('conflicting historical exposure')
    targets.set(r.tag, r)
  }
  for (const a of policy.nativeArtifacts) if (!text(a.package) || !text(a.version) || !/^https:\/\//.test(a.url || '') || !digest(a.digest) || !commit(a.sourceCommit) || !/^https:\/\//.test(a.sourceRepo || '') || !digest(a.lockDigest) || !text(a.target)) fail('invalid native artifact policy')
  for (const c of policy.embeddedComponents) if (!WORKSPACES.includes(c.workspace) || !relative(c.location) || !text(c.package) || !text(c.version) || !text(c.integrity) || !Array.isArray(c.regressions) || !c.regressions.length) fail('invalid embedded component coverage')
  const ids = new Set(), dispositionKeys = new Set()
  for (const d of policy.dispositions) {
    if (!text(d.id) || ids.has(d.id) || !['npm', 'rust'].includes(d.ecosystem || 'npm') || !WORKSPACES.includes(d.workspace) || !text(d.package) || !text(d.version) || !(d.ecosystem === 'rust' ? /^RUSTSEC-\d{4}-\d+$/ : /^GHSA-[a-z0-9-]+$/).test(d.advisory || '') || !severity(d.reviewedSeverity) || !['blocked', 'non-applicable', 'mitigated', 'accepted-risk'].includes(d.decision) || !text(d.owner) || !date(d.reviewedOn) || !date(d.expiresOn) || !text(d.reason) || !Array.isArray(d.exposures) || !d.exposures.length || d.exposures.some(x => !['local', 'local-and-approved-peer'].includes(x)) || !Array.isArray(d.components) || !d.components.length || d.components.some(c => !relative(c.path) || !digest(c.dependencyFingerprint)) || !Array.isArray(d.evidence) || !d.evidence.length || d.evidence.some(x => !/^https:\/\//.test(x)) || !Array.isArray(d.regressions)) fail(`invalid disposition ${d.id || '<unnamed>'}`)
    if (new Date(d.expiresOn) < new Date(d.reviewedOn) || (HIGH.has(d.reviewedSeverity) && (new Date(d.expiresOn) - new Date(d.reviewedOn)) / 86400000 > 30)) fail(`invalid review period: ${d.id}`)
    if (d.decision !== 'blocked' && (!['active', 'withdrawn'].includes(d.advisoryStatus) || !text(d.advisoryRevision))) fail(`missing advisory revision: ${d.id}`)
    if (['non-applicable', 'mitigated'].includes(d.decision) && !d.regressions.length) fail(`missing regression: ${d.id}`)
    ids.add(d.id)
    for (const c of d.components) {
      const key = JSON.stringify([d.ecosystem || 'npm', d.workspace, d.package, d.version, d.advisory, c.path, c.dependencyFingerprint])
      if (dispositionKeys.has(key)) fail('duplicate disposition component')
      dispositionKeys.add(key)
    }
  }
  for (const r of [...policy.dispositions, ...policy.embeddedComponents].flatMap(x => x.regressions)) if (!object(r) || !relative(r.path) || !r.path.endsWith('.mjs') || !text(r.check)) fail('invalid trusted regression locator')
  return policy
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 90_000, maxBuffer: 24 * 1024 * 1024, ...options })
  if (result.error || ![0, 1].includes(result.status)) fail(`${command} failed: ${result.error?.message || result.stderr || result.status}`)
  return result
}
function git(root, args) {
  const r = run('git', ['-C', root, ...args])
  if (r.status !== 0) fail(`candidate git check failed: ${r.stderr}`)
  return r.stdout.trim()
}
export function snapshotCandidate(root) {
  root = fs.realpathSync(root)
  if (fs.realpathSync(git(root, ['rev-parse', '--show-toplevel'])) !== root) fail('candidate must be a complete repository root')
  const candidateCommit = git(root, ['rev-parse', 'HEAD'])
  if (!commit(candidateCommit)) fail('candidate commit is invalid')
  if (git(root, ['status', '--porcelain', '--untracked-files=normal'])) fail('candidate is dirty; use a clean immutable checkout')
  const locks = {}, lockDigests = {}
  for (const workspace of WORKSPACES) for (const filename of ['package.json', 'package-lock.json']) {
    const name = `${workspace}/${filename}`, full = path.join(root, name)
    if (!fs.lstatSync(full).isFile() || fs.realpathSync(full) !== full) fail(`candidate has unsafe path: ${name}`)
    const current = fs.readFileSync(full), committed = run('git', ['-C', root, 'show', `${candidateCommit}:${name}`], { encoding: 'buffer' })
    if (committed.status !== 0 || !current.equals(committed.stdout)) fail(`candidate differs from committed ${name}`)
    if (filename === 'package-lock.json') {
      locks[workspace] = JSON.parse(current); lockDigests[workspace] = hash(current)
      if (![2, 3].includes(locks[workspace].lockfileVersion) || !object(locks[workspace].packages) || !object(locks[workspace].packages[''])) fail(`unsupported lockfile: ${name}`)
    }
  }
  return { root, candidateCommit, locks, lockDigests }
}

// npm's ignored installation is not part of the Git candidate. Check that a
// regression will import this candidate's installed graph, not an old install
// or packages found in an ancestor directory. This checks correspondence, not
// package byte integrity or a hostile host; install with npm ci first.
export function validateInstalledDependencies(root) {
  root = fs.realpathSync(root)
  const checked = {}
  const locationPattern = /^node_modules\/(?:@[^/.][^/]*\/)?[^/.][^/]*(?:\/node_modules\/(?:@[^/.][^/]*\/)?[^/.][^/]*)*$/
  function safe(full, kind) {
    const stat = fs.lstatSync(full)
    if (stat.isSymbolicLink() || fs.realpathSync(full) !== full || !(kind === 'file' ? stat.isFile() : stat.isDirectory())) fail(`unsafe installed dependency path: ${full}`)
  }
  for (const workspace of WORKSPACES) {
    const directory = path.join(root, workspace), modules = path.join(directory, 'node_modules')
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')))
    const lock = JSON.parse(fs.readFileSync(path.join(directory, 'package-lock.json')))
    if (![2, 3].includes(lock.lockfileVersion) || !object(lock.packages)) fail(`${workspace}: invalid candidate dependency lock`)
    safe(modules, 'directory')
    const metadataPath = path.join(modules, '.package-lock.json')
    safe(metadataPath, 'file')
    const installed = JSON.parse(fs.readFileSync(metadataPath))
    if (installed.lockfileVersion !== 3 || !object(installed.packages)) fail(`${workspace}: missing/invalid installed dependency metadata; run npm ci`)
    const actual = new Set()
    function walkModules(directory) {
      safe(directory, 'directory')
      for (const name of fs.readdirSync(directory)) {
        if (name.startsWith('.')) continue // npm's .bin and hidden metadata
        const full = path.join(directory, name)
        safe(full, 'directory')
        if (name.startsWith('@')) {
          for (const child of fs.readdirSync(full)) visitPackage(path.join(full, child))
        } else visitPackage(full)
      }
    }
    function visitPackage(full) {
      safe(full, 'directory')
      const location = path.relative(directory, full).split(path.sep).join('/')
      if (!locationPattern.test(location) || !object(lock.packages[location]) || !object(installed.packages[location])) fail(`${workspace}: unexpected/unrecorded installed dependency: ${location}`)
      const expected = lock.packages[location], recorded = installed.packages[location]
      if (expected.link || recorded.link || ['version', 'resolved', 'integrity'].some(key => (expected[key] ?? null) !== (recorded[key] ?? null))) fail(`${workspace}: stale installed dependency identity: ${location}; run npm ci`)
      const packagePath = path.join(full, 'package.json')
      safe(packagePath, 'file')
      if (JSON.parse(fs.readFileSync(packagePath)).version !== expected.version) fail(`${workspace}: stale installed package version: ${location}; run npm ci`)
      actual.add(location)
      const nested = path.join(full, 'node_modules')
      if (fs.existsSync(nested)) walkModules(nested)
    }
    walkModules(modules)
    for (const location of Object.keys(installed.packages)) if (!actual.has(location)) fail(`${workspace}: installed metadata has missing/unexpected package: ${location}`)
    for (const [location, entry] of Object.entries(lock.packages)) {
      if (!location) continue
      if (!locationPattern.test(location) || !object(entry)) fail(`${workspace}: unsupported installed dependency location: ${location}`)
      if (!entry.optional && !actual.has(location)) fail(`${workspace}: missing required installed dependency: ${location}; run npm ci`)
    }
    for (const name of new Set([...Object.keys(manifest.dependencies || {}), ...Object.keys(manifest.devDependencies || {})])) {
      if (!Object.hasOwn(manifest.optionalDependencies || {}, name) && !actual.has(`node_modules/${name}`)) fail(`${workspace}: missing direct installed dependency: ${name}; run npm ci`)
    }
    checked[workspace] = actual.size
  }
  return checked
}

// Include all ancestor edges, so a new importer at a hoisted node cannot inherit
// an old path decision merely because its node_modules location stayed the same.
export function dependencyFingerprint(lock, location) {
  const packages = lock.packages, parents = new Map()
  const resolve = (from, name) => {
    let current = from
    while (true) {
      const candidate = `${current ? `${current}/` : ''}node_modules/${name}`
      if (packages[candidate]) return candidate
      if (!current) return null
      const i = current.lastIndexOf('/node_modules/')
      current = i < 0 ? '' : current.slice(0, i)
    }
  }
  for (const [from, entry] of Object.entries(packages)) for (const kind of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) for (const [name, range] of Object.entries(entry[kind] || {})) {
    const target = resolve(from, name)
    if (target) { const list = parents.get(target) || []; list.push([from, entry.version || '<root>', kind, name, range]); parents.set(target, list) }
  }
  const seen = new Set(), edges = []
  function visit(node) { if (seen.has(node)) return; seen.add(node); for (const edge of parents.get(node) || []) { edges.push([node, ...edge]); visit(edge[0]) } }
  visit(location)
  if (!packages[location]?.version || !seen.has('')) fail(`unrooted lockfile node: ${location}`)
  const identities = [...seen].sort().map(node => [node, packages[node].version || '<root>', packages[node].resolved || null, packages[node].integrity || null, packages[node].link || false])
  return hash(JSON.stringify({ location, identities, edges: edges.map(JSON.stringify).sort() }))
}

export function parseAudit(audit, lock, workspace) {
  const vs = audit?.vulnerabilities, counts = audit?.metadata?.vulnerabilities
  if (audit?.error || audit?.auditReportVersion !== 2 || !object(vs) || !object(counts) || [...SEVERITIES, 'total'].some(k => !Number.isInteger(counts[k]) || counts[k] < 0) || Object.keys(vs).length !== counts.total || SEVERITIES.reduce((n, s) => n + counts[s], 0) !== counts.total) fail(`${workspace}: incomplete audit report`)
  if (!object(audit.metadata.dependencies) || !['prod', 'dev', 'optional', 'peer', 'peerOptional', 'total'].every(k => Number.isInteger(audit.metadata.dependencies[k]) && audit.metadata.dependencies[k] >= 0) || audit.metadata.dependencies.total !== Object.keys(lock.packages).length - 1) fail(`${workspace}: audit did not cover the complete locked dependency graph`)
  const found = [], counted = Object.fromEntries(SEVERITIES.map(s => [s, 0])), visited = new Map()
  function visit(name, stack = new Set()) {
    if (stack.has(name)) fail(`${workspace}: cyclic inherited advisory: ${name}`)
    const v = vs[name]
    if (!object(v) || v.name !== name || !severity(v.severity) || !Array.isArray(v.via) || !v.via.length || !Array.isArray(v.nodes) || !v.nodes.length) fail(`${workspace}: missing/incomplete advisory root: ${name}`)
    if (visited.has(name)) return visited.get(name)
    stack.add(name)
    let worst = -1
    for (const location of v.nodes) { if (!relative(location) || !lock.packages[location]?.version) fail(`${workspace}: finding absent from lock: ${location}`); dependencyFingerprint(lock, location) }
    for (const via of v.via) {
      if (typeof via === 'string') { worst = Math.max(worst, SEVERITIES.indexOf(visit(via, stack))); continue }
      const id = /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9-]+)$/.exec(via?.url || '')?.[1]
      if (!object(via) || !id || !severity(via.severity) || via.name !== name || via.dependency !== name) fail(`${workspace}: invalid root advisory for ${name}`)
      worst = Math.max(worst, SEVERITIES.indexOf(via.severity))
      for (const location of v.nodes) found.push({ ecosystem: 'npm', workspace, package: name, version: lock.packages[location].version, advisory: id, severity: via.severity, path: location, dependencyFingerprint: dependencyFingerprint(lock, location) })
    }
    if (SEVERITIES[worst] !== v.severity) fail(`${workspace}: inconsistent inherited/root severity for ${name}`)
    stack.delete(name); visited.set(name, v.severity); counted[v.severity]++
    return v.severity
  }
  for (const name of Object.keys(vs)) visit(name)
  for (const s of SEVERITIES) if (counted[s] !== counts[s]) fail(`${workspace}: inconsistent severity totals`)
  return { counts, findings: [...new Map(found.map(f => [JSON.stringify(f), f])).values()] }
}

async function advisoryMetadata(id) {
  const response = await fetch(`https://api.github.com/advisories/${id}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AIT-security-gate', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) }, signal: AbortSignal.timeout(20_000) })
  if (!response.ok) fail(`advisory ${id} lookup failed: HTTP ${response.status}`)
  const raw = await response.text()
  if (raw.length > 2 * 1024 * 1024) fail(`oversized advisory metadata: ${id}`)
  const value = JSON.parse(raw)
  if (value.ghsa_id !== id || !severity(githubSeverity(value.severity)) || !text(value.updated_at) || !Object.hasOwn(value, 'withdrawn_at')) fail(`incomplete current advisory: ${id}`)
  return { severity: githubSeverity(value.severity), advisoryStatus: value.withdrawn_at ? 'withdrawn' : 'active', advisoryRevision: value.updated_at }
}

function findDisposition(f, policy) {
  return policy.dispositions.find(d => (d.ecosystem || 'npm') === (f.ecosystem || 'npm') && d.workspace === f.workspace && d.package === f.package && d.version === f.version && d.advisory === f.advisory && d.components.some(c => c.path === f.path && c.dependencyFingerprint === f.dependencyFingerprint))
}
export function evaluateFinding(f, policy, exposure, now, metadata, regression) {
  const d = findDisposition(f, policy)
  if (!d) return 'no current disposition for this advisory/version/dependency path'
  if (d.decision === 'blocked') return d.reason
  if (d.reviewedSeverity !== f.severity || metadata.severity !== f.severity || d.advisoryStatus !== metadata.advisoryStatus || d.advisoryRevision !== metadata.advisoryRevision) return 'advisory severity/status/revision changed'
  if (!d.exposures.includes(exposure)) return 'supported exposure differs from reviewed scope'
  if (d.reviewedOn > now || d.expiresOn <= now) return 'decision is future-dated or expired'
  if (HIGH.has(f.severity) && d.decision === 'accepted-risk') return 'accepted reachable risk cannot satisfy High/Critical policy'
  for (const r of d.regressions) if (!regression(r)) return `current candidate regression missing/blocked: ${r.path}#${r.check}`
  return null
}

export function childEnv(home) {
  return { PATH: process.env.PATH, HOME: home, TMPDIR: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, LANG: 'C.UTF-8', CI: '1', NPM_CONFIG_USERCONFIG: path.join(home, 'npm-user-config'), NPM_CONFIG_GLOBALCONFIG: path.join(home, 'npm-global-config') }
}

export function nativeDependencyFingerprint(artifact, finding) {
  return hash(JSON.stringify({ artifactDigest: artifact.digest, sourceCommit: artifact.sourceCommit, lockDigest: artifact.lockDigest, path: finding.path, package: finding.package, version: finding.version }))
}

export async function checkCandidate(root, options = {}) {
  const policyRoot = fs.realpathSync(options.policyRoot || trustedRoot), policy = options.policy || loadPolicy(policyRoot)
  const policyDigest = hash(fs.readFileSync(path.join(policyRoot, 'docs/security.md')))
  validatePolicy(policy)
  const before = snapshotCandidate(root), now = new Date().toISOString().slice(0, 10)
  const exposure = policy.supportedReleases.find(r => r.commit === before.candidateCommit)?.exposure || 'local-and-approved-peer'
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-advisory-gate-'))
  const blockers = [], findings = [], scannerTotals = {}, verifications = [], regressions = new Map(), decisions = new Map()
  const recordDecision = f => {
    const d = findDisposition(f, policy)
    decisions.set(d.id, { id: d.id, ecosystem: d.ecosystem || 'npm', decision: d.decision, owner: d.owner, expiresOn: d.expiresOn, components: d.components })
  }
  const regression = r => {
    if (!regressions.has(r.path)) {
      const full = path.join(policyRoot, r.path)
      if (!fs.existsSync(full) || fs.realpathSync(full) !== full || !fs.statSync(full).isFile()) { regressions.set(r.path, null); return false }
      const testDigest = hash(fs.readFileSync(full)); let result
      try {
        const resultRun = (options.regressionRunner || ((full, candidate) => {
          validateInstalledDependencies(candidate)
          return run(process.execPath, [full, '--candidate', candidate, '--json'], { cwd: policyRoot, env: childEnv(home), timeout: 420_000 })
        }))(full, before.root)
        result = JSON.parse(resultRun.stdout)
        if (![0, 1].includes(resultRun.status) || result.schemaVersion !== 1 || result.candidateCommit !== before.candidateCommit || !['passed', 'blocked'].includes(result.status) || !Array.isArray(result.checks) || !Array.isArray(result.errors) || result.checks.some(c => !text(c.id) || !['passed', 'blocked'].includes(c.status)) || new Set(result.checks.map(c => c.id)).size !== result.checks.length || (result.status === 'passed' && (resultRun.status !== 0 || result.errors.length || result.checks.some(c => c.status !== 'passed')))) fail(`invalid regression result: ${r.path}`)
        if (hash(fs.readFileSync(full)) !== testDigest) fail('trusted regression changed during execution')
      } catch (error) { blockers.push(`regression ${r.path}: ${error.message}`); result = null }
      regressions.set(r.path, result)
      verifications.push({ path: r.path, testDigest, candidateCommit: before.candidateCommit, lockDigests: before.lockDigests, result })
    }
    return regressions.get(r.path)?.checks.some(c => c.id === r.check && c.status === 'passed') === true
  }
  try {
    for (const workspace of WORKSPACES) try {
      const result = (options.auditRunner || ((workspace, cwd) => run('npm', ['audit', '--json', '--package-lock-only', '--include=dev', '--include=optional', '--include=peer', '--audit-level=low', '--ignore-scripts', '--registry=https://registry.npmjs.org'], { cwd, env: childEnv(home) })))(workspace, path.join(before.root, workspace))
      if (![0, 1].includes(result.status)) fail('npm audit process failed')
      const parsed = parseAudit(JSON.parse(result.stdout), before.locks[workspace], workspace)
      scannerTotals[workspace] = parsed.counts; findings.push(...parsed.findings)
    } catch (error) { blockers.push(`${workspace}: ${error.message}`) }
    for (const c of policy.embeddedComponents) {
      const entry = before.locks[c.workspace].packages[c.location]
      if (!entry) continue
      if (entry.version !== c.version || entry.integrity !== c.integrity) blockers.push(`embedded ${c.workspace}/${c.package}: container identity changed; review bundled coverage`)
      else for (const r of c.regressions) if (!regression(r)) blockers.push(`embedded ${c.workspace}/${c.package}: missing/blocked ${r.check}`)
    }
    const metadata = new Map()
    for (const f of findings) try {
      if (!metadata.has(f.advisory)) metadata.set(f.advisory, Promise.resolve().then(() => (options.metadataReader || advisoryMetadata)(f.advisory)))
      const m = await metadata.get(f.advisory)
      if (!object(m) || !severity(m.severity) || !['active', 'withdrawn'].includes(m.advisoryStatus) || !text(m.advisoryRevision)) fail('invalid current advisory metadata')
      const reason = evaluateFinding(f, policy, exposure, now, m, regression)
      if (reason) blockers.push(`${f.severity} ${f.workspace} ${f.package}@${f.version} ${f.advisory} ${f.path}: ${reason}`)
      else recordDecision(f)
    } catch (error) { blockers.push(`${f.advisory}: ${error.message}`) }
    let native
    try {
      const result = (options.nativeRunner || (() => run(process.execPath, [path.join(policyRoot, 'bin/check-native-advisories.mjs'), '--candidate', before.root], { cwd: policyRoot, env: childEnv(home), timeout: 300_000 })))()
      native = JSON.parse(result.stdout)
      if (![0, 1].includes(result.status) || native.schemaVersion !== 1 || native.candidateCommit !== before.candidateCommit || !['complete', 'incomplete'].includes(native.status) || !Array.isArray(native.artifacts) || !Array.isArray(native.errors)) fail('invalid native audit result')
      if (result.status !== 0 || native.status !== 'complete' || native.errors.length) fail(`native coverage incomplete: ${native.errors.join('; ')}`)
      const bindings = WORKSPACES.flatMap(w => Object.entries(before.locks[w].packages).filter(([location]) => location.endsWith('node_modules/@natewalton/iroh-direct')).map(([, p]) => p))
      if (bindings.length && !native.artifacts.length) fail('native coverage missing shipped binding')
      if (!bindings.length && native.artifacts.length) fail('unexpected native artifact')
      for (const b of bindings) if (!native.artifacts.some(a => policy.nativeArtifacts.some(p => p.package === a.package && p.version === b.version && p.url === b.resolved && p.digest === a.digest && p.sourceCommit === a.sourceCommit && p.lockDigest === a.lockDigest))) fail('native coverage omitted a shipped binding identity')
      for (const a of native.artifacts) {
        const expected = policy.nativeArtifacts.find(x => x.package === a.package && x.version === a.version && x.digest === a.digest && x.sourceCommit === a.sourceCommit && x.lockDigest === a.lockDigest)
        if (!expected || !Array.isArray(a.findings) || !bindings.some(b => b.version === a.version && b.resolved === expected.url)) fail('native artifact/source identity mismatch')
        for (const f of a.findings) {
          if (!text(f.id) || !text(f.package) || !text(f.version) || !text(f.path)) fail('incomplete native finding identity/path')
          const maintenance = ['unmaintained', 'notice', 'yanked'].includes(f.kind)
          if (!severity(f.severity) || (maintenance && f.severity !== 'info')) fail(`unknown native severity: ${f.id}`)
          if (!text(f.advisoryRevision) || !['active', 'withdrawn'].includes(f.advisoryStatus)) fail(`incomplete current native advisory metadata: ${f.id}`)
          const finding = { ...f, ecosystem: 'rust', workspace: 'appview', advisory: f.id, dependencyFingerprint: nativeDependencyFingerprint(a, f) }
          const reason = evaluateFinding(finding, policy, exposure, now, f, regression)
          if (reason) blockers.push(`native ${maintenance ? `maintenance (${f.kind})` : f.severity} ${f.package}@${f.version} ${f.id} ${f.path}: ${reason}`)
          else recordDecision(finding)
        }
      }
    } catch (error) { blockers.push(`native: ${error.message}`) }
    const after = snapshotCandidate(before.root)
    if (after.candidateCommit !== before.candidateCommit || JSON.stringify(after.lockDigests) !== JSON.stringify(before.lockDigests)) fail('candidate changed during verification')
    if (hash(fs.readFileSync(path.join(policyRoot, 'docs/security.md'))) !== policyDigest) fail('trusted policy changed during verification')
    return { schemaVersion: 1, status: blockers.length ? 'blocked' : 'passed', candidateCommit: before.candidateCommit, exposure, policyDigest, lockDigests: before.lockDigests, scannerTotals, findings, native, verifications, decisions: [...decisions.values()], blockers: [...new Set(blockers)] }
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
}

async function main() {
  const args = process.argv.slice(2); let candidate = trustedRoot, json = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--candidate' && args[i + 1]) candidate = path.resolve(args[++i])
    else if (args[i] === '--json') json = true
    else fail('Usage: bin/check-advisories.sh [--candidate <clean checkout>] [--json]')
  }
  const result = await checkCandidate(candidate)
  if (json) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(`Candidate ${result.candidateCommit}; exposure ${result.exposure}; coverage four npm locks + packaged transport Cargo graph`)
    for (const [workspace, counts] of Object.entries(result.scannerTotals)) console.log(`${workspace}: ${counts.high} High, ${counts.critical} Critical, ${counts.total} affected packages`)
    for (const d of result.decisions) console.log(`DECISION ${d.id}: ${d.decision}; owner ${d.owner}; expires ${d.expiresOn}`)
    for (const b of result.blockers) console.error(`BLOCKED: ${b}`)
    if (result.status === 'passed') console.log(`PASS: 0 unresolved release blockers; ${result.findings.length} root advisory/package instances remain under current dispositions. No dependencies changed.`)
  }
  process.exitCode = result.status === 'passed' ? 0 : 1
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(`BLOCKED: ${error.message}`); process.exitCode = 1 })
