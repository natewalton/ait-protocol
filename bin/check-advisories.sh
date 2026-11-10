#!/bin/bash
# Read-only release gate. docs/security.md owns the reviewed exceptions.
set -euo pipefail
[ "$#" -eq 0 ] || { echo 'Usage: bin/check-advisories.sh' >&2; exit 2; }
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
exec node - "$REPO" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repo = process.argv[2];
const workspaces = ['plc', 'pds', 'appview', 'mcp'];
try {
  const blocks = [...fs.readFileSync(path.join(repo, 'docs', 'security.md'), 'utf8')
    .matchAll(/<!-- advisory-exceptions -->\s*```json\s*([\s\S]*?)```/g)];
  if (blocks.length !== 1) throw Error('docs/security.md must contain exactly one advisory-exceptions JSON block');
  const exceptions = JSON.parse(blocks[0][1]);
  if (!Array.isArray(exceptions)) throw Error('advisory exceptions must be an array');
  const keys = new Set();
  for (const e of exceptions) {
    if (!Array.isArray(e.workspaces) || e.workspaces.length === 0 || e.workspaces.some(w => !workspaces.includes(w)) ||
        typeof e.package !== 'string' || !e.package ||
        !Array.isArray(e.advisories) || e.advisories.length === 0 || e.advisories.some(a => !/^GHSA-[a-z0-9-]+$/.test(a)) ||
        !Array.isArray(e.versions) || e.versions.length === 0 ||
        e.versions.some(v => typeof v !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(v)) ||
        typeof e.reason !== 'string' || !e.reason.trim() ||
        typeof e.removeWhen !== 'string' || !e.removeWhen.trim()) {
      throw Error('each exception needs workspaces, package, GHSA advisories, exact versions, reason, and removeWhen');
    }
    for (const workspace of e.workspaces) for (const advisory of e.advisories) for (const version of e.versions) {
      const key = JSON.stringify([workspace, e.package, advisory, version]);
      if (keys.has(key)) throw Error(`duplicate exception: ${key}`);
      keys.add(key);
    }
  }
  let failed = false;
  for (const workspace of workspaces) {
    const cwd = path.join(repo, workspace);
    const lock = JSON.parse(fs.readFileSync(path.join(cwd, 'package-lock.json'), 'utf8'));
    const run = spawnSync('npm', ['audit', '--json', '--package-lock-only',
      '--include=dev', '--include=optional', '--include=peer', '--audit-level=low'],
      { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (run.error || ![0, 1].includes(run.status)) throw Error(`${workspace}: npm audit failed: ${run.error || run.stderr || run.status}`);
    let audit;
    try { audit = JSON.parse(run.stdout); }
    catch { throw Error(`${workspace}: npm audit returned invalid JSON`); }
    if (audit.error || audit.auditReportVersion !== 2 || !audit.vulnerabilities ||
        Array.isArray(audit.vulnerabilities) ||
        !Number.isInteger(audit.metadata?.vulnerabilities?.total) ||
        Object.keys(audit.vulnerabilities).length !== audit.metadata.vulnerabilities.total) {
      throw Error(`${workspace}: incomplete/failed audit: ${JSON.stringify(audit.error || audit.metadata)}`);
    }
    let reviewed = 0, unreviewed = 0;
    for (const [name, vulnerability] of Object.entries(audit.vulnerabilities)) {
      if (!Array.isArray(vulnerability.via) || !vulnerability.via.length ||
          !Array.isArray(vulnerability.nodes) || !vulnerability.nodes.length) {
        throw Error(`${workspace}: incomplete audit finding for ${name}`);
      }
      for (const via of vulnerability.via) {
        // String entries are inherited findings. Their root advisory is checked
        // on the named vulnerable dependency, not exempted at its parent.
        if (typeof via === 'string') {
          if (!audit.vulnerabilities[via]) throw Error(`${workspace}: missing advisory dependency ${via}`);
          continue;
        }
        const match = /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9-]+)$/.exec(via?.url || '');
        if (!match) throw Error(`${workspace}: unrecognized advisory for ${name}`);
        for (const location of vulnerability.nodes) {
          const version = lock.packages?.[location]?.version;
          if (!version) throw Error(`${workspace}: ${location} absent from lockfile`);
          const key = JSON.stringify([workspace, name, match[1], version]);
          if (keys.has(key)) reviewed++;
          else {
            failed = true; unreviewed++;
            console.error(`UNREVIEWED ${workspace}: ${name}@${version} ${via.url}`);
          }
        }
      }
    }
    console.log(`${workspace}: ${reviewed} reviewed advisory/package instances, ${unreviewed} unreviewed`);
  }
  if (failed) throw Error('release blocked: review/fix the findings above; exceptions live in docs/security.md');
  console.log('Advisory gate passed. No dependencies or exceptions were changed.');
} catch (error) {
  console.error(`Advisory gate failed: ${error.message}`);
  process.exitCode = 1;
}
NODE
