import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomBytes, X509Certificate } from 'node:crypto'
import { SecretKey } from '@number0/iroh'
import { base32 } from 'multiformats/bases/base32'

export function writePrivate(file, value) {
  const temporary = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, file)
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
}

export function loadState(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  assert(!fs.lstatSync(directory).isSymbolicLink(), 'peer state must not be a symlink')
  fs.chmodSync(directory, 0o700)
  const file = path.join(directory, 'machine.json')
  const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) :
    { secret: randomBytes(32).toString('hex'), peers: {} }
  assert.match(state.secret, /^[a-f0-9]{64}$/)
  const id = SecretKey.fromBytes([...Buffer.from(state.secret, 'hex')]).public()
  const hostname = `${base32.baseEncode(Uint8Array.from(id.toBytes()))}.localhost`
  const save = () => writePrivate(file, JSON.stringify(state, null, 2) + '\n')
  if (!fs.existsSync(file)) save()
  const ca = path.join(directory, 'ca.pem'), key = path.join(directory, 'tls.key')
  const cert = path.join(directory, 'tls.pem')
  // Complete an interrupted first creation without replacing an existing CA.
  if (!fs.existsSync(ca)) {
    const config = path.join(directory, 'ca.cnf')
    writePrivate(config, `[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=AIT private machine CA\n[ca]\nbasicConstraints=critical,CA:true,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nnameConstraints=critical,permitted;DNS:${hostname}\n`)
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
      '-keyout', path.join(directory, 'ca.key'), '-out', ca, '-config', config], { stdio: 'pipe' })
  }
  if (!fs.existsSync(cert)) {
    const csr = path.join(directory, 'tls.csr'), ext = path.join(directory, 'tls.ext')
    writePrivate(ext, `basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${hostname}\n`)
    execFileSync('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${hostname}`,
      '-keyout', key, '-out', csr], { stdio: 'pipe' })
    execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', path.join(directory, 'ca.key'),
      '-set_serial', '1', '-days', '3650', '-extfile', ext, '-out', cert], { stdio: 'pipe' })
  }
  assert.equal(new X509Certificate(fs.readFileSync(cert)).checkHost(hostname), hostname,
    'TLS identity and machine key disagree; restore matching peer state before updating')
  for (const name of fs.readdirSync(directory)) {
    const target = path.join(directory, name)
    if (fs.lstatSync(target).isFile()) fs.chmodSync(target, 0o600)
  }
  return { state, id: id.toString(), hostname, save,
    ca: fs.readFileSync(ca, 'utf8'), cert: fs.readFileSync(cert), key: fs.readFileSync(key) }
}
