import { describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-ai", () => ({ getModels: () => [] }));
vi.mock("../src/process-manager.js", () => ({
  validateCliPresence: () => {},
  validateCliAuth: () => true,
  killAllProcesses: () => {},
}));
vi.mock("../src/provider.js", () => ({ streamViaCli: () => ({}) }));
vi.mock("../src/mcp-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/mcp-config.js")>()),
  writeMcpConfig: () => "/tmp/pi-claude-tool-activation-test.json",
}));

import registerExtension from "../index";

function createHost(initialTools: string[]) {
  let active = [...initialTools];
  let provider: any;
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const pi = {
    on: (name: string, handler: (...args: any[]) => unknown) => {
      handlers.set(name, handler);
    },
    registerProvider: (_name: string, config: any) => {
      provider = config;
    },
    getAllTools: () =>
      ["read", "bash", "grep", "find", "ls", "mcp__orbit__query"].map(
        (name) => ({
          name,
          description: name,
          parameters: { type: "object", properties: {} },
          exposure: name.startsWith("mcp__") ? "deferred" : "direct",
        }),
      ),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active = [...names];
    },
  };
  registerExtension(pi as any);
  return {
    active: () => active,
    start: () =>
      handlers.get("session_start")?.({}, { model: { provider: "ollama" } }),
    requestClaude: () => provider.streamSimple({}, { messages: [] }, {}),
  };
}

describe("provider tool activation", () => {
  it("leaves the host loadout unchanged when a session starts on another provider", async () => {
    const host = createHost(["read", "bash", "ls"]);
    await host.start();
    expect(host.active()).toEqual(["read", "bash", "ls"]);
  });

  it("adds grep and find for a Claude request without removing an active ls or activating deferred tools", () => {
    const host = createHost(["read", "bash", "ls"]);
    host.requestClaude();
    expect(host.active()).toEqual(["read", "bash", "ls", "grep", "find"]);
  });

  it("keeps ls inactive when the caller did not select it", () => {
    const host = createHost(["read", "bash"]);
    host.requestClaude();
    expect(host.active()).toEqual(["read", "bash", "grep", "find"]);
  });
});
