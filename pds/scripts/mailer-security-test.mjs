// Real PDS HTTP handlers, account/token database and installed HTML-to-text plugin.
// Accounts are seeded through AccountManager: PLC registration is outside this test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.argv.includes('--fixture-child')) {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Run with Node 24+');
  const home = await mkdtemp(path.join(tmpdir(), 'ait-mailer-test-'));
  try {
    const child = spawnSync(process.execPath, ['--max-old-space-size=256', fileURLToPath(import.meta.url), '--fixture-child', home], {
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, LOG_ENABLED: 'false', NODE_ENV: 'test' },
      encoding: 'utf8', timeout: 90000, maxBuffer: 1024 * 1024,
    });
    process.stdout.write(child.stdout || '');
    process.stderr.write(child.stderr || '');
    assert.ifError(child.error);
    assert.equal(child.status, 0, `mailer fixture exited ${child.status}, signal ${child.signal}`);
  } finally { await rm(home, { recursive: true, force: true }); }
} else {
  await runFixture(process.argv.at(-1));
}

async function runFixture(home) {
  process.umask(0o077);
  const require = createRequire(import.meta.url);
  assert.equal(require('nodemailer/package.json').version, '10.5.0');
  assert.equal(require('@atproto/pds/package.json').version, '0.4.226');

  // No installed .env is read. Restrict even accidental dependency connections
  // to this fixture's explicitly registered ephemeral listeners.
  const ports = new Set();
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const opts = typeof first === 'object' ? first : { port: first, host: args[1] };
    assert.equal(opts.host ?? 'localhost', '127.0.0.1', 'fixture attempted non-loopback connection');
    assert.ok(ports.has(Number(opts.port)), `fixture attempted unowned port ${opts.port}`);
    return originalConnect.apply(this, args);
  };
  const { PDS, envToCfg, envToSecrets } = await import('@atproto/pds');
  const { cidForRawHash } = await import('@atproto/lex-data');
  const addressparser = require('nodemailer/lib/addressparser');
  const did = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
  const email = 'fixture@example.test';
  const password = 'Fixture-password-123456';
  let checks = 0;
  function checked(label) { checks++; console.log(`ok ${checks} - ${label}`); }
  async function listen(server) {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = server.address().port;
    assert.ok(![2582, 2583, 2585].includes(port)); ports.add(port); return port;
  }
  async function close(server) { await new Promise(resolve => server.close(resolve)); }

  const smtpMessages = [];
  const smtpSockets = new Set();
  const smtp = net.createServer(socket => {
    smtpSockets.add(socket); socket.on('close', () => smtpSockets.delete(socket));
    socket.write('220 fixture SMTP\r\n');
    let buffer = '', data = null, recipients = [];
    socket.on('data', chunk => {
      buffer += chunk.toString();
      while (buffer.includes('\r\n')) {
        const index = buffer.indexOf('\r\n');
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        if (data !== null) {
          if (line === '.') { smtpMessages.push({ recipients, wire: data.join('\r\n') }); data = null; recipients = []; socket.write('250 captured\r\n'); }
          else data.push(line.replace(/^\.\./, '.'));
        } else if (/^EHLO|^HELO/.test(line)) socket.write('250-fixture\r\n250 8BITMIME\r\n');
        else if (/^MAIL FROM:/.test(line)) socket.write('250 sender\r\n');
        else if (/^RCPT TO:/.test(line)) { recipients.push(line.slice(8)); socket.write('250 recipient\r\n'); }
        else if (line === 'DATA') { data = []; socket.write('354 continue\r\n'); }
        else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  const smtpPort = await listen(smtp);
  let urlRequests = 0;
  const urlSink = http.createServer((_req, res) => { urlRequests++; res.end('must-not-read'); });
  const urlPort = await listen(urlSink);
  const secret = path.join(home, 'secret.txt'); await writeFile(secret, 'FIXTURE_PRIVATE_CONTENT');

  try {
    for (const mode of ['json', 'smtp']) {
      const directory = path.join(home, mode); await mkdir(directory);
      const smtpUrl = `smtp://127.0.0.1:${smtpPort}`;
      const env = {
        port: 0, hostname: 'pds.localhost', serviceDid: 'did:web:pds.localhost',
        dataDirectory: directory, blobstoreDiskLocation: path.join(directory, 'blobs'),
        didPlcUrl: 'http://127.0.0.1:1', serviceHandleDomains: ['.test'],
        inviteRequired: false, rateLimitsEnabled: false, crawlers: [],
        jwtSecret: randomBytes(32).toString('hex'), adminPassword: randomBytes(32).toString('hex'),
        plcRotationKeyK256PrivateKeyHex: randomBytes(32).toString('hex'),
        ...(mode === 'smtp' ? { emailSmtpUrl: smtpUrl, emailFromAddress: 'Fixture <sender@example.test>',
          moderationEmailSmtpUrl: smtpUrl, moderationEmailAddress: 'Moderator <moderator@example.test>' } : {}),
      };
      const pds = await PDS.create(envToCfg(env), envToSecrets(env));
      // Resolving this seeded account is local fixture data, never a PLC call.
      pds.ctx.idResolver.did.resolve = async requested => {
        assert.equal(requested, did); return { id: did, alsoKnownAs: ['at://fixture.test'], service: [] };
      };
      const server = http.createServer(pds.app);
      const port = await listen(server); const origin = `http://127.0.0.1:${port}`;
      const captures = [];
      const deliveries = [];
      const transports = [pds.ctx.mailer.transporter, pds.ctx.moderationMailer.transporter];
      for (const transport of transports) {
        assert.equal(transport.transporter.name, mode === 'json' ? 'JSONTransport' : 'SMTP');
        transport.use('compile', (mail, done) => {
          // This runs AFTER the actual PDS HTML-to-text plugin. A missing/broken
          // legacy resolveContent callback therefore fails the content assertions.
          captures.push({ html: mail.data.html, text: mail.data.text, subject: mail.data.subject }); done();
        });
        const sendMail = transport.sendMail.bind(transport);
        transport.sendMail = async options => {
          const result = await sendMail(options); deliveries.push(result); return result;
        };
      }
      async function rpc(method, body, auth, status = 200) {
        const response = await fetch(`${origin}/xrpc/${method}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { ...(body == null ? {} : { 'content-type': 'application/json' }), ...(auth ? { authorization: auth } : {}) },
          ...(body == null ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
        });
        const text = await response.text();
        assert.equal(response.status, status, `${mode} ${method}: ${text}`);
        return text ? JSON.parse(text) : null;
      }
      async function token(purpose) {
        const row = await pds.ctx.accountManager.db.db.selectFrom('email_token').selectAll()
          .where('did', '=', did).where('purpose', '=', purpose).executeTakeFirstOrThrow();
        const capture = captures.at(-1);
        assert.ok(capture.html.includes(row.token)); assert.ok(capture.text.includes(row.token));
        assert.ok(!/<[^>]+>/.test(capture.text));
        assert.deepEqual(deliveries.at(-1).envelope.to, [email]);
        if (mode === 'json') {
          const message = JSON.parse(deliveries.at(-1).message);
          assert.equal(message.html, capture.html); assert.equal(message.text, capture.text);
          assert.equal(message.subject, capture.subject);
        } else {
          const message = smtpMessages.at(-1);
          assert.deepEqual(message.recipients, [`<${email}>`]);
          assert.match(message.wire, /Content-Type: text\/plain/);
          assert.match(message.wire, /Content-Type: text\/html/);
          assert.ok(message.wire.includes(row.token));
        }
        return row.token;
      }
      try {
        const session = await pds.ctx.accountManager.createAccountAndSession({
          did, handle: 'fixture.test', email, password, repoCid: cidForRawHash(new Uint8Array(32)), repoRev: '3jzfcijpj2z2a',
        });
        const auth = `Bearer ${session.accessJwt}`;
        assert.equal((await rpc('com.atproto.server.getSession', undefined, auth)).did, did);
        await rpc('com.atproto.server.requestEmailConfirmation', null, undefined, 401);
        assert.equal(captures.length, 0, 'unauthenticated mail request composed a message');
        await rpc('com.atproto.server.requestEmailConfirmation', null, auth);
        const confirmToken = await token('confirm_email');
        await rpc('com.atproto.server.confirmEmail', { email, token: 'INVALID-TOKEN' }, auth, 400);
        await rpc('com.atproto.server.confirmEmail', { email, token: confirmToken }, auth);
        assert.equal((await rpc('com.atproto.server.getSession', undefined, auth)).emailConfirmed, true);
        checked(`${mode}: authenticated confirmation email/plugin/token consumption`);

        await rpc('com.atproto.server.requestEmailUpdate', null, auth); await token('update_email');
        await rpc('com.atproto.server.requestAccountDelete', null, auth); await token('delete_account');
        await rpc('com.atproto.identity.requestPlcOperationSignature', null, auth); await token('plc_operation');
        checked(`${mode}: update/delete/PLC token templates reach transport`);

        await rpc('com.atproto.admin.sendEmail', { recipientDid: did, senderDid: did, content: '<p>Fixture Ω &amp; safe <a href="https://example.test/help">help</a></p>', subject: 'Fixture Ω' }, undefined, 401);
        await rpc('com.atproto.admin.sendEmail', { recipientDid: did, senderDid: did, content: '<p>Fixture Ω &amp; safe <a href="https://example.test/help">help</a></p>', subject: 'Fixture Ω' }, `Basic ${Buffer.from(`admin:${env.adminPassword}`).toString('base64')}`);
        assert.match(captures.at(-1).text, /Fixture Ω & safe/); assert.match(captures.at(-1).text, /https:\/\/example.test\/help/);
        checked(`${mode}: moderator authorization and Unicode HTML/text conversion`);

        await rpc('com.atproto.server.requestPasswordReset', { email });
        const resetToken = await token('reset_password');
        const nextPassword = 'Changed-fixture-password-123456';
        await rpc('com.atproto.server.resetPassword', { token: resetToken, password: nextPassword });
        await rpc('com.atproto.server.resetPassword', { token: resetToken, password: nextPassword }, undefined, 400);
        await rpc('com.atproto.server.createSession', { identifier: email, password }, undefined, 401);
        const nextSession = await rpc('com.atproto.server.createSession', { identifier: email, password: nextPassword });
        assert.equal(nextSession.did, did);
        assert.equal((await rpc('com.atproto.server.getSession', undefined, `Bearer ${nextSession.accessJwt}`)).did, did);
        checked(`${mode}: reset token is single-use; old password fails and new session succeeds`);

        for (const content of [{ path: secret }, { href: `http://127.0.0.1:${urlPort}/secret` }]) {
          const options = { from: 'sender@example.test', to: email, disableFileAccess: true, disableUrlAccess: true };
          // JSON transport preserves raw references without reading them; SMTP
          // materializes the raw message and must reject those references.
          if (mode === 'json') {
            const result = await transports[0].sendMail({ ...options, raw: content });
            assert.deepEqual(JSON.parse(result.message).raw, content);
            assert.ok(!result.message.includes('FIXTURE_PRIVATE_CONTENT'));
          } else await assert.rejects(transports[0].sendMail({ ...options, raw: content }), /access|disabled/i);
          // The real HTML conversion plugin resolves html content even for JSON.
          await assert.rejects(transports[0].sendMail({ ...options, html: content }), /access|disabled/i);
        }
        assert.equal(urlRequests, 0);
        const unicode = await transports[0].sendMail({ from: 'sender@example.test', to: 'Fixture Ω <fixture@bücher.example>', subject: 'Unicode', text: 'fixture' });
        assert.deepEqual(unicode.envelope.to, ['fixture@xn--bcher-kva.example']);
        if (mode === 'json') {
          const message = JSON.parse(unicode.message); assert.equal(message.text, 'fixture'); assert.equal(message.subject, 'Unicode');
        }
        checked(`${mode}: raw file/URL restrictions and IDN recipient envelope`);
      } finally {
        for (const transport of transports) transport.close();
        await close(server);
        await pds.ctx.didCache.destroy(); await pds.destroy();
        await pds.ctx.didCache.db.db.destroy(); await pds.ctx.sequencer.db.db.destroy();
      }
    }
    // Advisory shapes exercise the upgraded parser. The parent has a hard
    // timeout/memory cap, and this fixed input/latency budget is not adaptive.
    const parserTimingsMs = [];
    for (const input of ['a@b.example,'.repeat(30000), ' >' + '>[x][x]'.repeat(40000)]) {
      const started = performance.now(); addressparser(input);
      parserTimingsMs.push(Math.round(performance.now() - started));
      assert.ok(parserTimingsMs.at(-1) < 1500, 'address parser exceeded fixed 1.5s budget');
    }
    checked('crafted flat address lists and free-text fallback finish within fixed budget');
    assert.equal(urlRequests, 0);
    console.log(JSON.stringify({ result: 'PASS', pds: '0.4.226', nodemailer: '10.5.0', checks, parserTimingsMs,
      coverage: 'seeded account HTTP mail/token/auth journeys, actual plugin, JSON and SMTP; no PLC registration or external delivery' }));
  } finally {
    for (const socket of smtpSockets) socket.destroy();
    await close(smtp); await close(urlSink);
    net.Socket.prototype.connect = originalConnect;
  }
}
