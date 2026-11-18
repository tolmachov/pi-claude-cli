import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamViaCli } from "../src/provider";
import { killAllProcesses } from "../src/process-manager";

let cwd: string;
let log: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-cli-integration-"));
  log = join(cwd, "calls.jsonl");
  const fixture = fileURLToPath(
    new URL("./fixtures/claude.cjs", import.meta.url),
  );
  const windows = process.platform === "win32";
  writeFileSync(
    join(cwd, windows ? "claude.cmd" : "claude"),
    windows
      ? `@"${process.execPath}" "${fixture}" %*\r\n`
      : `#!${process.execPath}\nrequire(${JSON.stringify(fixture)});\n`,
    { mode: 0o700 },
  );
  writeFileSync(join(cwd, "AGENTS.md"), "TEST_AGENT_INSTRUCTIONS");
  vi.stubEnv("PATH", `${cwd}${delimiter}${process.env.PATH ?? ""}`);
  vi.stubEnv("PI_CLAUDE_STUB_LOG", log);
});
afterEach(() => {
  killAllProcesses();
  vi.unstubAllEnvs();
  rmSync(cwd, { recursive: true, force: true });
});
const model = {
  id: "stub-model",
  provider: "pi-claude-cli",
  api: "pi-claude-cli",
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as any;
const calls = () =>
  readFileSync(log, "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
async function result(context: any, options: any = {}) {
  const stream = streamViaCli(model, context, { cwd, ...options });
  let timeout: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      stream.result(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("stub response timed out")),
          1500,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout!);
  }
}

describe("real subprocess and event-stream integration (no LLM)", () => {
  it("completes a native tool loop and preserves injected context without replaying the image", async () => {
    const user = {
      role: "user",
      content: [
        { type: "text", text: "START_TOOL" },
        { type: "image", data: "ORIGINAL_IMAGE", mimeType: "image/png" },
      ],
    };
    const context = {
      systemPrompt: "SYSTEM_FROM_PI",
      messages: [user] as any[],
    };
    const options = { sessionId: "native-tool-loop" };
    const toolCall = await result(context, options);
    expect(toolCall.stopReason).toBe("toolUse");
    expect(toolCall.content[0]).toMatchObject({
      type: "toolCall",
      name: "read",
      arguments: { path: "README.md" },
    });
    context.messages.push(toolCall, {
      role: "toolResult",
      toolName: "read",
      toolCallId: "stub-call-1",
      content: "FIRST_TOOL_RESULT",
    });
    const answer = await result(context, options);
    expect(calls()[1].args).toContain("--resume");
    expect(answer.stopReason).toBe("stop");
    context.messages.push(
      answer,
      { role: "user", content: "HUMAN_FOLLOW_UP" },
      { role: "user", content: "INJECTED_CONTEXT" },
    );
    await result(context, options);
    const [first, second, third] = calls();
    expect(first.system).toContain("SYSTEM_FROM_PI");
    expect(first.system).toContain("TEST_AGENT_INSTRUCTIONS");
    expect(second.args).toContain("--resume");
    expect(second.args[second.args.indexOf("--resume") + 1]).toBe(
      "stub-cli-main",
    );
    expect(second.system).toBeUndefined();
    expect(JSON.stringify(second.input)).toContain("FIRST_TOOL_RESULT");
    expect(JSON.stringify(second.input)).not.toContain("ORIGINAL_IMAGE");
    expect(third.args).toContain("--resume");
    expect(JSON.stringify(third.input)).toContain("HUMAN_FOLLOW_UP");
    expect(JSON.stringify(third.input)).toContain("INJECTED_CONTEXT");
    expect(JSON.stringify(third.input)).not.toContain("FIRST_TOOL_RESULT");
  });
  it("keeps concurrent system prompt files isolated until each child reads them", async () => {
    const messages = [{ role: "user", content: "Concurrent request" }];
    await Promise.all([
      result({ systemPrompt: "FIRST_CONCURRENT", messages }),
      result({ systemPrompt: "SECOND_CONCURRENT", messages }),
    ]);
    const prompts = calls().map((c) => c.system);
    expect(prompts.some((p) => p.includes("FIRST_CONCURRENT"))).toBe(true);
    expect(prompts.some((p) => p.includes("SECOND_CONCURRENT"))).toBe(true);
  });

  it("returns a failed AssistantMessage for a structured CLI rejection", async () => {
    const message = await result({
      messages: [{ role: "user", content: "MODE_RESULT_ERROR" }],
    });
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("Prompt is too long");
  });
  it("does not report success when stdout closes before a failing process close event", async () => {
    const message = await result({
      messages: [{ role: "user", content: "MODE_EXIT_ERROR" }],
    });
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("stub CLI crashed before result");
  });
  it("finishes an in-flight cancellation as aborted, not successful", async () => {
    const controller = new AbortController();
    const pending = result(
      { messages: [{ role: "user", content: "MODE_WAIT" }] },
      { signal: controller.signal },
    );
    controller.abort();
    expect((await pending).stopReason).toBe("aborted");
  });
  it("settles an already-aborted request without spawning a CLI", async () => {
    const controller = new AbortController();
    controller.abort();
    const message = await result(
      { messages: [{ role: "user", content: "MODE_WAIT" }] },
      { signal: controller.signal },
    );
    expect(message.stopReason).toBe("aborted");
    expect(existsSync(log)).toBe(false);
  });
});
