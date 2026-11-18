/**
 * Pi extension entry point for pi-claude-cli.
 *
 * Registers a custom provider that routes LLM calls through the Claude Code CLI
 * subprocess using stream-json NDJSON protocol.
 */

import { getModels } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { streamViaCli } from "./src/provider.js";
import {
  validateCliPresence,
  validateCliAuth,
  killAllProcesses,
} from "./src/process-manager.js";
import {
  getCustomToolDefs,
  writeMcpConfig,
  cleanupMcpConfigFiles,
} from "./src/mcp-config.js";

// Kill all active Claude subprocesses on process exit to prevent orphans
process.on("exit", () => {
  killAllProcesses();
  cleanupMcpConfigFiles();
});

const PROVIDER_ID = "pi-claude-cli";

// Discovery can change between tool calls, including becoming an empty loadout.
function ensureMcpConfig(pi: ExtensionAPI): string | undefined {
  try {
    return writeMcpConfig(getCustomToolDefs(pi));
  } catch (err) {
    console.warn(
      "[pi-claude-cli] MCP config generation failed, custom tools unavailable:",
      err,
    );
    return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  try {
    // Startup validation
    validateCliPresence(); // throws if CLI not on PATH
    validateCliAuth(); // warns if not authenticated

    const models = getModels("anthropic").map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    }));

    pi.registerProvider(PROVIDER_ID, {
      baseUrl: "pi-claude-cli",
      apiKey: "unused",
      api: "pi-claude-cli",
      models,
      streamSimple: (model, context, options) => {
        // Claude's Grep and Glob map to these off-by-default Pi tools.
        const active = new Set(pi.getActiveTools());
        active.add("grep");
        active.add("find");
        pi.setActiveTools([...active]);

        const configPath = ensureMcpConfig(pi);
        return streamViaCli(model, context, {
          ...options,
          mcpConfigPath: configPath,
        });
      },
    });
  } catch (err) {
    console.error(`[pi-claude-cli] Failed to register provider:`, err);
  }
}
