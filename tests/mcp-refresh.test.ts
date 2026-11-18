import {
  readFileSync,
  existsSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@mariozechner/pi-ai", () => ({ getModels: () => [] }));
vi.mock("../src/process-manager.js", () => ({
  validateCliPresence() {},
  validateCliAuth: () => true,
  killAllProcesses() {},
}));
vi.mock("../src/provider.js", () => ({
  streamViaCli: (_model: any, _context: any, options: any) =>
    options.mcpConfigPath,
}));

const files = new Set<string>();
beforeEach(() => vi.resetModules());
afterEach(() => {
  for (const file of files) rmSync(file, { force: true });
  files.clear();
});

async function host(active: string[]) {
  let provider: any;
  let description = "Initial description";
  let properties = {};
  const pi = {
    on() {},
    registerProvider: (_id: string, config: any) => {
      provider = config;
    },
    getAllTools: () =>
      ["read", "ls", "later", "inactive"].map((name) => ({
        name,
        description,
        parameters: { type: "object", properties },
      })),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
  };
  (await import("../index")).default(pi as any);
  return {
    request: () =>
      provider.streamSimple({}, { messages: [] }, {}) as string | undefined,
    activate: (names: string[]) => {
      active = names;
    },
    update: () => {
      description = "Changed description";
      properties = { query: { type: "string" } };
    },
  };
}
function schema(configPath: string | undefined) {
  expect(configPath).toBeDefined();
  files.add(configPath!);
  const config = JSON.parse(readFileSync(configPath!, "utf-8"));
  const path = config.mcpServers["custom-tools"].args[1];
  files.add(path);
  return { path, tools: JSON.parse(readFileSync(path, "utf-8")) };
}

describe("active tool MCP refresh", () => {
  it("serves the refreshed and empty tool sets through the actual MCP subprocess", async () => {
    const h = await host(["ls"]);
    for (const active of [["ls"], ["later"], []]) {
      h.activate(active);
      const configPath = h.request()!;
      schema(configPath);
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      const output = execFileSync(
        process.execPath,
        config.mcpServers["custom-tools"].args,
        {
          encoding: "utf-8",
          input:
            JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) +
            "\n",
        },
      );
      expect(JSON.parse(output).result.tools.map((t: any) => t.name)).toEqual(
        active,
      );
    }
  });

  it("cleans its schema/config files and can recreate them after cleanup", async () => {
    const h = await host(["ls"]);
    const config = h.request()!;
    const { path } = schema(config);
    const { cleanupMcpConfigFiles } = await import("../src/mcp-config");
    cleanupMcpConfigFiles();
    cleanupMcpConfigFiles();
    expect(existsSync(config)).toBe(false);
    expect(existsSync(path)).toBe(false);
    expect(schema(h.request()).tools.map((t: any) => t.name)).toEqual(["ls"]);
  });
  it("adds discovered tools without exposing inactive tools or losing ls", async () => {
    const h = await host(["read", "ls"]);
    expect(schema(h.request()).tools.map((t: any) => t.name)).toEqual(["ls"]);
    h.activate(["read", "ls", "later"]);
    expect(schema(h.request()).tools.map((t: any) => t.name)).toEqual([
      "ls",
      "later",
    ]);
  });
  it("withdraws the final custom tool instead of advertising stale definitions", async () => {
    const h = await host(["ls"]);
    schema(h.request());
    h.activate(["read"]);
    expect(schema(h.request()).tools).toEqual([]);
  });
  it("can discover tools after an initially empty custom loadout", async () => {
    const h = await host(["read"]);
    h.request();
    h.activate(["read", "later"]);
    expect(schema(h.request()).tools.map((t: any) => t.name)).toEqual([
      "later",
    ]);
  });
  it("refreshes descriptions and parameter schemas without changing tool names", async () => {
    const h = await host(["later"]);
    schema(h.request());
    h.update();
    expect(schema(h.request()).tools).toEqual([
      {
        name: "later",
        description: "Changed description",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
    ]);
  });
  it("keeps stable paths and does not rewrite byte-identical schemas", async () => {
    const h = await host(["ls"]);
    const firstConfig = h.request()!;
    const first = schema(firstConfig);
    const historical = new Date("2001-01-01T00:00:00Z");
    utimesSync(first.path, historical, historical);
    expect(h.request()).toBe(firstConfig);
    expect(schema(firstConfig).path).toBe(first.path);
    expect(statSync(first.path).mtimeMs).toBe(historical.getTime());
  });
  it("restores a deleted schema even when the tool loadout did not change", async () => {
    const h = await host(["ls"]);
    const first = schema(h.request());
    rmSync(first.path);
    expect(schema(h.request()).tools.map((t: any) => t.name)).toEqual(["ls"]);
  });
});
