import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import spawn from "cross-spawn";
import { expect, it } from "vitest";

const available =
  spawn.sync("claude", ["--version"], {
    encoding: "utf-8",
    timeout: 5000,
  }).status === 0;

// A nonexistent file verifies CLI parsing before auth or any model request.
it.skipIf(!available)(
  "Claude reads --append-system-prompt-file as a file, not literal text",
  () => {
    const missing = join(tmpdir(), `pi-claude-missing-${randomUUID()}.txt`);
    const result = spawn.sync(
      "claude",
      [
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--append-system-prompt-file",
        missing,
        "-p",
        "",
      ],
      {
        encoding: "utf-8",
        timeout: 10000,
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
          ANTHROPIC_API_KEY: "contract-test-no-network",
        },
      },
    );
    expect(result.error ?? null).toBeNull();
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain(missing);
    expect(output).toMatch(/not found/i);
    expect(output).not.toMatch(/unknown option/i);
  },
  15000,
);
