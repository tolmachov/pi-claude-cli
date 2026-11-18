/**
 * Provider orchestration for bridging pi requests to the Claude CLI subprocess.
 *
 * streamViaCli is the core function that:
 * 1. Builds the prompt from conversation context
 * 2. Spawns a Claude CLI subprocess with correct flags
 * 3. Writes the user message to stdin as NDJSON
 * 4. Reads stdout line-by-line, parsing NDJSON
 * 5. Routes stream events through the event bridge to pi's stream
 * 6. Handles result/error messages and cleans up the subprocess
 * 7. Implements break-early: kills subprocess at message_stop when
 *    built-in or custom-tools MCP tool_use blocks are seen
 * 8. Hardened lifecycle: inactivity timeout, subprocess exit handler,
 *    streamEnded guard, abort via SIGKILL, process registry
 */

import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import {
  AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import {
  buildPrompt,
  buildSystemPrompt,
  buildResumePrompt,
} from "./prompt-builder.js";
import {
  spawnClaude,
  writeUserMessage,
  cleanupProcess,
  captureStderr,
  forceKillProcess,
  registerProcess,
  cleanupSystemPromptFile,
} from "./process-manager.js";
import { parseLine } from "./stream-parser.js";
import { createEventBridge } from "./event-bridge.js";
import { handleControlRequest } from "./control-handler.js";
import { mapThinkingEffort } from "./thinking-config.js";
import { isPiKnownClaudeTool } from "./tool-mapping.js";
/** Inactivity timeout: kill subprocess if no stdout for 180 seconds (3 minutes). */
const INACTIVITY_TIMEOUT_MS = 180_000;
// Pi session IDs are not CLI session IDs; only resume a session we observed.
const cliSessions = new Map<string, { cliId: string; historyKey: string }>();

function errorText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (
    value &&
    typeof value === "object" &&
    "message" in value &&
    typeof value.message === "string"
  )
    return value.message.trim();
  return "";
}

/** Extended stream options: pi's SimpleStreamOptions plus optional cwd and mcpConfigPath */
type StreamViaCLiOptions = SimpleStreamOptions & {
  cwd?: string;
  mcpConfigPath?: string;
};

/**
 * Stream a response from Claude CLI as an AssistantMessageEventStream.
 *
 * Orchestrates the full subprocess lifecycle: spawn, write prompt, parse NDJSON,
 * bridge events, handle result, and clean up. Implements break-early pattern:
 * at message_stop, if any built-in or custom-tools MCP tool was seen, kills
 * the subprocess before Claude CLI can auto-execute the tools.
 *
 * Hardened with: inactivity timeout (180s), subprocess exit handler with stderr
 * surfacing, streamEnded guard against double errors, abort via SIGKILL, and
 * process registry integration for teardown cleanup.
 *
 * @param model - The model to use (from pi's model catalog)
 * @param context - The conversation context with messages and system prompt
 * @param options - Optional cwd, abort signal, reasoning level, thinking budgets, and mcpConfigPath
 * @returns An AssistantMessageEventStream that receives bridged events
 */
export function streamViaCli(
  model: Model<any>,
  context: { messages: any[]; systemPrompt?: string },
  options?: StreamViaCLiOptions,
): AssistantMessageEventStream {
  // @ts-expect-error — tsc can't verify AssistantMessageEventStream is a value
  // through pi-ai's `export *` re-export chain. The class constructor exists at runtime.
  const stream = new AssistantMessageEventStream();

  (async () => {
    let proc: ReturnType<typeof spawnClaude> | undefined;
    let abortHandler: (() => void) | undefined;
    const bridge = createEventBridge(stream, model);

    try {
      if (options?.signal?.aborted) throw new Error("Request aborted");
      const cwd = options?.cwd ?? process.cwd();

      const piSessionId = options?.sessionId;
      const systemPrompt = buildSystemPrompt(context, cwd);
      const conversation = context.messages.filter(
        (message) => message.role !== "system",
      );
      const historyKey = (messages: any[]) =>
        createHash("sha256")
          .update(
            JSON.stringify({
              cwd,
              model: model.id,
              systemPrompt,
              messages: messages.map(
                ({ role, content, toolName, toolCallId }) => ({
                  role,
                  content:
                    typeof content === "string"
                      ? [{ type: "text", text: content }]
                      : content,
                  toolName,
                  toolCallId,
                }),
              ),
            }),
          )
          .digest("hex");
      const lastAssistantIndex = conversation
        .map((message) => message.role)
        .lastIndexOf("assistant");
      const previous = piSessionId ? cliSessions.get(piSessionId) : undefined;
      const resumeSessionId =
        previous &&
        lastAssistantIndex >= 0 &&
        previous.historyKey ===
          historyKey(conversation.slice(0, lastAssistantIndex + 1))
          ? previous.cliId
          : undefined;
      let observedSessionId = resumeSessionId;
      function rememberSession() {
        if (piSessionId && observedSessionId)
          cliSessions.set(piSessionId, {
            cliId: observedSessionId,
            historyKey: historyKey([
              ...conversation,
              { role: "assistant", content: bridge.getOutput().content },
            ]),
          });
      }

      const prompt = resumeSessionId
        ? buildResumePrompt(context)
        : buildPrompt(context);

      // Compute effort level from reasoning options
      const effort = mapThinkingEffort(
        options?.reasoning,
        model.id,
        options?.thinkingBudgets,
      );

      // Spawn subprocess
      proc = spawnClaude(
        model.id,
        resumeSessionId ? undefined : systemPrompt || undefined,
        {
          cwd,
          signal: options?.signal,
          effort,
          mcpConfigPath: options?.mcpConfigPath,
          resumeSessionId,
        },
      );
      const getStderr = captureStderr(proc);
      const processClosed = new Promise<void>((resolve) =>
        proc!.once("close", () => resolve()),
      );
      let resultReceived = false;

      // Register in global process registry for teardown cleanup
      registerProcess(proc);

      // Guard against double stream.end() and double error events.
      // First error path wins; subsequent ones are no-ops.
      let streamEnded = false;

      // Error events carry an AssistantMessage, not a string or successful done.
      function endStreamWithError(
        errMsg: string,
        reason: "error" | "aborted" = "error",
      ) {
        if (streamEnded || (broken && reason !== "aborted")) return;
        if (piSessionId) cliSessions.delete(piSessionId);
        streamEnded = true;
        const output = bridge.getOutput();
        const errorMessage = {
          ...output,
          content: output.content?.length
            ? output.content
            : [{ type: "text" as const, text: `Error: ${errMsg}` }],
          stopReason: reason,
          errorMessage: errMsg,
        };
        stream.push({ type: "error", reason, error: errorMessage });
        stream.end();
        clearTimeout(inactivityTimer);
        cleanupProcess(proc!);
        rl.close();
      }

      // Inactivity timeout: kill subprocess if no stdout for INACTIVITY_TIMEOUT_MS
      let inactivityTimer: ReturnType<typeof setTimeout> | undefined;

      function resetInactivityTimer() {
        if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          forceKillProcess(proc!);
          endStreamWithError(
            `Claude CLI subprocess timed out: no output for ${INACTIVITY_TIMEOUT_MS / 1000} seconds`,
          );
        }, INACTIVITY_TIMEOUT_MS);
      }

      // Set up abort signal handler -- uses SIGKILL for immediate force-kill
      if (options?.signal) {
        abortHandler = () => {
          if (proc) {
            forceKillProcess(proc);
          }
        };

        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      // Track tool_use blocks for break-early decision at message_stop
      let sawBuiltInOrCustomTool = false;
      // Guard against buffered readline lines firing after rl.close()
      let broken = false;

      // Set up readline for line-by-line NDJSON parsing
      const rl = createInterface({
        input: proc.stdout!,
        crlfDelay: Infinity,
        terminal: false,
      });

      // Handle process error -- use endStreamWithError for guard
      proc.on("error", (err: Error) => {
        if (broken) return; // Break-early killed the process intentionally
        const stderr = getStderr();
        endStreamWithError(stderr || err.message);
      });

      // Handle subprocess close -- surface crashes with stderr and exit code
      proc.on("close", (code: number | null, _signal: string | null) => {
        clearTimeout(inactivityTimer);
        if (broken) return; // Break-early kill, expected
        if (code !== 0 && code !== null) {
          const stderr = getStderr();
          const message = stderr
            ? `Claude CLI exited with code ${code}: ${stderr.trim()}`
            : `Claude CLI exited unexpectedly with code ${code}`;
          endStreamWithError(message);
        }
      });

      // Process NDJSON lines from stdout using event-based callback
      // NOTE: Using 'line' event instead of `for await` because the async
      // iterator batches lines, breaking real-time streaming to pi.
      rl.on("line", (line: string) => {
        if (broken || streamEnded) return; // Ignore buffered lines after finalization.

        // Reset inactivity timer on each line of output
        resetInactivityTimer();

        const msg = parseLine(line);
        if (!msg) return;

        if (
          piSessionId &&
          !msg.parent_tool_use_id &&
          ((msg.type === "system" && msg.subtype === "init") ||
            msg.type === "result") &&
          typeof msg.session_id === "string" &&
          msg.session_id
        ) {
          observedSessionId = msg.session_id;
        }

        if (msg.type === "stream_event") {
          // Only forward top-level events to pi's event bridge.
          // Sub-agent events (parent_tool_use_id !== null) are internal to the CLI.
          const isTopLevel = !msg.parent_tool_use_id;
          if (isTopLevel) {
            bridge.handleEvent(msg.event);
          }

          // Track tool_use blocks for break-early decision (top-level only)
          if (
            isTopLevel &&
            msg.event.type === "content_block_start" &&
            msg.event.content_block?.type === "tool_use"
          ) {
            const toolName = msg.event.content_block.name;
            if (toolName && isPiKnownClaudeTool(toolName)) {
              // Built-in tool (Read/Write/etc.) OR custom MCP tool (mcp__custom-tools__*)
              // Internal Claude Code tools (ToolSearch, Task, etc.) are excluded
              sawBuiltInOrCustomTool = true;
            }
          }

          // Break-early at message_stop: kill subprocess before CLI auto-executes tools
          // Only on top-level message_stop — sub-agent message_stop is internal
          if (
            isTopLevel &&
            msg.event.type === "message_stop" &&
            sawBuiltInOrCustomTool
          ) {
            broken = true; // Set guard BEFORE rl.close() to prevent buffered lines
            clearTimeout(inactivityTimer);
            // Pi will execute these tools. Kill subprocess to prevent CLI from executing them.
            forceKillProcess(proc!);
            rl.close();
            return; // Finalize after readline closes, outside the synchronous handler.
          }
        } else if (msg.type === "control_request") {
          handleControlRequest(msg, proc!.stdin!);
        } else if (msg.type === "result" && !msg.parent_tool_use_id) {
          resultReceived = true;
          if (msg.is_error === true || msg.subtype !== "success") {
            const detail =
              errorText(msg.error) ||
              errorText(msg.result) ||
              (Array.isArray(msg.errors)
                ? msg.errors.map(errorText).filter(Boolean).join("; ")
                : errorText(msg.errors)) ||
              getStderr().trim() ||
              `Claude CLI reported ${msg.subtype}`;
            endStreamWithError(detail);
          }
          // For both success and error: clean up the subprocess
          clearTimeout(inactivityTimer);
          cleanupProcess(proc!);
          rl.close();
        }
      });

      proc.stdin!.on("error", (err: NodeJS.ErrnoException) => {
        // An oversized prompt may close stdin before its rejection arrives on stdout.
        if (err.code !== "EPIPE") endStreamWithError(err.message);
      });
      const closed = new Promise<void>((resolve) => rl.once("close", resolve));
      resetInactivityTimer();
      writeUserMessage(proc, prompt);
      await closed;
      if (options?.signal?.aborted)
        endStreamWithError("Request aborted", "aborted");
      // EOF can precede the child's nonzero close event. A result or intentional
      // tool handoff may finish early, but bare EOF is not evidence of success.
      if (!broken && !resultReceived && !streamEnded) {
        await processClosed;
        if (!streamEnded) {
          const aborted = options?.signal?.aborted;
          endStreamWithError(
            aborted
              ? "Request aborted"
              : getStderr().trim() || "Claude CLI ended without a result",
            aborted ? "aborted" : "error",
          );
        }
      }

      // Push done event after readline closes (async). Pushing synchronously
      // inside handleMessageStop prevents pi from executing tools.
      // Guard with streamEnded to avoid pushing done after an error was already pushed.
      if (!streamEnded) {
        const output = bridge.getOutput();

        // If stopReason is toolUse but there are no pi-known tool calls in content,
        // it means only user MCP tools were called (filtered by event bridge).
        // Override to "stop" so pi doesn't try to execute non-existent tools.
        const piToolCalls = (output.content || []).filter(
          (c: any) => c.type === "toolCall",
        );
        const effectiveReason =
          output.stopReason === "toolUse" && piToolCalls.length === 0
            ? "stop"
            : output.stopReason;

        rememberSession();
        streamEnded = true;
        stream.push({
          type: "done",
          reason:
            effectiveReason === "toolUse"
              ? "toolUse"
              : effectiveReason === "length"
                ? "length"
                : "stop",
          message: { ...output, stopReason: effectiveReason },
        });
        stream.end();
      }
    } catch (err: any) {
      if (options?.sessionId) cliSessions.delete(options.sessionId);
      if (proc) forceKillProcess(proc);
      const reason = options?.signal?.aborted ? "aborted" : "error";
      stream.push({
        type: "error",
        reason,
        error: {
          ...bridge.getOutput(),
          stopReason: reason,
          errorMessage: err.message ?? "Unexpected error in streamViaCli",
        },
      } as any);
      stream.end();
    } finally {
      // Clean up abort listener
      if (options?.signal && abortHandler) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      if (proc) cleanupSystemPromptFile(proc);
    }
  })();

  return stream;
}
