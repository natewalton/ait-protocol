// JSON-RPC client for a codex `app-server`, spoken over a websocket-framed unix
// socket (`ws+unix://PATH:/`). This is the launcher's control channel: it opens
// the connection, runs the initialize handshake, starts/resumes the thread, and
// delivers notifications — turn/start when the thread is idle, turn/steer to
// join a turn already running. It tracks the running turn's id from the
// app-server's own lifecycle events, which is what turn/steer needs as its
// precondition.
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
  type ThreadResumeParams,
  type ThreadNameSetParams,
  type ListMcpServerStatusParams,
  type ListMcpServerStatusResponse,
  type McpServerStatusUpdatedEvent,
  type TurnEvent,
  type TurnStartParams,
  type TurnStartResponse,
  type TurnSteerParams,
  type TurnSteerResponse,
} from './appServerTypes.js'

const CLIENT_INFO = {
  name: 'ait-protocol',
  title: 'AIT codex-mode launcher',
  version: '0.0.1',
}

// turn/start backoff on SERVER_OVERLOADED (-32001). Never a drop — always retry.
const OVERLOAD_MAX_RETRIES = 6
const OVERLOAD_BASE_DELAY_MS = 200
// `ws` defaults to 100 MiB for incoming messages. A large `thread/resume`
// response can legitimately exceed that when recovering a long-lived Codex
// session. Keep a high bounded default for the local unix-socket transport,
// while allowing recovery of unusually large histories without a code change.
const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024 * 1024

export function codexMaxPayloadBytes(): number {
  const raw = process.env.AIT_CODEX_MAX_PAYLOAD_BYTES
  if (raw === undefined || raw === '') return DEFAULT_MAX_PAYLOAD_BYTES

  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `AIT_CODEX_MAX_PAYLOAD_BYTES must be a non-negative integer (got ${raw})`,
    )
  }
  // ws treats zero as unlimited. This is useful as a last-resort recovery
  // switch for a trusted local unix socket, but is deliberately opt-in.
  return value
}

interface Pending {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
}

export class AppServerClient {
  private ws: WebSocket | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  // threadId → the id of the turn currently running on it (from turn/started ..
  // turn/completed). A thread runs one turn at a time, so presence = "busy".
  // The id is kept, not just the fact of being busy, because turn/steer needs it
  // as its expectedTurnId precondition.
  private readonly activeTurns = new Map<string, string>()
  private readonly turnCompletedListeners: Array<(event: TurnEvent) => void> = []
  private readonly mcpStatusListeners = new Set<(event: McpServerStatusUpdatedEvent) => void>()
  private readonly closeListeners = new Set<(err?: Error) => void>()
  private closed = false

  constructor(private readonly socketPath: string) {}

  // Open the socket and run the initialize handshake. Resolves once the server
  // has acknowledged `initialize` and we've sent the `initialized` notification.
  async connect(): Promise<void> {
    // Collapse repeated slashes (e.g. a $TMPDIR ending in '/') so the ws+unix
    // parser splits the socket path from the request path on the ':' correctly.
    const path = this.socketPath.replace(/\/{2,}/g, '/')
    const ws = new WebSocket(`ws+unix://${path}:/`, {
      perMessageDeflate: false,
      maxPayload: codexMaxPayloadBytes(),
    })
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

  // Re-open an existing thread by id (the resume path). Returns the same
  // ThreadStartResponse shape (thread object + model/provider).
  async threadResume(params: ThreadResumeParams): Promise<ThreadStartResponse> {
    return (await this.request('thread/resume', params)) as ThreadStartResponse
  }

  // Inject a plain-text user turn. Returns once the app-server accepts the turn
  // (the JSON-RPC response); the turn itself runs asynchronously, surfacing via
  // the turn/started .. turn/completed events. Retries -32001 with backoff.
  async turnStart(threadId: string, text: string): Promise<string> {
    const params: TurnStartParams = {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const response = (await this.request(
          'turn/start',
          params,
        )) as TurnStartResponse
        const turnId = response.turn?.id
        if (!turnId) throw new Error('turn/start response missing turn.id')
        return turnId
      } catch (err) {
        if (!isOverloaded(err) || attempt >= OVERLOAD_MAX_RETRIES) throw err
        await delay(backoffMs(attempt))
      }
    }
  }

  // Name a thread — the title the TUI's thread picker shows. On an explicitly
  // legacy thread this is also the smallest write that persists the one-record
  // rollout `codex resume` needs, with no turn context and no model turn.
  async setName(threadId: string, name: string): Promise<void> {
    const params: ThreadNameSetParams = { threadId, name }
    await this.request('thread/name/set', params)
  }

  // Do not expose a just-started or cold-resumed thread to the remote TUI while
  // its MCP runtime is still emitting startup notifications. A TUI which joins
  // in the middle can observe only part of that round and retain a phantom
  // running indicator even though the thread itself is idle.
  //
  // Readiness is protocol-driven, never elapsed-time-driven: take the server's
  // status snapshot, then wait without a deadline for terminal status events
  // for exactly the runtimes reported as notStarted/starting. The connection
  // closing rejects the wait and lets the host's reconnect supervisor retry.
  // Returns the initially pending names so production validation can distinguish
  // an exercised gate from an already-settled no-op.
  async waitForMcpStartup(threadId: string): Promise<string[]> {
    const observed = new Map<string, McpServerStatusUpdatedEvent['status']>()
    let wake: (() => void) | null = null
    let closedReason: Error | null = null
    const statusListener = (event: McpServerStatusUpdatedEvent) => {
      if (event.threadId !== threadId) return
      observed.set(event.name, event.status)
      wake?.()
      wake = null
    }
    const closeListener = (err?: Error) => {
      closedReason = err ?? new Error('app-server connection closed during MCP startup')
      wake?.()
      wake = null
    }
    this.mcpStatusListeners.add(statusListener)
    this.closeListeners.add(closeListener)

    try {
      const pending = new Set<string>()
      let cursor: string | null = null
      do {
        const params: ListMcpServerStatusParams = {
          threadId,
          cursor,
          limit: 100,
          detail: 'toolsAndAuthOnly',
        }
        let response: ListMcpServerStatusResponse
        try {
          response = (await this.request(
            'mcpServerStatus/list',
            params,
          )) as ListMcpServerStatusResponse
        } catch (err) {
          // Older supported Codex app-servers do not expose the readiness API.
          // Their explicit -32601 capability response is the only fallback
          // signal; never substitute a delay or retry budget.
          if (err instanceof RpcError && err.code === -32601) return []
          throw err
        }
        for (const status of response.data) {
          if (status.runtimeStatus === 'notStarted' || status.runtimeStatus === 'starting') {
            pending.add(status.name)
          }
        }
        cursor = response.nextCursor ?? null
      } while (cursor)

      const initiallyPending = [...pending].sort()
      for (;;) {
        for (const name of pending) {
          const status = observed.get(name)
          if (status === 'ready' || status === 'failed' || status === 'cancelled') {
            pending.delete(name)
          }
        }
        if (pending.size === 0) return initiallyPending
        if (closedReason) throw closedReason
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      this.mcpStatusListeners.delete(statusListener)
      this.closeListeners.delete(closeListener)
    }
  }

  // Append input to the turn already running on this thread, so the model reads
  // it during that turn instead of after it. Same overload backoff as turnStart.
  // Throws when `expectedTurnId` is no longer the active turn, or when the turn
  // is one that refuses steering (review, compact) — callers fall back to
  // starting a fresh turn rather than treating either as a drop.
  async turnSteer(
    threadId: string,
    expectedTurnId: string,
    text: string,
  ): Promise<string> {
    const params: TurnSteerParams = {
      threadId,
      expectedTurnId,
      input: [{ type: 'text', text, text_elements: [] }],
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const response = (await this.request(
          'turn/steer',
          params,
        )) as TurnSteerResponse
        if (!response.turnId) throw new Error('turn/steer response missing turnId')
        return response.turnId
      } catch (err) {
        if (!isOverloaded(err) || attempt >= OVERLOAD_MAX_RETRIES) throw err
        await delay(backoffMs(attempt))
      }
    }
  }

  // The running turn's id, or null when the thread is idle. Only turns THIS
  // client started are tracked: turn notifications route to the initiator, so an
  // attached TUI's own turns are invisible here and cannot be steered.
  activeTurnId(threadId: string): string | null {
    return this.activeTurns.get(threadId) ?? null
  }

  onTurnCompleted(listener: (event: TurnEvent) => void): void {
    this.turnCompletedListeners.push(listener)
  }

  onClose(listener: (err?: Error) => void): void {
    this.closeListeners.add(listener)
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
      const event = params as TurnEvent
      const turnId = event?.turn?.id
      if (event?.threadId && turnId) this.activeTurns.set(event.threadId, turnId)
    } else if (method === 'turn/completed') {
      const threadId = (params as TurnEvent)?.threadId
      if (threadId) {
        this.activeTurns.delete(threadId)
        const event = params as TurnEvent
        for (const listener of this.turnCompletedListeners) listener(event)
      }
    } else if (method === 'mcpServer/startupStatus/updated') {
      const event = params as McpServerStatusUpdatedEvent
      if (typeof event?.name === 'string' && typeof event?.status === 'string') {
        for (const listener of this.mcpStatusListeners) listener(event)
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
  //     surfaced as "the AIT join call was rejected"). Server→client requests
  //     route to the client that STARTED the turn (verified — a 2nd attached
  //     client sees none), so we only ever answer requests for turns WE injected;
  //     an operator TUI's own turns are answered by the TUI. Blanket-accept is
  //     therefore multi-client-safe.
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
