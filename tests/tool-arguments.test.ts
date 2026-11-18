import { describe, expect, it } from "vitest";
import { createEventBridge } from "../src/event-bridge";

function toolBridge() {
  const bridge = createEventBridge(
    { push() {}, end() {} } as any,
    {
      id: "test",
      provider: "pi-claude-cli",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } as any,
  );
  bridge.handleEvent({
    type: "content_block_start",
    index: 0,
    content_block: {
      type: "tool_use",
      name: "mcp__custom-tools__gateway",
      id: "call-1",
      input: {},
    },
  } as any);
  return bridge;
}

describe("tool argument boundaries", () => {
  it.each([
    [undefined, {}],
    [" \n ", {}],
    ["{}", {}],
    ['{"query":"x"}', { query: "x" }],
    ['{"incomplete":', '{"incomplete":'],
    ["null", "null"],
    ["[]", "[]"],
    ["123", "123"],
    ['"text"', '"text"'],
  ])("keeps %j distinct from malformed arguments", (payload, expected) => {
    const bridge = toolBridge();
    if (payload !== undefined)
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: payload },
      } as any);
    bridge.handleEvent({ type: "content_block_stop", index: 0 });
    expect((bridge.getOutput().content[0] as any).arguments).toEqual(expected);
  });

  it.each(["null", "[]", "123"])(
    "does not expose non-object %s as streaming arguments",
    (payload) => {
      const bridge = toolBridge();
      bridge.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: payload },
      } as any);
      expect((bridge.getOutput().content[0] as any).arguments).toEqual({});
    },
  );
});
