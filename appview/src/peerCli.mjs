import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { parseInvitation, sharingScope } from './peerNetwork.mjs'
import { installationPaths } from './peerPrepare.mjs'

export function localCommand(socketPath, operation, body = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: `/${operation}`, method: 'POST',
      headers: { 'content-type': 'application/json' } }, response => {
      const chunks = []
      response.on('data', value => chunks.push(value)); response.on('error', reject)
      response.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString())
          response.statusCode === 200 ? resolve(result) : reject(Error(result.error))
        } catch (error) { reject(error) }
      })
    })
    request.on('error', reject); request.end(JSON.stringify(body))
  })
}
async function main() {
  const [operation, repo, value] = process.argv.slice(2)
  const { directory } = installationPaths(repo), control = path.join(directory, 'control.sock')
  if (operation === 'unlink') {
    if (!value) throw Error('use ait unlink <full machine key>')
    console.log(JSON.stringify(await localCommand(control, 'unlink', { id: value }))); return
  }
  if (operation !== 'link') throw Error('expected link or unlink')
  console.log(sharingScope)
  console.log('Direct connections only; no relay fallback. A stolen invitation can enroll its first redeemer.')
  if (value) {
    const invitation = parseInvitation(value)
    console.log(`Machine: ${JSON.stringify(invitation.name)}\nKey: ${invitation.address.id().toString()}`)
    const prompt = createInterface({ input: process.stdin, output: process.stdout })
    let answer
    try { answer = await prompt.question('Link this computer? [y/N] ') }
    finally { prompt.close() }
    if (!/^y(es)?$/i.test(answer.trim())) { console.log('Not linked'); return }
    console.log(JSON.stringify(await localCommand(control, 'link', { invitation: value })))
  } else {
    const status = await localCommand(control, 'status')
    for (const peer of status.peers) console.log(`${peer.state} ${JSON.stringify(peer.name)} ${peer.id}`)
    const result = await localCommand(control, 'invite')
    console.log('Send this one-use invitation privately (expires in 10 minutes; the next ait link replaces it):')
    console.log(result.invitation)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main().catch(error => { console.error(`Link failed: ${error.message}. Check ait status; no relay will be used.`); process.exitCode = 1 })
}
