// Execute the workflow's publication/relevance shell, with no GitHub access.
// This checks source DAG requirements, not GitHub's hosted runner or settings.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
const security = readFileSync(path.join(root, '.github/workflows/security.yml'), 'utf8');
// The checked files use literal, named step blocks; refuse an unfamiliar layout
// rather than evaluating YAML expressions or inventing an alternate workflow.
function step(document, name) {
  const marker = `      - name: ${name}\n`;
  assert.equal(document.split(marker).length, 2, `one named step: ${name}`);
  const content = document.split(marker)[1].split(/^      - /m)[0];
  const match = content.match(/^        run: \|\n([\s\S]*)/m);
  assert.ok(match, `literal shell block: ${name}`);
  return match[1].split(/\n(?= {0,9}\S)/, 1)[0].split('\n').map(line => line.slice(10)).join('\n').trim();
}
const publish = step(release, 'Publish inspected immutable release');
const prepare = step(release, 'Prepare inspected draft');
const relevance = step(security, 'Determine security relevance');
const validate = step(release, 'Validate candidate and run gates');
const dispositions = step(release, 'Verify and report release dispositions');
const preparationProof = step(release, 'Verify successful preparation for publication');
const publishBuild = step(release, 'Build candidate for fresh advisory regressions');
const identity = step(release, 'Verify release candidate identity');
assert.match(release, /- name: Validate candidate and run gates\n        if: inputs\.operation == 'prepare'/);
assert.match(release, /- name: Verify successful preparation for publication\n        if: inputs\.operation == 'publish'/);
assert.match(release, /- name: Build candidate for fresh advisory regressions\n        if: inputs\.operation == 'publish'/);
assert.match(release, /- name: Verify and report release dispositions\n        id: dispositions/);
assert.match(identity, /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/);
assert.match(publishBuild, /for workspace in plc pds appview mcp/);
assert.match(publishBuild, /npm --prefix appview run build/);
assert.match(publishBuild, /npm --prefix mcp run build/);
assert.doesNotMatch(publishBuild, /peer-link-test|upgrade-compatibility-test|check-advisories-test/);
const securityValidate = step(security, 'Test candidate security boundaries');
for (const block of [validate, securityValidate]) {
  assert.match(block, /git archive b4ea412c50caf3a21f5e270f65b20906dc76f0de pds/);
  assert.match(block, /npm --prefix "\$baseline\/pds" ci --no-audit/);
  assert.doesNotMatch(block, /node pds\/scripts\/mailer-security-test\.mjs/);
  assert.match(block, /node pds\/scripts\/upgrade-compatibility-test\.mjs --baseline "\$baseline"/);
  assert.match(block, /node mcp\/scripts\/stack-migration-test\.mjs/);
  assert.match(block, /node appview\/scripts\/identity-fetch-test\.mjs/);
  assert.match(block, /node mcp\/scripts\/list-tools-test\.mjs/);
  assert.match(block, /node pds\/scripts\/dependency-security-test\.mjs --candidate "\$GITHUB_WORKSPACE" --json/);
  assert.match(block, /node pds\/scripts\/xml-parser-test\.cjs/);
  assert.match(block, /node pds\/scripts\/default-mail-scope-test\.mjs --candidate "\$GITHUB_WORKSPACE" --json/);
  assert.ok(block.indexOf('node mcp/scripts/stack-migration-test.mjs') > block.indexOf('npm --prefix mcp run build'));
}
const releaseJob = release.slice(release.indexOf('\n  release:\n'));
assert.match(release, /validate:\n    if: [^\n]*inputs\.operation == 'prepare'[^\n]*inputs\.operation == 'publish'/);
assert.match(releaseJob, /needs: validate\n    if: needs\.validate\.result == 'success'/);
assert.match(dispositions, /bin\/check-advisories\.sh --candidate "\$GITHUB_WORKSPACE"/);
assert.match(validate, /node bin\/check-advisories-test\.mjs/);
assert.match(validate, /node bin\/security-workflow-test\.mjs/);
assert.ok(release.indexOf('bin/check-advisories.sh --candidate') > release.indexOf('node pds/scripts/default-mail-scope-test.mjs'));
assert.match(releaseJob, /ACCEPTED_UPSTREAM: \$\{\{ needs\.validate\.outputs\.accepted_upstream \}\}/);
assert.match(release, /permissions:\n  contents: read/);
assert.match(release, /validate:[\s\S]*?permissions:\n      contents: read\n      actions: read/);
assert.equal((security.match(/^  pull_request:/gm) || []).length, 1);
assert.ok(!/pull_request_target|schedule:|issues: write|contents: write/.test(security));
assert.match(security, /permissions:\n  contents: read/);
assert.match(security, /persist-credentials: false/);
assert.ok(!/pull_request:\n\s+paths:/.test(security), 'path-filtered required checks can remain pending');
assert.match(security, /if: steps\.changes\.outputs\.relevant == 'true'/);
assert.match(security, /bin\/check-advisories\.sh --candidate "\$GITHUB_WORKSPACE"/);
console.log('ok - workflow requires candidate tests at preparation and fresh advisory gates at publication');

const scratch = mkdtempSync(path.join(tmpdir(), 'ait-workflow-test-'));
const head = 'a'.repeat(40), other = 'b'.repeat(40);
try {
  const bin = path.join(scratch, 'bin'); mkdirSync(bin);
  const asset = path.join(scratch, 'install.sh'); writeFileSync(asset, '#!/bin/bash\nexit 0\n');
  const digest = createHash('sha256').update(readFileSync(asset)).digest('hex');
  const fake = `#!${process.execPath}
const fs = require('node:fs');
const command = require('node:path').basename(process.argv[1]);
const args = process.argv.slice(2), state = JSON.parse(fs.readFileSync(process.env.STATE));
fs.appendFileSync(process.env.CALLS, JSON.stringify([command,...args])+'\\n');
const output = value => process.stdout.write(String(value));
const save = () => fs.writeFileSync(process.env.STATE, JSON.stringify(state));
const fail = message => { console.error(message); process.exit(1); };
const record = () => ({ id: 91, tag_name: state.apiTag || process.env.RELEASE_TAG, target_commitish: state.apiTarget || process.env.HEAD,
  draft: state.draft, prerelease: state.wrongChannel ? !state.peer : state.peer, immutable: true,
  html_url: 'https://github.com/'+process.env.GITHUB_REPOSITORY+'/releases/tag/'+process.env.RELEASE_TAG,
  body: state.releaseNotes || '',
  assets: [{ name:'install.sh', digest:'sha256:'+(state.badDigest ? '0'.repeat(64) : process.env.DIGEST) },
    ...(state.extraAsset ? [{ name:'extra.sh' }] : [])] });
if (command === 'git') {
  if (args[0] === 'rev-parse') {
    if (args[1] === 'HEAD') output(process.env.HEAD);
    else if (args[1].startsWith('refs/ait-release-published/')) output(state.wrongPublishedTag ? '${other}' : process.env.HEAD);
    else output(state.moved ? '${other}' : process.env.HEAD);
  }
  else if (args[0] === 'ls-remote' && args.at(-1).startsWith('refs/heads/')) {
    output((state.remoteMoved ? '${other}' : process.env.HEAD)+'\\t'+args.at(-1));
  } else if (args[0] === 'ls-remote' && args.at(-1).startsWith('refs/tags/')) {
    if (state.tagLookupFailed) process.exit(128);
    process.exit(state.existingTag ? 0 : 2);
  } else if (args[0] === 'fetch' && args.at(-1).includes(':refs/ait-release-published/')) {
    if (state.missingPublishedTag) process.exit(128);
  } else if (args[0] === 'diff') output(state.paths || '');
  else fail('Unexpected git call '+args.join(' '));
} else if (command === 'gh') {
  if (args[0] === 'release' && args[1] === 'view') {
    if (args.includes('databaseId,targetCommitish,isDraft')) output('91\\t'+(state.viewTarget || process.env.HEAD)+'\\t'+state.draft);
    else if (args.includes('databaseId')) output('91');
    else output(JSON.stringify(record()));
  } else if (args[0] === 'release' && args[1] === 'create') { state.draft = true; state.mutations++; if (args.includes('--notes-file')) state.releaseNotes = fs.readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8'); save(); }
  else if (args[0] === 'release' && args[1] === 'edit') { state.draft = false; state.mutations++; save(); }
  else if (args[0] === 'api' && args.includes('repos/fixture/ait/actions/workflows/release.yml/runs')) {
    const run = { id: 852, run_attempt: 2, path: '.github/workflows/release.yml', event: 'workflow_dispatch',
      head_sha: process.env.HEAD, head_branch: process.env.GITHUB_REF_NAME, repository: { id: 44 },
      head_repository: { id: 44 }, status: 'completed', conclusion: 'success', ...state.run };
    output(JSON.stringify([{workflow_runs: []}, {workflow_runs: state.noPreparation ? [] : [run]}]));
  } else if (args[0] === 'api' && args.includes('repos/fixture/ait/actions/runs/852/attempts/2/jobs')) {
    const job = (name, steps) => ({ name, conclusion: 'success', run_attempt: state.jobAttempt ?? 2,
      head_sha: state.jobHead || process.env.HEAD,
      steps: steps.map(name => ({ name, conclusion: state.skippedStep === name ? 'skipped' : 'success' })) });
    output(JSON.stringify([{ jobs: [job('validate', ['Verify release candidate identity',
      'Assess supported releases during preparation', 'Validate candidate and run gates',
      'Verify and report release dispositions'])] }, { jobs: [job('release',
      ['Prepare exact release asset', 'Gate immutable release settings and ancestry',
       'Refuse migration-surface changes', 'Prepare inspected draft'])] }]));
  }
  else if (args[0] === 'api' && args[1].endsWith('/releases/latest')) {
    if (args.includes('--jq')) output(state.changedStableLatest && !state.draft ? '18' : '17'); else output(JSON.stringify(record()));
  } else if (args[0] === 'api' && args[1].endsWith('/releases/91')) output(JSON.stringify(record()));
  else fail('Unexpected gh call '+args.join(' '));
} else fail('Unexpected executable');
`;
  for (const name of ['git', 'gh']) writeFileSync(path.join(bin, name), fake, { mode: 0o700 });
  let sequence = 0;
  function runBlock(block, peer, overrides = {}) {
    const directory = path.join(scratch, String(sequence++)); mkdirSync(directory);
    const stateFile = path.join(directory, 'state.json'), callsFile = path.join(directory, 'calls.jsonl');
    writeFileSync(stateFile, JSON.stringify({ peer, draft: true, mutations: 0, ...overrides })); writeFileSync(callsFile, '');
    const script = path.join(directory, 'step.sh'); writeFileSync(script, block);
    const result = spawnSync('/bin/bash', [script], { encoding: 'utf8', timeout: 10000,
      env: { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: directory,
        GITHUB_REF_NAME: peer ? 'build/private-peer-integration' : 'main', GITHUB_REPOSITORY: 'fixture/ait',
        GITHUB_REPOSITORY_ID: '44', GITHUB_SHA: head,
        RELEASE_TAG: peer ? 'v0.1.46-peer.3' : 'v0.1.46', RELEASE_ASSET: asset, RUNNER_TEMP: directory,
        ACCEPTED_UPSTREAM: JSON.stringify(overrides.accepted || []), STATE: stateFile, CALLS: callsFile, HEAD: head, DIGEST: digest, BASE_SHA: other, GITHUB_OUTPUT: path.join(directory, 'output') },
    });
    assert.ifError(result.error);
    return { ...result, state: JSON.parse(readFileSync(stateFile)),
      calls: readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse), directory };
  }
  for (const peer of [false, true]) {
    const proof = runBlock(preparationProof, peer);
    assert.equal(proof.status, 0, proof.stderr);
    assert.match(proof.stdout, /Reusing preparation run 852, attempt 2/);
    for (const [label, overrides] of Object.entries({
      missing: { noPreparation: true }, wrongCommit: { run: { head_sha: other } },
      wrongBranch: { run: { head_branch: 'different-branch' } },
      wrongRepository: { run: { head_repository: { id: 45 } } },
      wrongWorkflow: { run: { path: '.github/workflows/security.yml' } },
      wrongJobCommit: { jobHead: other }, wrongJobAttempt: { jobAttempt: 1 },
      wrongEvent: { run: { event: 'pull_request' } },
      failed: { run: { conclusion: 'failure' } },
      testsSkipped: { skippedStep: 'Validate candidate and run gates' },
      publishedInstead: { skippedStep: 'Prepare inspected draft' },
      noMigrationCheck: { skippedStep: 'Refuse migration-surface changes' },
    })) {
      const refused = runBlock(preparationProof, peer, overrides);
      assert.notEqual(refused.status, 0, label);
      assert.match(refused.stderr, /No successful release preparation/, label);
      assert.equal(refused.state.mutations, 0);
    }
    const good = runBlock(publish, peer);
    assert.equal(good.status, 0, good.stderr); assert.equal(good.state.mutations, 1);
    const edit = good.calls.find(c => c[0] === 'gh' && c[2] === 'edit');
    assert.ok(edit.includes('--draft=false'));
    assert.ok(edit.includes(peer ? '--prerelease=true' : '--prerelease=false'));
    assert.ok(edit.includes(peer ? '--latest=false' : '--latest=true'));
    if (peer) assert.equal(good.calls.filter(c => c.includes('--jq') && c.includes('.id')).length, 2, 'peer verifies stable latest before/after');
    for (const [label, overrides] of Object.entries({ movedSource: { moved: true }, movedRemote: { remoteMoved: true }, existingTag: { existingTag: true }, tagLookupFailure: { tagLookupFailed: true }, wrongDraftTarget: { viewTarget: other },
      wrongApiTarget: { apiTarget: other }, wrongTag: { apiTag: 'v0.0.0' }, wrongDigest: { badDigest: true },
      extraAsset: { extraAsset: true }, publishedAlready: { draft: false }, wrongChannel: { wrongChannel: true } })) {
      const bad = runBlock(publish, peer, overrides);
      assert.notEqual(bad.status, 0, `${label} must fail`);
      assert.equal(bad.state.mutations, 0, `${label} must block before gh mutation`);
    }
    for (const options of [{ missingPublishedTag: true }, { wrongPublishedTag: true }]) {
      const bad = runBlock(publish, peer, options);
      assert.notEqual(bad.status, 0, 'published tag must resolve to the prepared commit');
      assert.equal(bad.state.mutations, 1, 'tag readback happens after publication');
    }
    const draft = runBlock(prepare, peer);
    assert.equal(draft.status, 0, draft.stderr); assert.equal(draft.state.mutations, 1);
    const create = draft.calls.find(c => c[0] === 'gh' && c[2] === 'create');
    assert.ok(create.includes('--draft')); assert.ok(create.includes('--latest=false'));
    assert.equal(create.includes('--prerelease'), peer); assert.equal(create[create.indexOf('--target') + 1], head);
  }
  const accepted = ['- GHSA-aaaa-bbbb-cccc: pds/leaf@1.0.0, local-and-approved-peer, expires 2026-12-10. See docs/security.md for the decision and evidence.'];
  const withDisclosure = runBlock(prepare, true, { accepted });
  assert.equal(withDisclosure.status, 0, withDisclosure.stderr);
  assert.ok(withDisclosure.state.releaseNotes.split('\n').includes(accepted[0]));
  const missingDisclosure = runBlock(publish, true, { accepted });
  assert.notEqual(missingDisclosure.status, 0);
  assert.equal(missingDisclosure.state.mutations, 0);
  const disclosed = runBlock(publish, true, { accepted, releaseNotes: withDisclosure.state.releaseNotes });
  assert.equal(disclosed.status, 0, disclosed.stderr);
  assert.equal(disclosed.state.mutations, 1);
  const changedLatest = runBlock(publish, true, { changedStableLatest: true });
  assert.notEqual(changedLatest.status, 0, 'peer stable-latest readback must detect an unexpected change');
  console.log('ok - extracted stable/peer prepare and publish blocks; wrong source/target/digest/channel/draft blocked before mutation');

  // Re-run the exact validation gate invocation with a controlled checker. The
  // source DAG above requires this fresh job result before the publication job.
  const validationHome = path.join(scratch, 'validation'); mkdirSync(validationHome); mkdirSync(path.join(validationHome, 'bin'));
  const check = path.join(validationHome, 'bin/check-advisories.sh');
  writeFileSync(check, '#!/bin/bash\ncat "$GATE_REPORT"\n[ "$FINDING_STATE" = green ]\n', { mode: 0o700 });
  const gateReport = path.join(validationHome, 'gate.json'), gateOutput = path.join(validationHome, 'gate-output');
  const approved = {
    status: 'passed', blockers: [], exposure: 'local-and-approved-peer',
    decisions: [{ advisory: 'GHSA-aaaa-bbbb-cccc', workspace: 'pds', package: 'leaf', version: '1.0.0',
      expiresOn: '2026-12-10', upstreamAcceptance: {} }],
  };
  function gate(finding, report = approved) {
    writeFileSync(gateReport, JSON.stringify(report)); writeFileSync(gateOutput, '');
    return spawnSync('/bin/bash', ['-euc', dispositions], { cwd: validationHome, encoding: 'utf8', timeout: 5000,
      env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, GITHUB_WORKSPACE: validationHome,
        GATE_REPORT: gateReport, GITHUB_OUTPUT: gateOutput, RUNNER_TEMP: validationHome, FINDING_STATE: finding } }).status;
  }
  assert.equal(gate('green'), 0, 'prepare-time green');
  assert.equal(readFileSync(gateOutput, 'utf8'), 'accepted_upstream=' + JSON.stringify(accepted) + '\n');
  assert.notEqual(gate('changed-advisory'), 0, 'publish-time disclosure requires a new passing gate');
  assert.equal(readFileSync(gateOutput, 'utf8'), '');
  assert.notEqual(gate('green', { ...approved, blockers: ['unresolved fixture'] }), 0);
  console.log('ok - green preparation cannot authorize publication after a new blocking advisory');

  for (const [paths, expected] of [['README.md\n', 'false'], ['LICENSE\n', 'false'], ['docs/guide.md\n', 'false'],
    ['docs/nested/guide.md\n', 'false'], ['specs/other-feature.md\n', 'false'], ['pds/package-lock.json\n', 'true'],
    ['.github/workflows/release.yml\n', 'true'], ['docs/security.md\n', 'true'],
    ['specs/security-release-and-continuous-checks.md\n', 'true'], ['services/new-service.plist.template\n', 'true'],
    ['lexicons/new-schema.json\n', 'true'], ['new-root-runtime-config.json\n', 'true'],
    ['pds/package-lock.json\n' + 'unrelated/readme.txt\n'.repeat(30000), 'true']]) {
    const result = runBlock(relevance, false, { paths });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(path.join(result.directory, 'output'), 'utf8').trim(), `relevant=${expected}`);
  }
  console.log('ok - extracted PR relevance shell handles noop, sensitive paths and a large diff');
  console.log('PASS: safe extracted-workflow fixtures; no hosted execution, GitHub settings or release mutation');
} finally { rmSync(scratch, { recursive: true, force: true }); }
