const fs = require("node:fs");
const readline = require("node:readline");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("stub-cli");
  process.exit(0);
}
if (args[0] === "auth") {
  console.log('{"loggedIn":true}');
  process.exit(0);
}
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const event = (value) => send({ type: "stream_event", event: value });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const input = JSON.parse(line);
  if (input.type !== "user") return;
  const promptFlag = args.indexOf("--append-system-prompt-file");
  fs.appendFileSync(
    process.env.PI_CLAUDE_STUB_LOG,
    JSON.stringify({
      args,
      input,
      system:
        promptFlag < 0
          ? undefined
          : fs.readFileSync(args[promptFlag + 1], "utf-8"),
    }) + "\n",
  );
  send({ type: "system", subtype: "init", session_id: "stub-cli-main" });
  send({
    type: "system",
    subtype: "init",
    session_id: "stub-cli-child",
    parent_tool_use_id: "nested-tool",
  });
  send({
    type: "result",
    subtype: "success",
    session_id: "stub-cli-child",
    parent_tool_use_id: "nested-tool",
  });
  const text = JSON.stringify(input.message.content);
  if (text.includes("MODE_WAIT")) return;
  if (text.includes("MODE_EXIT_ERROR")) {
    process.stderr.write("stub CLI crashed before result\n");
    process.exit(7);
  }
  if (text.includes("MODE_RESULT_ERROR")) {
    send({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["Prompt is too long"],
    });
    return;
  }
  if (text.includes("START_TOOL")) {
    event({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "stub-call-1",
        name: "Read",
        input: {},
      },
    });
    event({
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: '{"file_path":"README.md"}',
      },
    });
    event({ type: "content_block_stop", index: 0 });
    event({ type: "message_delta", delta: { stop_reason: "tool_use" } });
    event({ type: "message_stop" });
    return;
  }
  event({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  event({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "STUB_ANSWER" },
  });
  event({ type: "content_block_stop", index: 0 });
  event({ type: "message_delta", delta: { stop_reason: "end_turn" } });
  event({ type: "message_stop" });
  send({ type: "result", subtype: "success", session_id: "stub-cli-main" });
});
