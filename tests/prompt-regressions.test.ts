import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPrompt,
  buildResumePrompt,
  buildSystemPrompt,
} from "../src/prompt-builder";

const text = (value: unknown) => JSON.stringify(value);

describe("incremental conversation prompts", () => {
  it("sends only results after the last assistant, not the old question and results", () => {
    const prompt = buildResumePrompt({
      messages: [
        { role: "user", content: "OLD_QUESTION" },
        { role: "assistant", content: "First read" },
        { role: "toolResult", toolName: "read", content: "OLD_RESULT" },
        { role: "assistant", content: "Second read" },
        { role: "toolResult", toolName: "read", content: "NEW_RESULT" },
      ],
    });
    expect(text(prompt)).toContain("NEW_RESULT");
    expect(text(prompt)).not.toContain("OLD_RESULT");
    expect(text(prompt)).not.toContain("OLD_QUESTION");
  });

  it("does not resend an earlier image or lose subsequent tool output", () => {
    const prompt = buildResumePrompt({
      messages: [
        {
          role: "user",
          content: [
            { type: "image", data: "OLD_IMAGE", mimeType: "image/png" },
          ],
        },
        { role: "assistant", content: "Read" },
        { role: "toolResult", toolName: "read", content: "RESULT_AFTER_IMAGE" },
      ],
    });
    expect(text(prompt)).toContain("RESULT_AFTER_IMAGE");
    expect(text(prompt)).not.toContain("OLD_IMAGE");
  });

  it.each([false, true])(
    "keeps question and injected user context in either order (%s)",
    (reverse) => {
      const users = [
        { role: "user", content: "HUMAN_QUESTION" },
        { role: "user", content: "EXTENSION_CONTEXT" },
      ];
      const prompt = buildResumePrompt({
        messages: [
          { role: "assistant", content: "Earlier" },
          ...(reverse ? users.reverse() : users),
        ],
      });
      expect(text(prompt)).toContain("HUMAN_QUESTION");
      expect(text(prompt)).toContain("EXTENSION_CONTEXT");
    },
  );

  it("keeps result images and every new user message, including images", () => {
    const prompt = buildResumePrompt({
      messages: [
        { role: "assistant", content: "Call tool" },
        {
          role: "toolResult",
          toolName: "screenshot",
          content: [
            { type: "text", text: "TOOL_TEXT" },
            { type: "image", data: "TOOL_IMAGE", mimeType: "image/png" },
          ],
        },
        {
          role: "user",
          content: [
            { type: "image", data: "USER_IMAGE", mimeType: "image/png" },
          ],
        },
        { role: "user", content: "FOLLOW_UP_CONTEXT" },
      ],
    });
    expect(text(prompt)).toContain("TOOL_TEXT");
    expect(text(prompt)).toContain("TOOL_IMAGE");
    expect(text(prompt)).toContain("USER_IMAGE");
    expect(text(prompt)).toContain("FOLLOW_UP_CONTEXT");
  });

  it("returns no new input when the assistant is already the last message", () => {
    expect(
      buildResumePrompt({
        messages: [
          { role: "user", content: "Old" },
          { role: "assistant", content: "Answered" },
        ],
      }),
    ).toBe("");
  });

  it("replays the entire conversation on a cold session, even after a custom tool", () => {
    const prompt = buildPrompt({
      messages: [
        { role: "user", content: "ORIGINAL_REQUIREMENT" },
        { role: "assistant", content: "IMPORTANT_PRIOR_FINDING" },
        {
          role: "toolResult",
          toolName: "first_tool",
          content: "FIRST_TOOL_RESULT",
        },
        { role: "assistant", content: "Second call" },
        {
          role: "toolResult",
          toolName: "second_tool",
          content: "SECOND_TOOL_RESULT",
        },
      ],
    });
    for (const expected of [
      "ORIGINAL_REQUIREMENT",
      "IMPORTANT_PRIOR_FINDING",
      "FIRST_TOOL_RESULT",
      "SECOND_TOOL_RESULT",
    ])
      expect(text(prompt)).toContain(expected);
  });
});

it("preserves actual .pi paths in AGENTS instructions", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-agents-prompt-"));
  const instruction =
    "Read ~/.pi/agent/skills/example/SKILL.md and .pi/config.json";
  try {
    writeFileSync(join(cwd, "AGENTS.md"), instruction);
    expect(buildSystemPrompt({ messages: [] }, cwd)).toBe(instruction);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
