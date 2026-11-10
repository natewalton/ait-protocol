#!/usr/bin/env node
// Run by the current trusted advisory checker, never by an old candidate tag.
import { readFileSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const trusted = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = { schemaVersion: 1, candidateCommit: '', status: 'incomplete', artifacts: [], errors: [] };
let scratch;
const hash = (data, algorithm = 'sha256') => createHash(algorithm).update(data).digest(algorithm === 'sha256' ? 'hex' : 'base64');
function run(command, args, options = {}) {
  const p = spawnSync(command, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024, ...options });
  if (p.error || p.signal) throw Error(`${command}: ${p.error?.message || p.signal}`);
  return p;
}
async function download(url, maxBytes) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000), redirect: 'follow' });
  if (!response.ok) throw Error(`download ${url}: HTTP ${response.status}`);
  const parts = [];
  let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > maxBytes) throw Error(`download exceeds ${maxBytes} bytes: ${url}`);
    parts.push(part);
  }
  return Buffer.concat(parts);
}
try {
  if (process.argv.length !== 4 || process.argv[2] !== '--candidate') throw Error('Usage: bin/check-native-advisories.mjs --candidate <checkout>');
  const candidate = resolve(process.argv[3]);
  const git = run('git', ['-C', candidate, 'rev-parse', 'HEAD']);
  if (git.status !== 0 || !/^[a-f0-9]{40}\s*$/.test(git.stdout)) throw Error('invalid candidate commit');
  result.candidateCommit = git.stdout.trim();
  const blocks = [...readFileSync(join(trusted, 'docs/security.md'), 'utf8').matchAll(/<!-- security-policy -->\s*```json\s*([\s\S]*?)```/g)];
  if (blocks.length !== 1) throw Error('expected one current security-policy block');
  const policy = JSON.parse(blocks[0][1]);
  if (policy.schemaVersion !== 1 || !Array.isArray(policy.nativeArtifacts)) throw Error('invalid current native policy');
  const native = [];
  for (const workspace of ['plc', 'pds', 'appview', 'mcp']) {
    const lock = JSON.parse(readFileSync(join(candidate, workspace, 'package-lock.json')));
    for (const [location, entry] of Object.entries(lock.packages || {})) {
      if (!location.endsWith('node_modules/@natewalton/iroh-direct')) continue;
      const identity = policy.nativeArtifacts.find(a => a.package === '@natewalton/iroh-direct' && a.version === entry.version && a.url === entry.resolved);
      if (!identity) throw Error(`${workspace}/${location}: unknown native source/artifact identity`);
      native.push({ identity, entry, location: `${workspace}/${location}` });
    }
    // A different native binding must be reviewed rather than silently omitted.
    for (const location of Object.keys(lock.packages || {})) {
      if (/node_modules\/(?:@number0\/iroh|@natewalton\/iroh-[^/]+)$/.test(location) && !location.endsWith('/iroh-direct')) throw Error(`unreviewed transport binding: ${workspace}/${location}`);
    }
  }
  if (native.length) scratch = mkdtempSync(join(tmpdir(), 'ait-native-audit-'));
  let auditTool = 'cargo-audit';
  if (native.length) {
    const installed = spawnSync(auditTool, ['--version'], { encoding: 'utf8', timeout: 10000 });
    if (installed.status !== 0 || installed.stdout.trim() !== 'cargo-audit 0.23.0') {
      if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('native audit requires cargo-audit 0.23.0 or a Darwin arm64 host for the pinned tool');
      const toolArchive = await download('https://github.com/rustsec/rustsec/releases/download/cargo-audit/v0.23.0/cargo-audit-aarch64-apple-darwin-v0.23.0.tgz', 32 * 1024 * 1024);
      if (hash(toolArchive) !== '84101204e5b8013c9a8d7251766aebdef3e7fa1a3ef040cde44d65b48b8c4056') throw Error('cargo-audit tool digest mismatch');
      const archivePath = join(scratch, 'cargo-audit.tgz');
      writeFileSync(archivePath, toolArchive);
      const extract = run('tar', ['-xzf', archivePath, '-C', scratch, 'cargo-audit-aarch64-apple-darwin-v0.23.0/cargo-audit']);
      if (extract.status !== 0) throw Error('cannot extract verified cargo-audit');
      auditTool = join(scratch, 'cargo-audit-aarch64-apple-darwin-v0.23.0/cargo-audit');
      chmodSync(auditTool, 0o700);
    }
  }
  for (const { identity: a, entry, location } of native) {
    if (!/^sha256:[0-9a-f]{64}$/.test(a.digest) || !/^sha256:[0-9a-f]{64}$/.test(a.lockDigest) || !/^[0-9a-f]{40}$/.test(a.sourceCommit) || a.sourceRepo !== 'https://github.com/natewalton/iroh-ffi' || a.target !== 'aarch64-apple-darwin') throw Error('invalid native provenance policy');
    const archive = await download(a.url, 32 * 1024 * 1024);
    if (`sha256:${hash(archive)}` !== a.digest) throw Error('native package digest mismatch');
    if (entry.integrity !== `sha512-${hash(archive, 'sha512')}`) throw Error('candidate native lock integrity mismatch');
    const sourceURL = `https://raw.githubusercontent.com/natewalton/iroh-ffi/${a.sourceCommit}/Cargo.lock`;
    const lockBytes = await download(sourceURL, 4 * 1024 * 1024);
    if (`sha256:${hash(lockBytes)}` !== a.lockDigest) throw Error('native source lock digest mismatch');
    const lockedPackages = [...lockBytes.toString('utf8').matchAll(/^\[\[package\]\]\s*$/gm)].length;
    if (!lockedPackages) throw Error('native source lock contains no packages');
    const file = join(scratch, 'Cargo.lock');
    writeFileSync(file, lockBytes);
    const audit = run(auditTool, ['audit', '--file', file, '--db', join(scratch, 'advisory-db'), '--url', 'https://github.com/RustSec/advisory-db', '--json'], { cwd: scratch });
    if (![0, 1].includes(audit.status)) throw Error(`native audit failed: ${audit.stderr || audit.status}`);
    const report = JSON.parse(audit.stdout);
    const record = value => value && typeof value === 'object' && !Array.isArray(value);
    if (!record(report.database) || !record(report.lockfile) || !record(report.vulnerabilities) || !/^[0-9a-f]{40}$/.test(report.database['last-commit'] || '') || !Number.isInteger(report.lockfile['dependency-count']) || report.lockfile['dependency-count'] < 1 || !Array.isArray(report.vulnerabilities.list) || report.vulnerabilities.count !== report.vulnerabilities.list.length || report.vulnerabilities.found !== (report.vulnerabilities.count > 0) || !record(report.warnings)) throw Error('incomplete native audit response');
    const databaseAge = Date.now() - Date.parse(report.database['last-updated']);
    if (report.lockfile['dependency-count'] !== lockedPackages) throw Error('native audit omitted locked packages');
    const settings = report.settings;
    if (!record(settings) || !Array.isArray(settings.ignore) || settings.ignore.length || !Array.isArray(settings.target_arch) || settings.target_arch.length || !Array.isArray(settings.target_os) || settings.target_os.length || settings.severity !== null) throw Error('native audit coverage was filtered');
    if (!Array.isArray(settings.informational_warnings) || JSON.stringify([...settings.informational_warnings].sort()) !== JSON.stringify(['notice', 'unmaintained', 'unsound'])) throw Error('native maintenance-warning coverage was filtered');
    // The DB is freshly fetched into a new temporary directory by this audit.
    // A quiet upstream repository may legitimately have an older last commit.
    if (!Number.isFinite(databaseAge) || databaseAge < -300000) throw Error('invalid native advisory database time');
    if (audit.status !== (report.vulnerabilities.count > 0 ? 1 : 0)) throw Error('native audit exit status disagrees with findings');
    const findings = [];
    const add = (v, kind) => {
      if (!v.package?.name || !v.package?.version) throw Error(`invalid native finding package (${kind})`);
      if (kind === 'yanked') {
        // Yanked-version notices have no RustSec advisory object or CVSS.
        // Preserve the registry finding; do not drop it or invent severity.
        findings.push({ id: `CRATES-IO-YANKED:${v.package.name}@${v.package.version}`, package: v.package.name, version: v.package.version, severity: 'unknown', path: `${location}/Cargo.lock:${v.package.name}@${v.package.version}`, kind, advisoryRevision: `sha256:${hash(JSON.stringify(v))}`, advisoryStatus: 'active', source: `https://crates.io/crates/${encodeURIComponent(v.package.name)}/${encodeURIComponent(v.package.version)}`, title: 'Locked crate version has been yanked' });
        return;
      }
      if (!/^RUSTSEC-\d{4}-\d{4}$/.test(v.advisory?.id || '')) throw Error(`invalid native advisory (${kind}: ${v.package.name}@${v.package.version})`);
      // Maintenance notices are informational; absent CVSS on an actual
      // vulnerability stays unknown and blocks until explicitly resolved.
      const maintenance = ['unmaintained', 'notice'].includes(kind);
      findings.push({ id: v.advisory.id, package: v.package.name, version: v.package.version, severity: maintenance ? 'info' : 'unknown', path: `${location}/Cargo.lock:${v.package.name}@${v.package.version}`, kind, advisoryRevision: `sha256:${hash(JSON.stringify(v.advisory))}`, advisoryStatus: v.advisory.withdrawn ? 'withdrawn' : 'active', source: `https://rustsec.org/advisories/${v.advisory.id}.html`, title: v.advisory.title });
    };
    for (const v of report.vulnerabilities.list) add(v, 'vulnerability');
    for (const [kind, warnings] of Object.entries(report.warnings)) {
      if (!['unmaintained', 'notice', 'unsound', 'yanked'].includes(kind)) throw Error(`unknown native warning kind: ${kind}`);
      if (!Array.isArray(warnings)) throw Error('invalid native warnings');
      for (const v of warnings) add(v, kind);
    }
    result.artifacts.push({ package: a.package, version: a.version, digest: a.digest, sourceCommit: a.sourceCommit, lockDigest: a.lockDigest, target: a.target, coverage: 'entire immutable workspace lock; no target/feature exclusions', databaseCommit: report.database['last-commit'], databaseCommitTime: report.database['last-updated'], checkedAt: new Date().toISOString(), dependencies: report.lockfile['dependency-count'], findings });
  }
  result.status = 'complete';
} catch (error) {
  result.errors.push(error.message);
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.status === 'complete' ? 0 : 1;
