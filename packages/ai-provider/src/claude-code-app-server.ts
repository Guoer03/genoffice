/**
 * Claude Code provider via the Agent Client Protocol (ACP).
 *
 * Mirrors codex-app-server.ts, but drives the `@zed-industries/claude-agent-acp`
 * adapter (an ACP-compatible agent backed by the Claude Agent SDK, which reuses
 * the local `claude` login from ~/.claude) over the standard ACP JSON-RPC,
 * instead of OpenAI's Codex `app-server`.
 *
 * ACP (agentclientprotocol.com, Zed/Google/JetBrains, Sept 2025) is JSON-RPC 2.0
 * over stdio. Method names + shapes verified against @agentclientprotocol/sdk
 * 1.4.0 (dist/schema/types.gen.d.ts) and the claude-agent-acp adapter 0.23.1:
 *   - stdio framing is newline-delimited JSON (ndJsonStream in stream.js) — a
 *     hand-rolled client writes `JSON.stringify(msg)+"\n"` and reads lines, same
 *     as codex. No Content-Length framing.
 *   - session/new: { cwd (abs, REQUIRED), mcpServers: McpServer[] (REQUIRED),
 *     _meta.claudeCode.options } → { sessionId }. The adapter forwards
 *     _meta.claudeCode.options to query() (model, appendSystemPrompt,
 *     disallowedTools, pathToClaudeCodeExecutable pass through; permissionMode
 *     is OVERRIDDEN from the adapter's loaded settings — confinement relies on
 *     disallowedTools + the permission reverse-request, not permissionMode).
 *   - session/prompt: { sessionId, prompt: ContentBlock[] (NOT a string) } →
 *     { stopReason: 'end_turn'|'max_tokens'|'max_turn_requests'|'refusal'|'cancelled' }.
 *   - session/update notification: { sessionId, update: { sessionUpdate, ... } }
 *     — discriminator is `sessionUpdate` (NOT `kind`). Text deltas arrive as
 *     `agent_message_chunk` (update.content.{type:'text',text}); reasoning as
 *     `agent_thought_chunk`. There is NO stop variant — stop comes from the
 *     session/prompt response's stopReason.
 *   - session/request_permission (agent→client reverse request): request
 *     { sessionId, toolCall:{name,toolCallId,rawInput}, options:[{optionId,kind}] };
 *     response { outcome: {outcome:'selected',optionId} | {outcome:'cancelled'} }.
 *   - session/cancel: { sessionId } only.
 *
 * ── Loop-ownership caveat (the codex single-turn trick does NOT apply) ─────
 * ACP has NO structured-output / outputSchema (verified: zero matches in the
 * SDK types). Codex forces one terminal `{text,toolCalls}` object via
 * `outputSchema` (codex-app-server.ts:883) so the host parses + executes; that
 * escape hatch does not exist here. So this is a "fat transport": ONE stream()
 * call = ONE session/prompt = a FULL agent turn (the Claude agent owns its loop
 * and executes its own tools under our permission gate). We map agent_message_
 * chunk → onDelta and the session/prompt stopReason → onDone. We do NOT emit
 * onToolCall: the agent executes its own tools, and emitting would make the
 * host AgentLoop execute them too (double execution). genoffice's per-turn
 * AgentLoop therefore sees a single text turn and finalizes — coherent, but
 * the host loop is effectively bypassed for this provider.
 *
 * Consequence for document-mutating tools (propose_operations / apply_ops /
 * execute_slide_script): they cannot be "returned for host execution" the codex
 * way. The intended integration is to expose them as an MCP server passed
 * through _meta.claudeCode.options.mcpServers, whose handlers bridge via IPC to
 * the renderer's skill.executeTool — the agent calls them, the host runs them,
 * the result returns. That MCP-bridge is OUT OF SCOPE here (TODO). Without it
 * the confined agent can read context (in the prompt) and produce text but
 * cannot mutate the live document; its built-in FS/shell tools are denied.
 *
 * Other TODOs: listClaudeCodeModels hardcodes the catalog (the adapter exposes
 * no model/list); probe the local login to confirm auth + surface the default.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import type { AgentMessage, AgentToolDef } from '@genoffice/agent-core'
import type { AiChatResponse, AiProviderConfig, CodexModelCatalog } from './types'
import type { StreamCallbacks } from './protocols/shared'
import { createStreamWatchdog } from './watchdog'
import { startClaudeCodeMcpServer } from './claude-code-mcp'

const ACP_METHOD = {
  initialize: 'initialize',
  initialized: 'notifications/initialized',
  sessionNew: 'session/new',
  sessionLoad: 'session/load',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  sessionClose: 'session/close',
  sessionUpdate: 'session/update', // notification agent → client
  sessionRequestPermission: 'session/request_permission', // reverse request agent → client
} as const

/**
 * Built-in Claude Code tools we deny so the confined agent cannot touch the
 * filesystem or run shell — the ACP equivalent of codex's baseInstructions +
 * permission profile. Document mutation is meant to flow through genoffice's
 * own MCP-bridged tools (see header TODO), not these.
 */
const DENIED_BUILTIN_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'NotebookEdit',
] as const

const CLAUDE_BASE_INSTRUCTIONS =
  'You are the language-model backend embedded in GenOffice. ' +
  'Never inspect or modify local files, run shell commands, browse, or invoke any built-in tool. ' +
  'The caller supplies the complete relevant document context. ' +
  'GenOffice itself executes document-mutating tools; emit tool calls only for tools the caller provides.'

const DIAGNOSTIC_LIMIT = 16_000
const REQUEST_TIMEOUT_MS = 60_000
const IDLE_SHUTDOWN_MS = 120_000
const MAX_NATIVE_SESSIONS = 64

// ── JSON-RPC plumbing (mirrors codex-app-server.ts) ─────────────────────────

export interface RpcMessage {
  id?: unknown
  method?: unknown
  params?: unknown
  result?: unknown
  error?: unknown
}

interface RpcError {
  code?: unknown
  message?: unknown
  data?: unknown
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface NativeSession {
  sessionId: string
  signature: string
  messageFingerprints: string[]
}

// ── Adapter discovery ───────────────────────────────────────────────────────

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Resolve the claude-agent-acp entry script. The adapter ships as a node
 * package (@zed-industries/claude-agent-acp) whose bin `claude-agent-acp` points
 * at dist/index.js; we spawn `node <script>` so it is cross-platform and does
 * not depend on a global PATH entry.
 *
 * Precedence: configured path → resolved package entry → PATH `claude-agent-acp`.
 */
export async function resolveClaudeAgentAcpPath(configuredPath?: string): Promise<string> {
  const configured = (configuredPath ?? '').trim()
  if (configured) {
    if (await fileExists(configured)) return configured
    if (isAbsolute(configured)) return configured
  }
  // 1. resolve through the node resolution (createRequire survives esbuild's
  //    CJS bundling of the shell main, where bare `import.meta.resolve` does not)
  try {
    const req = createRequire(import.meta.url)
    const resolved = req.resolve('@zed-industries/claude-agent-acp/dist/index.js')
    if (await fileExists(resolved)) return resolved
  } catch {
    /* not resolvable from here — fall through */
  }
  // 2. dev runs from the repo root, where npm installs the adapter
  {
    const cwdPath = join(
      process.cwd(),
      'node_modules',
      '@zed-industries',
      'claude-agent-acp',
      'dist',
      'index.js',
    )
    if (await fileExists(cwdPath)) return cwdPath
  }
  const pathValue = process.env.PATH ?? process.env.Path ?? ''
  const dirs = pathValue ? pathValue.split(process.platform === 'win32' ? ';' : delimiter) : []
  for (const dir of dirs) {
    const clean = (dir ?? '').trim()
    if (!clean) continue
    const candidate = join(
      clean,
      process.platform === 'win32' ? 'claude-agent-acp.cmd' : 'claude-agent-acp',
    )
    if (await fileExists(candidate)) return candidate
  }
  throw new Error(
    'claude-agent-acp was not found. Install @zed-industries/claude-agent-acp ' +
      '(npm i @zed-industries/claude-agent-acp) or set a custom adapter path in AI settings.',
  )
}

/**
 * Child env: reuse the local `claude` CLI login (~/.claude) and never let a
 * stray ANTHROPIC_API_KEY silently route the agent to pay-as-you-go API billing
 * instead of the subscription login. The adapter itself does not read
 * ANTHROPIC_API_KEY, but the SDK subprocess it spawns might.
 */
function claudeAcpChildEnv(adapterPath: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  // The skeleton spawns the adapter via process.execPath, which inside
  // Electron is electron.exe — running a plain node script under it gives
  // non-clean stdout (stray blank lines) that breaks the ndjson framing.
  // ELECTRON_RUN_AS_NODE makes electron.exe behave as plain node for the
  // adapter subprocess.
  env.ELECTRON_RUN_AS_NODE = '1'
  if (!env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = join(homedir(), '.claude')
  delete env.ANTHROPIC_API_KEY
  if (isAbsolute(adapterPath)) {
    const key = Object.keys(env).find((name) => name.toLowerCase() === 'path') ?? 'PATH'
    env[key] = `${dirname(adapterPath)}${delimiter}${env[key] ?? ''}`
  }
  return env
}

function appendDiagnostic(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString()
  return next.length <= DIAGNOSTIC_LIMIT ? next : next.slice(-DIAGNOSTIC_LIMIT)
}

function rpcError(error: unknown): Error {
  const value = error && typeof error === 'object' ? (error as RpcError) : undefined
  const message = typeof value?.message === 'string' ? value.message : 'Unknown ACP error'
  const code = typeof value?.code === 'number' ? ` (${value.code})` : ''
  const data = value?.data === undefined ? '' : `: ${JSON.stringify(value.data)}`
  return new Error(`claude-agent-acp error${code}: ${message}${data}`)
}

function cancelledError(): Error {
  const error = new Error('claude-agent-acp request was cancelled')
  error.name = 'AbortError'
  return error
}

// ── ACP JSON-RPC client over stdio (mirrors CodexAppServerClient) ───────────

class ClaudeCodeAcpClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, PendingRequest>()
  private readonly notificationListeners = new Set<(message: RpcMessage) => void>()
  private readonly sessions = new Map<string, NativeSession>()
  private readonly initialized: Promise<void>
  private nextId = 1
  private stderr = ''
  private closed = false
  private users = 0
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  /** Per-run activity tap: any stdout line touches the stream watchdog so the
   *  connect timeout (which the ACP transport can't hit via "headers") is reset
   *  by initialize/session-new/session-update responses alike. Set per withClient use. */
  onActivity?: () => void

  constructor(
    readonly adapterPath: string,
    private readonly onClose: () => void,
  ) {
    this.child = spawn(process.execPath, [adapterPath], {
      env: claudeAcpChildEnv(adapterPath),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => this.onLine(line))
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = appendDiagnostic(this.stderr, chunk)
    })
    this.child.once('error', (error) => this.fail(error))
    this.child.once('close', (code) => {
      const detail = this.stderr.trim()
      this.fail(
        new Error(`claude-agent-acp exited (${code ?? 'unknown'})${detail ? `: ${detail}` : ''}`),
      )
    })
    this.initialized = this.initialize()
  }

  get isClosed(): boolean {
    return this.closed
  }

  retain(): void {
    this.users++
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  release(): void {
    this.users = Math.max(0, this.users - 1)
    if (this.users > 0 || this.closed) return
    this.idleTimer = setTimeout(() => this.close(), IDLE_SHUTDOWN_MS)
    this.idleTimer.unref?.()
  }

  async ready(): Promise<void> {
    await this.initialized
  }

  async request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    await this.initialized
    return this.requestWire(method, params, timeoutMs)
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params })
  }

  onNotification(listener: (message: RpcMessage) => void): () => void {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  getSession(id: string): NativeSession | undefined {
    return this.sessions.get(id)
  }

  setSession(id: string, session: NativeSession): void {
    this.sessions.delete(id)
    this.sessions.set(id, session)
    while (this.sessions.size > MAX_NATIVE_SESSIONS) {
      const oldest = this.sessions.keys().next().value as string | undefined
      if (!oldest) break
      const evicted = this.sessions.get(oldest)
      this.sessions.delete(oldest)
      if (evicted) void this.closeSession(evicted).catch(() => undefined)
    }
  }

  deleteSession(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    void this.closeSession(session).catch(() => undefined)
  }

  private async closeSession(session: NativeSession): Promise<void> {
    if (this.closed) return
    await this.requestWire(ACP_METHOD.sessionClose, { sessionId: session.sessionId }).catch(
      () => undefined,
    )
  }

  stop(): void {
    this.close()
  }

  private async initialize(): Promise<void> {
    await this.requestWire(ACP_METHOD.initialize, {
      protocolVersion: 1,
      capabilities: {},
      clientInfo: { name: 'genoffice', version: '0.1.0' },
    })
    // ACP (unlike MCP/LSP) has no notifications/initialized — the adapter returns
    // -32601 "Method not found" for it, so don't send it.
  }

  private requestWire(
    method: string,
    params: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('claude-agent-acp is not running'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        const detail = this.stderr.trim()
        reject(
          new Error(
            `claude-agent-acp request timed out: ${method}${detail ? `; adapter stderr: ${detail.slice(-2000)}` : ''}`,
          ),
        )
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.write({ method, id, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private write(message: unknown): void {
    if (this.closed || !this.child.stdin.writable) {
      throw new Error('claude-agent-acp input is closed')
    }
    // Newline-delimited JSON-RPC (verified: ndJsonStream in the adapter's
    // stream.js splits on \n; no Content-Length framing).
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private onLine(line: string): void {
    this.onActivity?.()
    let message: RpcMessage
    try {
      message = JSON.parse(line) as RpcMessage
    } catch {
      this.stderr = appendDiagnostic(this.stderr, `\nInvalid stdout JSON: ${line}`)
      return
    }
    // Reverse request from the agent (session/request_permission).
    if (typeof message.method === 'string' && message.id !== undefined) {
      void this.handleAgentRequest(message)
      return
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error !== undefined) pending.reject(rpcError(message.error))
      else pending.resolve(message.result)
      return
    }
    if (typeof message.method === 'string') {
      for (const listener of this.notificationListeners) listener(message)
    }
  }

  /**
   * Agent → client reverse request: permission to use a tool. We deny every
   * built-in FS/shell tool so the confined agent cannot escape; anything else
   * (genoffice-provided MCP tools) is allowed. ACP returns a selected
   * optionId (not a boolean), so we pick the matching allow/reject option the
   * agent offered, or `cancelled` if none.
   */
  private async handleAgentRequest(message: RpcMessage): Promise<void> {
    const id = message.id
    if (message.method === ACP_METHOD.sessionRequestPermission) {
      const params = (message.params ?? {}) as {
        toolCall?: { name?: string | null; title?: string | null; toolCallId?: string }
        options?: Array<{ optionId: string; kind?: string }>
      }
      const tool = params.toolCall?.name ?? params.toolCall?.title ?? ''
      const denied = (DENIED_BUILTIN_TOOLS as readonly string[]).includes(tool)
      const wantPrefix = denied ? 'reject' : 'allow'
      const choice = params.options?.find(
        (option) => typeof option.kind === 'string' && option.kind.startsWith(wantPrefix),
      )
      this.write({
        id,
        result: {
          outcome: choice
            ? { outcome: 'selected', optionId: choice.optionId }
            : { outcome: 'cancelled' },
        },
      })
      return
    }
    this.write({
      id,
      error: { code: -32601, message: `Unsupported agent request: ${message.method}` },
    })
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.idleTimer)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    for (const session of this.sessions.values()) void this.closeSession(session)
    this.sessions.clear()
    this.notificationListeners.clear()
    this.onClose()
  }

  private close(): void {
    if (this.closed) return
    try {
      this.child.kill()
    } finally {
      this.fail(new Error('claude-agent-acp stopped after being idle'))
    }
  }
}

const clients = new Map<string, ClaudeCodeAcpClient>()

/** Stop every adapter child during Electron shutdown or test cleanup. */
export function shutdownClaudeCodeAppServers(): void {
  for (const client of [...clients.values()]) client.stop()
  clients.clear()
}

async function clientFor(adapterPathValue: string | undefined): Promise<ClaudeCodeAcpClient> {
  const adapterPath = await resolveClaudeAgentAcpPath(adapterPathValue)
  const key = process.platform === 'win32' ? adapterPath.toLowerCase() : adapterPath
  const existing = clients.get(key)
  if (existing && !existing.isClosed) return existing
  const client = new ClaudeCodeAcpClient(adapterPath, () => {
    if (clients.get(key) === client) clients.delete(key)
  })
  clients.set(key, client)
  return client
}

async function withClient<T>(
  adapterPath: string | undefined,
  action: (client: ClaudeCodeAcpClient) => Promise<T>,
  onActivity?: () => void,
): Promise<T> {
  const client = await clientFor(adapterPath)
  client.retain()
  client.onActivity = onActivity
  try {
    await client.ready()
    return await action(client)
  } finally {
    client.onActivity = undefined
    client.release()
  }
}

// ── Session params / prompt building ───────────────────────────────────────

/**
 * Build session/new params. Claude-specific options ride on _meta.claudeCode.
 * options (the adapter forwards them to query()), so we reuse the local CLI
 * login (pathToClaudeCodeExecutable from config.cliPath), pick the model,
 * disable every built-in tool, and set a non-interactive permission mode.
 * `mcpServers` is where genoffice's document-mutating tools would plug in
 * (TODO: bridge to the renderer's skill.executeTool).
 */
function sessionNewParams(
  config: AiProviderConfig,
  system: string,
  mcpUrl?: string,
): Record<string, unknown> {
  const claudeCodeOptions: Record<string, unknown> = {
    // config.cliPath is the claude-agent-acp ADAPTER path (passed to spawn via
    // resolveClaudeAgentAcpPath); the adapter auto-resolves the claude CLI binary
    // + reuses the ~/.claude login, so we do NOT set pathToClaudeCodeExecutable.
    // The adapter OVERRIDES permissionMode from its loaded settings; this is
    // advisory. Real confinement = disallowedTools + the permission deny above.
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    disallowedTools: [...DENIED_BUILTIN_TOOLS],
    appendSystemPrompt: `${CLAUDE_BASE_INSTRUCTIONS}\n\n${system}`,
    ...(config.model.trim() ? { model: config.model.trim() } : {}),
    // Expose genoffice's document tools to the agent via the per-run MCP HTTP
    // server (startClaudeCodeMcpServer); the agent calls them, the app main
    // bridges each call to the renderer's skill.executeTool.
    ...(mcpUrl ? { mcpServers: { genoffice: { type: 'http', url: mcpUrl } } } : {}),
  }
  return {
    cwd: process.cwd(), // ACP requires an absolute cwd; FS tools are denied anyway
    mcpServers: [], // ACP requires the array (pass [] when none)
    _meta: { claudeCode: { options: claudeCodeOptions } },
  }
}

function conversationForPrompt(messages: AgentMessage[]): string {
  // ACP session/prompt takes ContentBlock[]; we serialize the transcript into
  // one text block (the adapter's session is per-turn unless resumed).
  return messages
    .map((message) => {
      if (message.role === 'user') return `# User\n${message.text}`
      if (message.role === 'assistant') {
        const calls = (message.toolCalls ?? [])
          .map((call) => `  - ${call.name}(${JSON.stringify(call.input)})`)
          .join('\n')
        return `# Assistant\n${message.text}${calls ? `\nTools:\n${calls}` : ''}`
      }
      const results = message.results
        .map((result) => `  - ${result.name}: ${result.output}`)
        .join('\n')
      return `# Tool results\n${results}`
    })
    .join('\n\n')
}

// ── Turn driver: session/prompt → session/update → StreamCallbacks ─────────

/**
 * Drive one session/prompt turn. Maps the agent's streamed session/update
 * notifications onto StreamCallbacks (agent_message_chunk → onDelta,
 * agent_thought_chunk → onReasoningDelta) and the session/prompt response's
 * stopReason → onStopReason/onDone. Honors cancel via session/cancel.
 *
 * Does NOT emit onToolCall: the agent executes its own tools in the
 * fat-transport model (built-ins denied; genoffice tools via MCP — TODO).
 * Emitting onToolCall would make the host AgentLoop execute them too.
 */
async function waitForSessionPrompt(
  client: ClaudeCodeAcpClient,
  sessionId: string,
  promptText: string,
  signal: AbortSignal,
  cb: StreamCallbacks,
): Promise<string> {
  if (signal.aborted) throw cancelledError()
  let stopReason = 'end_turn'
  let settled = false
  return new Promise<string>((resolve, reject) => {
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      unsubscribe()
      signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(stopReason)
    }
    const onAbort = () => {
      // session/cancel is a notification (notify returns void — no .catch);
      // the agent then resolves session/prompt with stopReason 'cancelled'.
      client.notify(ACP_METHOD.sessionCancel, { sessionId })
      finish(cancelledError())
    }
    const unsubscribe = client.onNotification((message) => {
      if (message.method !== ACP_METHOD.sessionUpdate) return
      const params = (message.params ?? {}) as {
        sessionId?: string
        update?: Record<string, unknown>
      }
      if (params.sessionId !== sessionId) return
      cb.onActivity?.()
      const update = params.update ?? {}
      const sessionUpdate = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : ''
      if (sessionUpdate === 'agent_message_chunk' || sessionUpdate === 'user_message_chunk') {
        const content = update.content as { type?: string; text?: string } | undefined
        if (content?.type === 'text' && typeof content.text === 'string') cb.onDelta(content.text)
      } else if (sessionUpdate === 'agent_thought_chunk') {
        const content = update.content as { type?: string; text?: string } | undefined
        if (content?.type === 'text' && typeof content.text === 'string') {
          cb.onReasoningDelta?.(content.text)
        }
      }
      // tool_call / tool_call_update are intentionally not re-emitted (see header).
    })
    signal.addEventListener('abort', onAbort, { once: true })
    void client
      .request(
        ACP_METHOD.sessionPrompt,
        {
          sessionId,
          prompt: [{ type: 'text', text: promptText }], // ACP prompt is ContentBlock[]
        },
        600_000, // the prompt request blocks until the whole agent turn ends; a
        // multi-tool turn (esp. generate_deck's staged LLM + image steps) can
        // take minutes, so the default 60s requestWire timeout is far too short.
      )
      .then((result) => {
        const stop = (result as { stopReason?: string } | null)?.stopReason
        if (typeof stop === 'string' && stop) stopReason = stop
        finish()
      })
      .catch((error) => finish(error instanceof Error ? error : new Error(String(error))))
  })
}

// ── Run orchestrator (session reuse + prompt) ───────────────────────────────

async function runClaudeCodeAcp(
  config: AiProviderConfig,
  system: string,
  messages: AgentMessage[],
  tools: AgentToolDef[],
  _maxTokens: number,
  cb: StreamCallbacks,
): Promise<void> {
  const nativeSessionId = cb.sessionId ?? `one-shot-${randomUUID()}`
  const ephemeral = cb.sessionId === undefined
  // Expose genoffice's document tools to the agent over a per-run MCP HTTP
  // server. The agent (its built-in tools denied) calls these; the app main
  // bridges each call to the renderer's skill.executeTool via cb.executeTool.
  const mcp =
    tools.length > 0 && cb.executeTool
      ? await startClaudeCodeMcpServer(tools, cb.executeTool, cb.signal)
      : null
  try {
    await withClient(config.cliPath, async (client) => {
      // mcpUrl is in the signature on purpose: the MCP server is per-run (new
      // port each turn), so a different URL must force a fresh session/new that
      // re-advertises the live MCP URL — otherwise a reused ACP session keeps
      // pointing at the previous (stopped) MCP server.
      const signature = sessionSignature(system, tools, config.model.trim(), mcp?.url)
      let session = client.getSession(nativeSessionId)
      if (!session || session.signature !== signature) {
        if (session) client.deleteSession(nativeSessionId)
        const newResult = (await client.request(
          ACP_METHOD.sessionNew,
          sessionNewParams(config, system, mcp?.url),
        )) as { sessionId?: string }
        const acpSessionId = newResult?.sessionId
        if (typeof acpSessionId !== 'string' || !acpSessionId) {
          throw new Error('claude-agent-acp did not return a session id')
        }
        session = { sessionId: acpSessionId, signature, messageFingerprints: [] }
        client.setSession(nativeSessionId, session)
      }
      try {
        const stopReason = await waitForSessionPrompt(
          client,
          session.sessionId,
          conversationForPrompt(messages),
          cb.signal,
          cb,
        )
        session.messageFingerprints = messages.map(fingerprint)
        if (stopReason === 'max_tokens') cb.onStopReason?.('max_tokens')
      } catch (error) {
        client.deleteSession(nativeSessionId)
        throw error
      } finally {
        if (ephemeral) client.deleteSession(nativeSessionId)
      }
    }, cb.onActivity)
  } finally {
    await mcp?.stop()
  }
}

// ── Public exports (the surface stream.ts/chat.ts/dispatch expect) ──────────

export async function streamClaudeCodeAppServer(
  config: AiProviderConfig,
  system: string,
  messages: AgentMessage[],
  tools: AgentToolDef[],
  maxTokens: number,
  cb: StreamCallbacks,
): Promise<void> {
  const wd = createStreamWatchdog(cb.signal)
  return wd.guard(() =>
    runClaudeCodeAcp(config, system, messages, tools, maxTokens, {
      ...cb,
      signal: wd.signal,
      onActivity: () => {
        wd.touch()
        cb.onActivity?.()
      },
    }),
  )
}

export async function chatClaudeCodeAppServer(
  config: AiProviderConfig,
  system: string,
  user: string,
  signal: AbortSignal,
): Promise<AiChatResponse> {
  let content = ''
  await runClaudeCodeAcp(config, system, [{ role: 'user', text: user }], [], 1024, {
    signal,
    onDelta: (text) => {
      content += text
    },
    onToolCall: () => undefined,
  })
  return content
    ? { ok: true, content }
    : { ok: false, error: 'claude-agent-acp returned no content' }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function fingerprint(message: AgentMessage): string {
  return createHash('sha256').update(JSON.stringify(message)).digest('hex')
}

function sessionSignature(
  system: string,
  tools: AgentToolDef[],
  model: string,
  mcpUrl?: string,
): string {
  return createHash('sha256').update(JSON.stringify({ system, tools, model, mcpUrl })).digest('hex')
}

/**
 * The adapter exposes no model/list RPC. Return the catalog genoffice already
 * knows for the Claude family (mirrors the anthropic provider list) so the
 * settings UI can populate a picker; the real default comes from the local CLI
 * login. TODO: probe the login to confirm auth + surface the account default.
 */
export async function listClaudeCodeModels(_cliPath?: string): Promise<CodexModelCatalog> {
  return {
    models: [
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
    ],
    defaultModel: 'claude-sonnet-5',
  }
}
