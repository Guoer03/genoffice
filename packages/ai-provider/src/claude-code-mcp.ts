/**
 * Per-run MCP Streamable HTTP server that exposes genoffice's document tools
 * (the AgentToolDef[] the renderer's skill defines) to the Claude agent running
 * inside the claude-agent-acp adapter subprocess.
 *
 * Why: ACP has no structured-output (so the codex single-turn-host-executes
 * pattern is unavailable). The Claude agent owns its loop and executes its own
 * tools; we deny its built-in FS/shell tools (claude-code-app-server.ts) and
 * instead expose genoffice's document-mutating tools via MCP. The agent calls
 * them over HTTP; each call is bridged back to the host via `executeTool`,
 * which the app main wires to the renderer's skill.executeTool — so the
 * mutation flows through genoffice's shared executor (same as the ribbon/AI).
 *
 * The adapter is told about this server via
 * `_meta.claudeCode.options.mcpServers.genoffice = { type: 'http', url }`.
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { AgentToolCall, AgentToolDef, ToolExecution } from '@genoffice/agent-core'

export interface ClaudeCodeMcpHandle {
  /** The URL the agent POSTs MCP JSON-RPC to (passed to mcpServers.genoffice). */
  url: string
  stop(): Promise<void>
}

/**
 * Start a stateless MCP Streamable HTTP server on an ephemeral localhost port,
 * exposing `tools` and routing `tools/call` to `executeTool`. Tied to the
 * run: stopped on `signal` abort or when the run ends.
 */
export async function startClaudeCodeMcpServer(
  tools: AgentToolDef[],
  executeTool: (call: AgentToolCall) => Promise<ToolExecution>,
  signal: AbortSignal,
): Promise<ClaudeCodeMcpHandle> {
  const server = new Server(
    { name: 'genoffice', version: '0.1.0' },
    { capabilities: { tools: {}, logging: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    console.error(`[cc-mcp] tools/list requested -> ${tools.length} tools`)
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name
    const input = (request.params.arguments ?? {}) as Record<string, unknown>
    const call: AgentToolCall = { id: `mcp-${randomUUID()}`, name, input }
    try {
      const result = await executeTool(call)
      return {
        content: [{ type: 'text' as const, text: result.output }],
        ...(result.isError ? { isError: true } : {}),
      }
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
        ],
      }
    }
  })

  // Stateful: the Claude CLI's MCP HTTP client expects a Mcp-Session-Id in the
  // initialize response and won't proceed to tools/list without one.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
  await server.connect(transport as any)

  const httpServer = createServer((req, res) => {
    transport.handleRequest(req, res).catch(() => undefined)
  })
  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', resolve)
  })
  const port = (httpServer.address() as { port: number }).port
  const url = `http://127.0.0.1:${port}/mcp`
  console.error(
    `[cc-mcp] server up at ${url}; exposing ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`,
  )
  httpServer.on('request', (req) => {
    if (req.method === 'POST' || req.method === 'GET')
      console.error(`[cc-mcp] ${req.method} ${req.url}`)
  })

  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    httpServer.close()
    await server.close().catch(() => undefined)
  }
  signal.addEventListener('abort', () => void stop(), { once: true })

  return { url, stop }
}
