import { expect, it, vi } from "vitest";
const sdk = vi.hoisted(() => ({
  render: vi.fn(() => "SDK base instructions\nUpdated skills section"),
}));
vi.mock("@mariozechner/pi-ai", () => ({ getCurrentSystemPrompt: sdk.render }));
import { buildSystemPrompt } from "../src/prompt-builder";

it("uses the host SDK to render system instructions carried by TranscriptContext", () => {
  const context = {
    messages: [
      { role: "system", content: "Base", sections: { skills: "Updated" } },
      { role: "user", content: "Hi" },
    ],
  };
  const prompt = buildSystemPrompt(context, process.cwd());
  expect(sdk.render).toHaveBeenCalledWith(context.messages);
  expect(prompt).toContain("SDK base instructions\nUpdated skills section");
});
