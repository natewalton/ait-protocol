// Public ws stream backpressure: one queued frame, not the upstream client's
// default sixteen 100MiB frames. Framing, compression and socket I/O remain ws.
import { WebSocket, createWebSocketStream } from 'ws'
import { setTimeout as delay } from 'node:timers/promises'
import { INPUT_BOUNDS } from './inputBounds.mjs'

const NETWORK_ERRORS = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'ECANCELED'])
export async function* boundedStream({ getUrl, signal, agent, finishRequest }) {
  let reconnect = 0
  while (!signal.aborted) {
    let socket, stream, heartbeat, abnormal = false
    try {
      socket = new WebSocket(await getUrl(), { agent, finishRequest,
        maxPayload: INPUT_BOUNDS.bytes })
      socket.once('close', code => { abnormal = code === 1006 })
      socket.once('open', () => {
        reconnect = 0
        let alive = true
        socket.on('pong', () => { alive = true })
        heartbeat = setInterval(() => {
          // Backpressure intentionally pauses reads, including pong control
          // frames. Resume liveness checks after the consumer drains again.
          if (socket.isPaused) { alive = true; return }
          if (!alive) { socket.terminate(); return }
          alive = false; socket.ping()
        }, 10_000)
      })
      stream = createWebSocketStream(socket, { signal, readableObjectMode: true, highWaterMark: 1 })
      for await (const chunk of stream) yield chunk
      if (!abnormal) return
    } catch (error) {
      if (signal.aborted) return
      const reason = error?.code === 'ABORT_ERR' ? error.cause : error
      if (!NETWORK_ERRORS.has(reason?.code)) throw error
    } finally {
      clearInterval(heartbeat)
      stream?.destroy()
      socket?.terminate()
    }
    if (signal.aborted) return
    await delay(Math.min(1000 * 2 ** reconnect++, 64_000), undefined, { signal }).catch(error => {
      if (!signal.aborted) throw error
    })
  }
}
