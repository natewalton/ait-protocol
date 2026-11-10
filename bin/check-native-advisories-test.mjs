// Execute the real native helper in a disposable trusted/candidate pair.
// Only child-process fetch/cargo/git are replaced; production has no test switch.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(path.join(tmpdir(), 'ait-native-helper-test-'));
const sha = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest(algorithm === 'sha256' ? 'hex' : 'base64');
const commit = 'a'.repeat(40), sourceCommit = 'b'.repeat(40);
const packageBytes = Buffer.from('opaque verified package bytes: fixture, never executed');
const lockBytes = Buffer.from('version = 4\n[[package]]\nname = "fixture-a"\nversion = "1.0.0"\n[[package]]\nname = "fixture-b"\nversion = "2.0.0"\n');
const url = 'https://github.com/natewalton/iroh-ffi/releases/download/fixture/native.tgz';
const sourceURL = `https://raw.githubusercontent.com/natewalton/iroh-ffi/${sourceCommit}/Cargo.lock`;
const identity = { package: '@natewalton/iroh-direct', version: '0.1.0-experimental.1', url,
  digest: `sha256:${sha(packageBytes)}`, lockDigest: `sha256:${sha(lockBytes)}`,
  sourceCommit, sourceRepo: 'https://github.com/natewalton/iroh-ffi', target: 'aarch64-apple-darwin' };
const entry = { version: identity.version, resolved: url, integrity: `sha512-${sha(packageBytes, 'sha512')}` };
const vulnerability = { advisory: { id: 'RUSTSEC-2026-0384', title: 'Fixture vulnerability' }, package: { name: 'tokio', version: '1.54.0' } };
const warning = { advisory: { id: 'RUSTSEC-2021-0145', title: 'Fixture maintenance warning' }, package: { name: 'atty', version: '0.2.14' } };
const baseReport = () => ({ database: { 'last-commit': 'c'.repeat(40), 'last-updated': new Date().toISOString() },
  lockfile: { 'dependency-count': 2 }, settings: { ignore: [], target_arch: [], target_os: [], severity: null }, vulnerabilities: { found: false, count: 0, list: [] }, warnings: {} });
const policyText = policy => `<!-- security-policy -->\n\`\`\`json\n${JSON.stringify(policy)}\n\`\`\`\n`;
let checks = 0;
try {
  const trusted = path.join(scratch, 'trusted'), candidate = path.join(scratch, 'candidate'), bin = path.join(scratch, 'fake-bin');
  for (const directory of [path.join(trusted, 'bin'), path.join(trusted, 'docs'), path.join(candidate, 'docs'), bin]) mkdirSync(directory, { recursive: true });
  const helper = path.join(trusted, 'bin/check-native-advisories.mjs');
  copyFileSync(path.join(root, 'bin/check-native-advisories.mjs'), helper);
  const state = path.join(scratch, 'state.json'), downloads = path.join(scratch, 'downloads.json');
  const fetched = path.join(scratch, 'fetched.jsonl');
  const preload = path.join(scratch, 'fetch-fixture.mjs');
  writeFileSync(preload, `import fs from 'node:fs';
import net from 'node:net';
net.Socket.prototype.connect = function () { throw Error('fixture forbids real network connections'); };
globalThis.fetch = async input => {
  const url = String(input), responses = JSON.parse(fs.readFileSync(process.env.DOWNLOADS));
  fs.appendFileSync(process.env.FETCHED, JSON.stringify(url)+'\\n');
  if (!(url in responses)) throw Error('unregistered fixture URL '+url);
  return new Response(Buffer.from(responses[url], 'base64'));
};\n`);
  writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '-C' || args[2] !== 'rev-parse' || args[3] !== 'HEAD') process.exit(2);
console.log('${commit}');\n`, { mode: 0o700 });
  writeFileSync(path.join(bin, 'cargo-audit'), `#!${process.execPath}
const fs = require('node:fs'), args = process.argv.slice(2);
if (args.join(' ') === '--version') { console.log('cargo-audit 0.23.0'); process.exit(0); }
if (args[0] !== 'audit' || !args.includes('--json')) process.exit(2);
if (fs.readFileSync(args[args.indexOf('--file')+1], 'utf8') !== ${JSON.stringify(lockBytes.toString())}) process.exit(2);
const s = JSON.parse(fs.readFileSync(process.env.STATE));
process.stdout.write(typeof s.report === 'string' ? s.report : JSON.stringify(s.report));
process.exit(s.exit);\n`, { mode: 0o700 });

  function run(label, options = {}) {
    const policy = { schemaVersion: 1, nativeArtifacts: [{ ...identity, ...options.identity }] };
    writeFileSync(path.join(trusted, 'docs/security.md'), policyText(policy));
    // A candidate's own policy must never authorize its unregistered artifact.
    writeFileSync(path.join(candidate, 'docs/security.md'), policyText({ schemaVersion: 1,
      nativeArtifacts: [{ ...identity, version: '9.9.9' }] }));
    for (const workspace of ['plc', 'pds', 'appview', 'mcp']) {
      mkdirSync(path.join(candidate, workspace), { recursive: true });
      const packages = { '': { name: `fixture-${workspace}`, version: '1.0.0' } };
      if (workspace === 'appview') packages['node_modules/@natewalton/iroh-direct'] = { ...entry, ...options.entry };
      if (workspace === 'mcp' && options.duplicate) packages['node_modules/@natewalton/iroh-direct'] = { ...entry, integrity: 'sha512-invalid' };
      if (workspace === 'pds' && options.otherBinding) packages['node_modules/@number0/iroh'] = { version: '1.2.0' };
      writeFileSync(path.join(candidate, workspace, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }));
    }
    writeFileSync(downloads, JSON.stringify({ [url]: (options.packageBytes || packageBytes).toString('base64'),
      [sourceURL]: (options.lockBytes || lockBytes).toString('base64') }));
    writeFileSync(fetched, '');
    writeFileSync(state, JSON.stringify({ report: options.report ?? baseReport(), exit: options.exit ?? 0 }));
    const processResult = spawnSync(process.execPath, [helper, '--candidate', candidate], {
      env: { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: scratch, TMPDIR: scratch,
        NODE_OPTIONS: `--import=${pathToFileURL(preload)}`, DOWNLOADS: downloads, FETCHED: fetched, STATE: state },
      encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
    });
    assert.ifError(processResult.error);
    const result = JSON.parse(processResult.stdout);
    assert.equal(result.candidateCommit, commit);
    if (options.valid) {
      assert.equal(processResult.status, 0, `${label}: ${processResult.stderr} ${processResult.stdout}`);
      assert.equal(result.status, 'complete'); assert.deepEqual(result.errors, []);
      assert.equal(result.artifacts.length, 1);
      assert.equal(result.artifacts[0].digest, identity.digest);
      assert.equal(result.artifacts[0].sourceCommit, sourceCommit);
      assert.equal(result.artifacts[0].lockDigest, identity.lockDigest);
      assert.deepEqual(readFileSync(fetched, 'utf8').trim().split('\n').map(JSON.parse), [url, sourceURL]);
    } else {
      assert.equal(processResult.status, 1, `${label} incorrectly passed: ${processResult.stdout}`);
      assert.equal(result.status, 'incomplete'); assert.ok(result.errors.length > 0, label);
      if (options.error) assert.match(result.errors.join('; '), options.error, label);
    }
    checks++; console.log(`ok ${checks} - ${label}`); return result;
  }
  run('valid empty findings with verified artifact/source lock', { valid: true });
  const vulnerabilities = baseReport(); vulnerabilities.vulnerabilities = { found: true, count: 1, list: [vulnerability] };
  const found = run('actual vulnerability is retained, coverage complete but severity unresolved', { valid: true, report: vulnerabilities, exit: 1 });
  assert.equal(found.artifacts[0].findings[0].id, vulnerability.advisory.id);
  assert.equal(found.artifacts[0].findings[0].severity, 'unknown');
  const warnings = baseReport(); warnings.warnings = { unmaintained: [warning] };
  const warned = run('maintenance warnings retained without inventing severity', { valid: true, report: warnings });
  assert.equal(warned.artifacts[0].findings[0].kind, 'unmaintained');
  assert.equal(warned.artifacts[0].findings[0].severity, 'info');
  const quiet = baseReport(); quiet.database['last-updated'] = new Date(Date.now() - 172800000).toISOString();
  const fresh = run('fresh fetch may contain an older upstream commit', { valid: true, report: quiet });
  assert.ok(Number.isFinite(Date.parse(fresh.artifacts[0].checkedAt)));
  assert.equal(fresh.artifacts[0].databaseCommitTime, quiet.database['last-updated']);
  const yanked = baseReport(); yanked.warnings = { yanked: [{ kind: 'yanked', package: { name: 'tokio', version: '1.54.0' }, advisory: null }] };
  const yank = run('yanked crate without RustSec ID remains an explicit unclassified blocker', { valid: true, report: yanked });
  assert.equal(yank.artifacts[0].findings[0].id, 'CRATES-IO-YANKED:tokio@1.54.0');
  assert.equal(yank.artifacts[0].findings[0].severity, 'unknown');
  for (const [label, mutate, exit] of [
    ['configured advisory ignores cannot hide findings', r => { r.settings.ignore = ['RUSTSEC-2026-0384']; }, 0],
    ['target filtering cannot narrow full-lock coverage', r => { r.settings.target_os = ['linux']; }, 0],
    ['severity filtering cannot narrow full-lock coverage', r => { r.settings.severity = 7; }, 0],
    ['unknown warning category cannot pass coverage', r => { r.warnings = { new_schema: [] }; }, 0],
    ['count/list mismatch', r => { r.vulnerabilities.count = 1; }, 0],
    ['found flag disagreement', r => { r.vulnerabilities.found = true; }, 0],
    ['exit 1 without vulnerabilities', () => {}, 1],
    ['exit 0 despite vulnerability', r => { r.vulnerabilities = { found: true, count: 1, list: [vulnerability] }; }, 0],
    ['warnings array is malformed', r => { r.warnings = []; }, 0],
    ['warning category must be an array', r => { r.warnings = { unmaintained: {} }; }, 0],
    ['negative dependency count', r => { r.lockfile['dependency-count'] = -1; }, 0],
    ['omitted locked package', r => { r.lockfile['dependency-count'] = 1; }, 0],
    ['zero dependency count', r => { r.lockfile['dependency-count'] = 0; }, 0],
    ['future database timestamp', r => { r.database['last-updated'] = new Date(Date.now() + 3600000).toISOString(); }, 0],
    ['invalid database timestamp', r => { r.database['last-updated'] = 'invalid'; }, 0],
    ['malformed advisory id', r => { r.warnings = { unmaintained: [{ ...warning, advisory: { id: 'BAD' } }] }; }, 0],
  ]) {
    const report = baseReport(); mutate(report); run(label, { report, exit });
  }
  run('invalid JSON output', { report: '{broken', error: /JSON|property|position/i });
  run('tool failure cannot count as coverage', { exit: 2, error: /audit failed/ });
  run('package digest mismatch', { packageBytes: Buffer.from('tampered'), error: /package digest/ });
  run('source lock digest mismatch', { lockBytes: Buffer.from('tampered'), error: /source lock digest/ });
  run('candidate integrity mismatch', { entry: { integrity: 'sha512-invalid' }, error: /lock integrity/ });
  run('duplicate candidate entry integrity mismatch', { duplicate: true, error: /integrity/ });
  run('unregistered native version cannot use candidate policy', { entry: { version: '9.9.9' }, error: /unknown native/ });
  run('unregistered native URL', { entry: { resolved: `${url}?different` }, error: /unknown native/ });
  run('unreviewed alternate native binding', { otherBinding: true, error: /unreviewed transport/ });
  console.log(`PASS: ${checks} actual native-helper cases with fake fetch/cargo/git; no real network or native release claim`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
