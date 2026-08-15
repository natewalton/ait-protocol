// Compatibility relay for attaching Codex's TUI to a very large resumed thread.
//
// Codex 0.147.0's remote TUI performs a `thread/read` with `includeTurns: true`
// during session lookup. The app-server returns the entire transcript in one
// websocket message; sufficiently long-lived threads exceed the TUI client's
// receive limit even though the app-server has already resumed them successfully.
//
// This relay is used only after a direct TUI attach fails. It transparently
// forwards the TUI protocol, except that full-history reads for the one target
// thread are changed to metadata-only reads. The app-server's in-memory thread —
// including all model context — is untouched. Only the old transcript is omitted
// from the TUI display; new turns continue to stream normally.
// Upstream: https://github.com/openai/codex/issues/19837#issuecomment-5304695746

import * as fs from 'node:fs'
import * as http from 'node:http'
import { pathToFileURL } from 'node:url'
import WebSocket, { WebSocketServer } from 'ws'
import { codexMaxPayloadBytes } from './appServerClient.js'

interface RewrittenMessage {
  data: WebSocket.RawData
  rewritten: boolean
}

function rawDataBuffer(data: WebSocket.RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  return Buffer.from(data)
}

// Exported so the narrow protocol mutation can be checked without opening
// sockets. Malformed, binary, unrelated, and other-thread messages pass through.
export function omitTargetThreadHistory(
  data: WebSocket.RawData,
  isBinary: boolean,
  targetThreadId: string,
): RewrittenMessage {
  if (isBinary) return { data, rewritten: false }

  try {
    const message = JSON.parse(rawDataBuffer(data).toString('utf8')) as {
      method?: unknown
      params?: { threadId?: unknown; includeTurns?: unknown; [key: string]: unknown }
      [key: string]: unknown
    }
    if (
      message.method !== 'thread/read' ||
      message.params?.threadId !== targetThreadId ||
      message.params.includeTurns !== true
    ) {
      return { data, rewritten: false }
    }

    message.params = { ...message.params, includeTurns: false }
    return { data: Buffer.from(JSON.stringify(message)), rewritten: true }
  } catch {
    return { data, rewritten: false }
  }
}

export interface TuiRelay {
  close: () => Promise<void>
}

export async function startTuiRelay(
  upstreamSocketPath: string,
  listenSocketPath: string,
  targetThreadId: string,
): Promise<TuiRelay> {
  const maxPayload = codexMaxPayloadBytes()
  const server = http.createServer()
  const websocketServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload,
  })
  const clients = new Set<WebSocket>()

  server.on('upgrade', (request, socket, head) => {
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit('connection', websocket, request)
    })
  })

  websocketServer.on('connection', (client) => {
    clients.add(client)
    const upstreamPath = upstreamSocketPath.replace(/\/{2,}/g, '/')
    const upstream = new WebSocket(`ws+unix://${upstreamPath}:/`, {
      perMessageDeflate: false,
      maxPayload,
    })
    const pending: Array<{ data: WebSocket.RawData; isBinary: boolean }> = []
    let warned = false

    client.on('message', (data, isBinary) => {
      const outgoing = omitTargetThreadHistory(data, isBinary, targetThreadId)
      if (outgoing.rewritten && !warned) {
        warned = true
        console.error(
          'ait codex TUI recovery: omitted oversized historical turns from the ' +
            'TUI snapshot; the resumed app-server thread retains its full context',
        )
      }
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(outgoing.data, { binary: isBinary })
      } else {
        pending.push({ data: outgoing.data, isBinary })
      }
    })

    upstream.on('open', () => {
      for (const message of pending.splice(0)) {
        upstream.send(message.data, { binary: message.isBinary })
      }
    })
    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary })
      }
    })

    client.on('close', () => {
      clients.delete(client)
      upstream.close()
    })
    client.on('error', () => upstream.close())
    upstream.on('close', () => client.close())
    upstream.on('error', (error) => {
      console.error(`ait codex TUI recovery: upstream connection failed: ${error.message}`)
      client.close(1011, 'app-server connection failed')
    })
  })

  // The launcher gives every relay a fresh private directory. Refuse to replace
  // anything at the requested path, even a stale socket, so this helper can
  // never unlink an unrelated caller-owned file.
  if (fs.existsSync(listenSocketPath)) {
    throw new Error(`TUI relay socket path already exists: ${listenSocketPath}`)
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(listenSocketPath)
  })

  return {
    close: async () => {
      for (const client of clients) client.close()
      websocketServer.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      try {
        fs.unlinkSync(listenSocketPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    },
  }
}

async function main(): Promise<void> {
  const [upstreamSocketPath, listenSocketPath, targetThreadId] = process.argv.slice(2)
  if (!upstreamSocketPath || !listenSocketPath || !targetThreadId) {
    console.error('usage: tuiRelay.js <upstream-socket> <listen-socket> <thread-id>')
    process.exit(2)
  }

  const relay = await startTuiRelay(upstreamSocketPath, listenSocketPath, targetThreadId)
  const stop = () => {
    void relay.close().finally(() => process.exit(0))
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('ait codex TUI recovery failed:', error)
    process.exit(1)
  })
}
