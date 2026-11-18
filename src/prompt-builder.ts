/**
 * Prompt builder for flattening pi conversation history into a labeled text prompt.
 *
 * Follows the reference project's buildPromptBlocks() pattern:
 * - USER: / ASSISTANT: / TOOL RESULT: labels
 * - Content blocks serialized by type
 * - Images in the final user message are translated to Anthropic API format (HIST-02)
 * - Images in non-final messages get placeholder text with console.warn
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import * as piAi from "@mariozechner/pi-ai";
import {
  mapPiToolNameToClaude,
  translatePiArgsToClaude,
  isCustomToolName,
} from "./tool-mapping.js";

/**
 * Anthropic API content block types for image passthrough.
 * Used when the final user message contains images that need to be
 * translated from pi-ai format to Anthropic format.
 */
type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    };

// We use `any` for Context to avoid requiring @mariozechner/pi-ai at dev time.
// At runtime, pi provides the real Context type.

/**
 * Flattens a pi conversation context's messages array into a labeled text prompt
 * suitable for sending to the Claude CLI subprocess.
 *
 * Each message is labeled with its role:
 * - USER: for user messages
 * - ASSISTANT: for assistant messages
 * - TOOL RESULT (historical {toolName}): for tool result messages
 */
/** Module-level counter for placeholder images, reset per buildPrompt call. */
let placeholderImageCount = 0;

/**
 * Translate a pi-ai image block to Anthropic API format.
 * Returns null if the block is missing required data/mimeType fields.
 *
 * pi-ai format:  { type: "image", data: string (base64), mimeType: string }
 * Anthropic format: { type: "image", source: { type: "base64", media_type: string, data: string } }
 */
function translateImageBlock(piBlock: any): AnthropicContentBlock | null {
  if (piBlock.data && piBlock.mimeType) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: piBlock.mimeType,
        data: piBlock.data,
      },
    };
  }
  return null; // Invalid image block, will fall back to placeholder
}

/**
 * Build content blocks for the final user message, translating images
 * from pi-ai format to Anthropic API format.
 *
 * @returns Array of AnthropicContentBlock with text and translated images
 */
function buildFinalUserContent(
  content: string | any[],
): AnthropicContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    return [{ type: "text", text: "" }];
  }

  const blocks: AnthropicContentBlock[] = [];
  for (const block of content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text ?? "" });
    } else if (block.type === "image") {
      const translated = translateImageBlock(block);
      if (translated) {
        blocks.push(translated);
      } else {
        // Invalid image block: fall back to placeholder text
        blocks.push({
          type: "text",
          text: "[An image was shared here but could not be included]",
        });
        placeholderImageCount++;
      }
    }
    // Unknown block types silently skipped
  }
  return blocks;
}

/**
 * Check if a message content array contains image blocks.
 */
function contentHasImages(content: string | any[]): boolean {
  if (typeof content === "string" || !Array.isArray(content)) return false;
  return content.some((block) => block.type === "image");
}

/**
 * Resume sends only input after the latest assistant response.
 * Full-history replay is reserved for a new CLI session.
 */
export function buildResumePrompt(context: {
  messages: any[];
}): string | AnthropicContentBlock[] {
  placeholderImageCount = 0;
  let lastAssistantIndex = -1;
  for (let i = context.messages.length - 1; i >= 0; i--) {
    if (context.messages[i].role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }

  const parts: string[] = [];
  const blocks: AnthropicContentBlock[] = [];
  const flushText = () => {
    if (parts.length)
      blocks.push({ type: "text", text: parts.splice(0).join("\n") });
  };

  for (const message of context.messages.slice(lastAssistantIndex + 1)) {
    if (message.role !== "user" && message.role !== "toolResult") continue;
    if (message.role === "toolResult") {
      const name = message.toolName ?? "unknown";
      parts.push(
        isCustomToolName(name)
          ? `TOOL RESULT (${name}):`
          : `TOOL RESULT (historical ${mapPiToolNameToClaude(name)}):`,
      );
    }
    for (const block of buildFinalUserContent(message.content)) {
      if (block.type === "text") parts.push(block.text);
      else {
        flushText();
        blocks.push(block);
      }
    }
  }

  if (!blocks.length) return parts.join("\n");
  flushText();
  return blocks;
}

export function buildPrompt(context: {
  messages: any[];
}): string | AnthropicContentBlock[] {
  // Reset placeholder counter for each call
  placeholderImageCount = 0;

  // Determine if any message has images worth passing through
  const finalUserIndex = findFinalUserMessageIndex(context.messages);
  const finalUserHasImages =
    finalUserIndex >= 0 &&
    contentHasImages(context.messages[finalUserIndex].content);
  const anyToolResultHasImages = context.messages.some(
    (m: any) => m.role === "toolResult" && toolResultHasImages(m.content),
  );

  if (finalUserHasImages || anyToolResultHasImages) {
    // Build history as text (all messages except the final user message)
    const historyParts: string[] = [];
    const toolResultImageBlocks: AnthropicContentBlock[] = [];
    for (let i = 0; i < context.messages.length; i++) {
      if (i === finalUserIndex) continue; // Skip final user message -- handled separately
      const message = context.messages[i];
      if (message.role === "user") {
        historyParts.push("USER:");
        historyParts.push(userContentToText(message.content));
      } else if (message.role === "assistant") {
        historyParts.push("ASSISTANT:");
        historyParts.push(contentToText(message.content));
      } else if (message.role === "toolResult") {
        if (message.toolName && isCustomToolName(message.toolName)) {
          historyParts.push(`TOOL RESULT (${message.toolName}):`);
        } else {
          const claudeToolName = message.toolName
            ? mapPiToolNameToClaude(message.toolName)
            : "unknown";
          historyParts.push(`TOOL RESULT (historical ${claudeToolName}):`);
        }
        // Extract text portion of tool result
        historyParts.push(toolResultContentToText(message.content));
        // Collect image blocks from tool results for passthrough
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === "image") {
              const translated = translateImageBlock(block);
              if (translated) {
                toolResultImageBlocks.push(translated);
                // Undo the placeholder count from toolResultContentToText since we're passing through
                placeholderImageCount--;
              }
            }
          }
        }
      }
    }

    // Build final user message content blocks
    const finalUserContent =
      finalUserIndex >= 0
        ? buildFinalUserContent(context.messages[finalUserIndex].content)
        : [];

    // Combine: history text + tool result images + final user content blocks
    const result: AnthropicContentBlock[] = [];
    const historyText = historyParts.join("\n");
    if (historyText) {
      result.push({ type: "text", text: historyText });
    }
    // Insert tool result images after history text (Claude sees them in context)
    result.push(...toolResultImageBlocks);
    result.push(...finalUserContent);

    if (placeholderImageCount > 0) {
      console.warn(
        `[pi-claude-cli] ${placeholderImageCount} image(s) in conversation history could not be included in the prompt`,
      );
    }

    return result;
  }

  // No images in final user message: standard text-only path
  const parts: string[] = [];

  for (const message of context.messages) {
    if (message.role === "user") {
      parts.push("USER:");
      parts.push(userContentToText(message.content));
    } else if (message.role === "assistant") {
      parts.push("ASSISTANT:");
      parts.push(contentToText(message.content));
    } else if (message.role === "toolResult") {
      if (message.toolName && isCustomToolName(message.toolName)) {
        // Custom tools: don't reference MCP tool name. Present result plainly.
        parts.push(`TOOL RESULT (${message.toolName}):`);
      } else {
        const claudeToolName = message.toolName
          ? mapPiToolNameToClaude(message.toolName)
          : "unknown";
        parts.push(`TOOL RESULT (historical ${claudeToolName}):`);
      }
      parts.push(toolResultContentToText(message.content));
    }
  }

  if (placeholderImageCount > 0) {
    console.warn(
      `[pi-claude-cli] ${placeholderImageCount} image(s) in conversation history could not be included in the prompt`,
    );
  }

  return parts.join("\n") || "";
}

/**
 * Find the index of the last user message in the messages array.
 * Returns -1 if no user message found.
 */
function findFinalUserMessageIndex(messages: any[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

/**
 * Builds the system prompt from the context's systemPrompt field,
 * appending AGENTS.md content if found (walking up from cwd, then global fallback).
 */
export function buildSystemPrompt(
  context: { systemPrompt?: string; messages: any[] },
  cwd: string,
): string {
  const parts: string[] = [];

  // Pi 1.5 carries instructions/section updates in system messages; older hosts
  // provide systemPrompt directly. Let the installed SDK render its transcript.
  const renderSystemPrompt = Reflect.get(piAi, "getCurrentSystemPrompt");
  const systemPrompt =
    context.systemPrompt ??
    (typeof renderSystemPrompt === "function"
      ? renderSystemPrompt(context.messages)
      : "");
  if (systemPrompt) parts.push(systemPrompt);

  // Look for AGENTS.md
  const agentsPath = resolveAgentsMdPath(cwd);
  if (agentsPath) {
    try {
      const content = readFileSync(agentsPath, "utf-8");
      parts.push(content);
    } catch {
      // If we can't read it, skip silently
    }
  }

  return parts.join("\n\n");
}

/**
 * Converts user message content to text.
 * Handles string content and array of content blocks.
 * Image blocks are replaced with placeholder text (HIST-02).
 * Increments the module-level placeholderImageCount for each image.
 */
function userContentToText(content: string | any[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const texts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      texts.push(block.text ?? "");
    } else if (block.type === "image") {
      texts.push("[An image was shared here but could not be included]");
      placeholderImageCount++;
    }
    // Unknown block types silently skipped
  }
  return texts.join("\n");
}

/**
 * Converts assistant message content to text.
 * Handles string content and array of content blocks (text, thinking, toolCall).
 */
function contentToText(content: string | any[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (block.type === "text") return block.text ?? "";
      if (block.type === "thinking") return ""; // Skip thinking — internal reasoning, not conversation
      if (block.type === "toolCall") {
        const isCustom = isCustomToolName(block.name);
        if (isCustom) {
          // Custom tools: don't reference the MCP tool name — Claude might try to re-call it.
          // Just note what was done. The result follows as a TOOL RESULT message.
          const argsStr = block.arguments
            ? JSON.stringify(block.arguments)
            : "{}";
          return `[Used ${block.name} tool with args: ${argsStr}]`;
        }
        const claudeName = mapPiToolNameToClaude(block.name);
        const claudeArgs =
          block.arguments && typeof block.arguments === "object"
            ? translatePiArgsToClaude(
                block.name,
                block.arguments as Record<string, unknown>,
              )
            : block.arguments;
        const argsStr = claudeArgs ? JSON.stringify(claudeArgs) : "{}";
        return `Historical tool call (non-executable): ${claudeName} args=${argsStr}`;
      }
      // Unknown block types are represented as a placeholder
      return `[${block.type}]`;
    })
    .join("\n");
}

/**
 * Converts tool result content to text.
 * Handles string content and array of content blocks.
 * Image blocks get placeholder text (actual image passthrough handled separately).
 */
function toolResultContentToText(content: string | any[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const texts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      texts.push(block.text ?? "");
    } else if (block.type === "image") {
      texts.push("[An image was shared here but could not be included]");
      placeholderImageCount++;
    }
  }
  return texts.join("\n");
}

/**
 * Check if a tool result content array contains image blocks.
 */
function toolResultHasImages(content: string | any[]): boolean {
  if (typeof content === "string" || !Array.isArray(content)) return false;
  return content.some((block) => block.type === "image");
}

/**
 * Walk up from cwd looking for AGENTS.md, fall back to ~/.pi/agent/AGENTS.md.
 */
function resolveAgentsMdPath(cwd: string): string | undefined {
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, "AGENTS.md");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // Fall back to global path
  const globalPath = join(homedir(), ".pi", "agent", "AGENTS.md");
  if (existsSync(globalPath)) return globalPath;

  return undefined;
}
