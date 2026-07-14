// JSON-RPC client for a codex `app-server`, spoken over a websocket-framed unix
// socket (`ws+unix://PATH:/`). This is the launcher's control channel: it opens
// the connection, runs the initialize handshake, starts/resumes the thread, and
// injects notification turns via turn/start. It also tracks active-turn status
// from the app-server's own turn lifecycle events so the sink can enqueue while
// a turn (ours or the operator's) is running.
//
// Two things the live handshake against codex-cli 0.144.3 taught us, both load-
// bearing (see specs/notification-codex.md, Transport):
//   1. The client MUST disable permessage-deflate — the app-server rejects the
//      extension offer and hangs up the socket ("socket hang up") otherwise.
//   2. Wire messages are JSON-RPC 2.0 with the "jsonrpc" field OMITTED.

import WebSocket from 'ws'
import {
  SERVER_OVERLOADED,
  type InitializeParams,
  type RpcResponse,
  type ThreadStartParams,
  type ThreadStartResponse,
  type TurnEvent,
  type TurnStartParams,
} from './appServerTypes.js'

const CLIENT_INFO = {
  name: 'ait-protocol',
  title: 'AIT codex-mode launcher',
  version: '0.0.1',
}

// turn/start backoff on SERVER_OVERLOADED (-32001). Never a drop — always retry.
const OVERLOAD_MAX_RETRIES = 6
const OVERLOAD_BASE_DELAY_MS = 200

interface Pending {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
}

export class AppServerClient {
  private ws: WebSocket | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  // Threads with a turn currently running (from turn/started .. turn/completed).
  // A thread runs one turn at a time, so membership = "busy".
  private readonly activeThreads = new Set<string>()
  private readonly turnCompletedListeners: Array<(threadId: string) => void> = []
  private readonly closeListeners: Array<(err?: Error) => void> = []
  private closed = false

  constructor(private readonly socketPath: string) {}

  // Open the socket and run the initialize handshake. Resolves once the server
  // has acknowledged `initialize` and we've sent the `initialized` notification.
  async connect(): Promise<void> {
    // Collapse repeated slashes (e.g. a $TMPDIR ending in '/') so the ws+unix
    // parser splits the socket path from the request path on the ':' correctly.
    const path = this.socketPath.replace(/\/{2,}/g, '/')
    const ws = new WebSocket(`ws+unix://${path}:/`, { perMessageDeflate: false })
    this.ws = ws

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve() }
      const onError = (err: Error) => { cleanup(); reject(err) }
      const onUnexpected = (_req: unknown, res: { statusCode?: number }) => {
        cleanup()
        reject(new Error(`app-server handshake HTTP ${res.statusCode}`))
      }
      const cleanup = () => {
        ws.off('open', onOpen)
        ws.off('error', onError)
        ws.off('unexpected-response', onUnexpected)
      }
      ws.on('open', onOpen)
      ws.on('error', onError)
      ws.on('unexpected-response', onUnexpected)
    })

    ws.on('message', (data) => this.onMessage(data))
    ws.on('close', () => this.handleClose())
    ws.on('error', (err) => this.handleClose(err))

    const params: InitializeParams = {
      clientInfo: CLIENT_INFO,
      capabilities: { experimentalApi: true, requestAttestation: false },
    }
    await this.request('initialize', params)
    this.notify('initialized')
  }

  async threadStart(params: ThreadStartParams = {}): Promise<ThreadStartResponse> {
    return (await this.request('thread/start', params)) as ThreadStartResponse
  }

  // Inject a plain-text user turn. Returns once the app-server accepts the turn
  // (the JSON-RPC response); the turn itself runs asynchronously, surfacing via
  // the turn/started .. turn/completed events. Retries -32001 with backoff.
  async turnStart(threadId: string, text: string): Promise<void> {
    const params: TurnStartParams = {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await this.request('turn/start', params)
        return
      } catch (err) {
        if (!isOverloaded(err) || attempt >= OVERLOAD_MAX_RETRIES) throw err
        await delay(backoffMs(attempt))
      }
    }
  }

  isTurnActive(threadId: string): boolean {
    return this.activeThreads.has(threadId)
  }

  onTurnCompleted(listener: (threadId: string) => void): void {
    this.turnCompletedListeners.push(listener)
  }

  onClose(listener: (err?: Error) => void): void {
    this.closeListeners.push(listener)
  }

  close(): void {
    this.ws?.close()
  }

  // --- internals --------------------------------------------------------------

  // Fired once when the socket closes or errors: fail every in-flight request
  // and notify close listeners (the supervisor uses this to respawn + reconnect).
  private handleClose(err?: Error): void {
    if (this.closed) return
    this.closed = true
    const reason = err ?? new Error('app-server connection closed')
    for (const [, p] of this.pending) p.reject(reason)
    this.pending.clear()
    for (const listener of this.closeListeners) listener(err)
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    if (!this.ws || this.closed) {
      return Promise.reject(new Error(`app-server not connected (${method})`))
    }
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send(params === undefined ? { method, id } : { method, id, params })
    })
  }

  private notify(method: string, params?: unknown): void {
    this.send(params === undefined ? { method } : { method, params })
  }

  private send(msg: Record<string, unknown>): void {
    this.ws?.send(JSON.stringify(msg))
  }

  private onMessage(data: WebSocket.RawData): void {
    let msg: {
      id?: number
      method?: string
      params?: unknown
      result?: unknown
      error?: RpcResponse['error']
    }
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return // ignore non-JSON frames
    }

    // Response to one of our requests: has an id, no method.
    if (msg.id != null && msg.method === undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message))
      else p.resolve(msg.result)
      return
    }

    // A message with a method is server-initiated: a request (has id, e.g. an
    // approval / elicitation / currentTime) or a notification (no id). We MUST
    // answer every request — with no operator at the keyboard, an unanswered
    // request wedges the turn forever (verified: a turn sat idle at 0% CPU until
    // its currentTime/read was answered). Notifications drive active-turn tracking.
    if (typeof msg.method === 'string') {
      if (msg.id != null) this.handleServerRequest(msg.method, msg.id)
      else this.onNotification(msg.method, msg.params)
    }
  }

  private onNotification(method: string, params: unknown): void {
    if (method === 'turn/started') {
      const threadId = (params as TurnEvent)?.threadId
      if (threadId) this.activeThreads.add(threadId)
    } else if (method === 'turn/completed') {
      const threadId = (params as TurnEvent)?.threadId
      if (threadId) {
        this.activeThreads.delete(threadId)
        for (const listener of this.turnCompletedListeners) listener(threadId)
      }
    }
    // All other notifications (thread/*, item/* deltas, token usage, …) are
    // not needed by the launcher and are intentionally ignored.
  }

  // Answer a server→client request. The launcher is autonomous (no operator
  // answering prompts), so the policy is:
  //   - supply the clock (currentTime/read);
  //   - ACCEPT MCP elicitations — codex gates each MCP tool call through one, and
  //     a pushed session's whole job is to act through its AIT tools (join, reply,
  //     post). Declining rejects the tool call (verified: a declined elicitation
  //     surfaced as "the AIT join call was rejected"). Safe because the only MCP
  //     server wired in codex mode is ait; if an operator adds their own servers,
  //     revisit (an attached `codex --remote` TUI can answer instead).
  //   - DENY command / file / patch execution — no unattended shell in the
  //     operator's tree; the model acts through tools, not the sandbox.
  // Anything unmodeled gets a JSON-RPC error, which still unblocks the turn.
  private handleServerRequest(method: string, id: number): void {
    switch (method) {
      case 'currentTime/read':
        this.respond(id, { currentTimeAt: Math.floor(Date.now() / 1000) })
        return
      case 'mcpServer/elicitation/request':
        this.respond(id, { action: 'accept', content: {} })
        return
      case 'execCommandApproval':
      case 'applyPatchApproval':
        console.error(`app-server ${method} → auto-denied (autonomous launcher)`)
        this.respond(id, { decision: 'denied' })
        return
      default:
        console.error(`app-server request '${method}' unmodeled — replying error`)
        this.respondError(id, -32601, `client does not handle ${method}`)
    }
  }

  private respond(id: number, result: unknown): void {
    this.send({ id, result })
  }

  private respondError(id: number, code: number, message: string): void {
    this.send({ id, error: { code, message } })
  }
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(`app-server RPC error ${code}: ${message}`)
    this.name = 'RpcError'
  }
}

function isOverloaded(err: unknown): boolean {
  return err instanceof RpcError && err.code === SERVER_OVERLOADED
}

function backoffMs(attempt: number): number {
  // Exponential backoff with full jitter.
  const ceiling = OVERLOAD_BASE_DELAY_MS * 2 ** attempt
  return Math.round(Math.random() * ceiling)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
