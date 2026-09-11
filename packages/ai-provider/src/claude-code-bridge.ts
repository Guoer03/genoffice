/**
 * The cohesive main↔renderer bridge for the claude-code provider's document
 * tools. ALL claude-code tool-exec IPC (the two fixed channel names + the
 * bridge logic) lives in this one file — a fork pulling upstream only has to
 * keep these two named channels and the two helper calls in place.
 *
 * Why: the claude-agent-acp adapter (subprocess) runs the Claude agent, which
 * calls genoffice's document-mutating tools over the per-run MCP HTTP server
 * (claude-code-mcp.ts). Each tools/call reaches the Electron MAIN process
 * (the MCP server's `executeTool`), but the document tools live in the
 * RENDERER (Univer facade / Konva applySlide). This module bridges a main-side
 * `executeTool` to the renderer's skill.executeTool and back, over TWO fixed
 * IPC channels (so the preload only has to expose two named methods, not a
 * generic send/on).
 *
 * Electron is NOT imported here: the caller injects `send`/`on` (a tiny shim
 * around ipcMain/ipcRenderer or the preload's two named methods) so this module
 * stays dependency-free and the bridge logic is testable + cohesive.
 */
import type { AgentToolCall, ToolExecution } from '@genoffice/agent-core'

/** main → renderer: "execute this tool for this run". Fixed channel. */
export const CLAUDE_CODE_TOOL_EXEC_CHANNEL = 'ai:claude-code-tool-exec'
/** renderer → main: the result. Fixed channel; payload carries requestId+callId. */
export const CLAUDE_CODE_TOOL_RESULT_CHANNEL = 'ai:claude-code-tool-result'

export interface ClaudeCodeToolIpc {
  send: (channel: string, payload: unknown) => void
  /** Subscribe to a channel; returns unsubscribe. The handler receives the
   *  message payload (the caller unwraps the Electron event). */
  on: (channel: string, handler: (payload: unknown) => void) => () => void
}

interface ToolExecPayload {
  requestId: string
  call: AgentToolCall
}
interface ToolResultPayload {
  requestId: string
  callId: string
  result: ToolExecution
}

/**
 * Main side: returns an `executeTool` that sends each call to the renderer on
 * the fixed EXEC channel and awaits the matching result on the fixed RESULT
 * channel (filtered by requestId+callId, so concurrent calls don't cross-talk).
 * The app main wires this into `ai:stream`'s StreamCallbacks only when
 * `provider === 'claude-code'` (conditional spread — other providers untouched,
 * exactOptionalPropertyTypes satisfied).
 */
export function claudeCodeToolExecBridge(
  ipc: ClaudeCodeToolIpc,
  requestId: string,
): (call: AgentToolCall) => Promise<ToolExecution> {
  return (call) =>
    new Promise<ToolExecution>((resolve) => {
      const off = ipc.on(CLAUDE_CODE_TOOL_RESULT_CHANNEL, (payload) => {
        const result = payload as ToolResultPayload | undefined
        if (result?.requestId !== requestId || result?.callId !== call.id) return
        off()
        resolve(result.result)
      })
      ipc.send(CLAUDE_CODE_TOOL_EXEC_CHANNEL, { requestId, call } satisfies ToolExecPayload)
    })
}

/**
 * Renderer side: register a handler that runs the current skill's executeTool
 * for each claude-code tool call bridged from main, returning the result on the
 * fixed RESULT channel. Returns an unregister (call on teardown).
 *
 * The skill is fetched lazily per call (a reopened document with a fresh skill
 * keeps working without re-registration).
 */
export function registerClaudeCodeToolExecHandler(
  ipc: ClaudeCodeToolIpc,
  getSkill: () =>
    | {
        executeTool?: (
          call: AgentToolCall,
          signal: AbortSignal,
        ) => ToolExecution | Promise<ToolExecution>
      }
    | undefined,
): () => void {
  return ipc.on(CLAUDE_CODE_TOOL_EXEC_CHANNEL, async (payload) => {
    const { requestId, call } = payload as ToolExecPayload
    const skill = getSkill()
    const result: ToolExecution = skill?.executeTool
      ? await skill.executeTool(call, new AbortController().signal)
      : {
          output: 'no skill available for the claude-code tool call',
          isError: true,
          summary: call.name,
        }
    ipc.send(CLAUDE_CODE_TOOL_RESULT_CHANNEL, {
      requestId,
      callId: call.id,
      result,
    } satisfies ToolResultPayload)
  })
}
