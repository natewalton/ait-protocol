// Minimal typed surface for the codex `app-server` JSON-RPC protocol — only the
// messages the codex-mode launcher actually sends/receives. This is a hand-picked
// subset of the full protocol, which the binary itself can emit:
//
//   codex app-server generate-ts --experimental --out <dir>
//
// Regenerate and re-reconcile these shapes on a codex-cli bump (the surface is
// version-specific by design; the thread and turn shapes were verified against
// 0.144.3, the turn/steer shapes against 0.146.0, and history/MCP readiness
// against 0.152.0). Vendoring all ~576 generated files would bury the handful
// we use, so we mirror just those.

// --- initialize ---------------------------------------------------------------

export interface ClientInfo {
  name: string
  title?: string | null
  version: string
}

export interface InitializeCapabilities {
  experimentalApi: boolean
  requestAttestation: boolean
  // Notification method names to suppress for this connection (e.g. the
  // per-token streaming deltas we never read). Omit to receive everything.
  optOutNotificationMethods?: string[] | null
}

export interface InitializeParams {
  clientInfo: ClientInfo
  capabilities: InitializeCapabilities | null
}

// --- thread lifecycle ---------------------------------------------------------

// codex-cli 0.144.3: "untrusted" | "on-request" | { granular: {...} } | "never".
// The launcher only uses the string variants.
export type AskForApproval = 'untrusted' | 'on-request' | 'never'
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type ThreadHistoryMode = 'legacy' | 'paginated'

export interface ThreadStartParams {
  cwd?: string | null
  approvalPolicy?: AskForApproval | null
  sandbox?: SandboxMode | null
  model?: string | null
  historyMode?: ThreadHistoryMode | null
  // All fields optional; app-server generates the threadId (no client-supplied id).
}

// thread/start/resume return the full thread object. The rollout regression also
// inspects the history mode and path returned by the installed app-server.
export interface ThreadStartResponse {
  thread: {
    id: string
    historyMode?: ThreadHistoryMode
    path?: string | null
  }
  model?: string
  modelProvider?: string
}

// thread/resume is keyed by threadId (UUID) — there is no resume-by-name in
// 0.144.3 (thread/list only exposes a title `searchTerm`). Used by the resume
// path to re-open a thread while the launcher rebinds its original AIT handle.
export interface ThreadResumeParams {
  threadId: string
  cwd?: string | null
  approvalPolicy?: AskForApproval | null
  sandbox?: SandboxMode | null
}

// thread/name/set — sets a thread's display name (what the TUI picker shows).
// The param is `name` (verified live) — not `title`, the term the picker UI uses.
export interface ThreadNameSetParams {
  threadId: string
  name: string
}

// --- MCP runtime readiness ----------------------------------------------------

// mcpServerStatus/list plus mcpServer/startupStatus/updated. The launcher uses
// the snapshot to identify only runtimes which are genuinely still starting,
// then waits for their terminal app-server events before exposing the thread to
// a remote TUI. No elapsed-time heuristic participates in this state decision.
export type McpServerConnectionStatus =
  | 'notStarted'
  | 'starting'
  | 'connected'
  | 'authenticationRequired'
  | 'failed'
  | 'cancelled'
  | 'disabled'

export type McpServerStartupState = 'starting' | 'ready' | 'failed' | 'cancelled'

export interface ListMcpServerStatusParams {
  threadId: string
  cursor?: string | null
  limit?: number | null
  detail?: 'full' | 'toolsAndAuthOnly' | null
}

export interface ListMcpServerStatusResponse {
  data: Array<{
    name: string
    runtimeStatus?: McpServerConnectionStatus | null
  }>
  nextCursor?: string | null
}

export interface McpServerStatusUpdatedEvent {
  threadId?: string | null
  name: string
  status: McpServerStartupState
}

// --- turns --------------------------------------------------------------------

// The only UserInput variant we inject: a plain-text user message. `text_elements`
// is a required (possibly empty) array of UI spans in the wire type.
export interface UserInputText {
  type: 'text'
  text: string
  text_elements: []
}

export interface TurnStartParams {
  threadId: string
  input: UserInputText[]
}

export interface TurnStartResponse {
  turn: { id: string }
}

// turn/steer appends user input to a turn that is ALREADY RUNNING, instead of
// waiting for it to finish. `expectedTurnId` is a precondition: the app-server
// rejects the call when it is not the currently active turn, so a stale id can
// never append to the wrong turn. Review and compact turns refuse steering
// outright (the protocol's NonSteerableTurnKind), so callers need a fallback.
export interface TurnSteerParams {
  threadId: string
  expectedTurnId: string
  input: UserInputText[]
}

export interface TurnSteerResponse {
  turnId: string
}

// turn/started and turn/completed both carry { threadId, turn }. We only read
// the threadId (to scope active-turn tracking) and the completed turn's status.
export interface TurnEvent {
  threadId: string
  turn?: { id?: string; status?: string }
}

export interface ThreadStartedEvent {
  threadId: string
}

// --- JSON-RPC framing ---------------------------------------------------------
// Wire format is JSON-RPC 2.0 with the "jsonrpc" field OMITTED (verified). A
// message with an `id` and no `method` is a response; with a `method` and no
// `id` it is a server notification.

export interface RpcResponse {
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface RpcNotification {
  method: string
  params?: unknown
}

// Backpressure: app-server returns this JSON-RPC error code when overloaded.
// Callers retry (it is never a drop), never surface it as a hard failure.
export const SERVER_OVERLOADED = -32001
