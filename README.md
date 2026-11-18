# pi-claude-cli

A [pi](https://github.com/mariozechner/pi-coding-agent) extension that routes LLM calls through the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) as a subprocess. Use your Claude Pro/Max subscription as the LLM backend — no API key, no separate billing.

## About this fork

This is [tolmachov's fork](https://github.com/tolmachov/pi-claude-cli) of
[rchern/pi-claude-cli](https://github.com/rchern/pi-claude-cli). The changes live
on `main`; the provider ID remains `pi-claude-cli`.

It adapts [upstream PR #22](https://github.com/rchern/pi-claude-cli/pull/22), with
one intentional difference: an already-active `ls` tool is never deactivated.

- **No global tool activation.** Installing this provider no longer activates
  every registered Pi/MCP tool on session startup, including when using Ollama,
  OpenAI, or another provider.
- **Only the required extra tools.** `grep` and `find` are activated when a Claude
  CLI request runs. Existing active tools, including `ls`, are preserved; other
  inactive tools remain inactive.
- **Active custom tools only.** The schema-only MCP bridge advertises active
  custom tools rather than the entire registered catalog. An active `ls` is
  exposed through this bridge because it has no direct Claude tool mapping.
- **Runtime-only Git installation.** Installation does not invoke the dev-only
  Husky hook setup when Pi omits development dependencies. Developers who want
  the repository's Git hooks can run `npx husky` after installing dev dependencies.

The correctness updates also adapt upstream
[#39](https://github.com/rchern/pi-claude-cli/pull/39),
[#43](https://github.com/rchern/pi-claude-cli/pull/43),
[#33](https://github.com/rchern/pi-claude-cli/pull/33)/[#40](https://github.com/rchern/pi-claude-cli/pull/40),
[#37](https://github.com/rchern/pi-claude-cli/pull/37),
[#28](https://github.com/rchern/pi-claude-cli/pull/28),
[#36](https://github.com/rchern/pi-claude-cli/pull/36),
[#26](https://github.com/rchern/pi-claude-cli/pull/26), and
[#31](https://github.com/rchern/pi-claude-cli/pull/31), without importing cumulative fork histories:

- System prompts use `--append-system-prompt-file`, with isolated, owner-cleaned
  files for concurrent requests. Pi 1.5 transcript instructions are rendered by
  the host SDK; real `.pi` paths are preserved.
- Resume uses CLI-reported session IDs, never Pi's IDs. Changed history,
  system instructions, model, or working directory start a fresh conversation
  with full history. The mapping is in memory, so restarting Pi also replays history.
- Resumed prompts include all new user messages and tool results after the latest
  assistant response, including images, without replaying older results.
- Empty tool argument deltas produce `{}`; malformed nonempty arguments remain
  visible to Pi's validation instead of being silently replaced.
- Active MCP schemas refresh on every request, including metadata changes and
  removal of the final custom tool. Unchanged files are not rewritten; temporary
  MCP files are removed on process exit. Strict-MCP policy is unchanged.
- CLI rejection, process failure, and cancellation return proper failed/aborted
  assistant messages. Authentication honors JSON `loggedIn` while retaining
  exit-status fallback for older CLI output.

Automated tests cover selective activation, active `ls`, MCP refresh (including
an actual schema-server subprocess), prompt regressions, and a real subprocess
stub exercising tool loops, concurrent prompts, errors, and cancellation.
A separate local acceptance run used Pi 1.5.2 to execute a native tool and resume
follow-up turns against that stub. The installed Claude CLI 2.1.326 was checked
for the file-flag contract without contacting a model. No paid/live Claude model
request or other Pi/GSD version has been certified.

## How it works

The extension registers as a custom pi provider exposing all Claude models. Each request spawns a `claude -p` subprocess using the stream-json wire protocol, with `--resume` on compatible follow-up turns to reuse the CLI's session state instead of replaying full history. Claude proposes tool calls, pi executes them natively. Custom pi tools are exposed to Claude via a schema-only MCP server.

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude` on PATH)
- A Claude Pro or Max subscription
- [pi](https://github.com/mariozechner/pi-coding-agent) or [GSD](https://github.com/gsd-build/gsd-2)

## Installation

Install this fork in Pi:

```bash
pi install git:github.com/tolmachov/pi-claude-cli@main
```

Use a full commit SHA instead of `main` to pin an exact revision. Do not load
this fork alongside `npm:pi-claude-cli`: both register the same provider.

For GSD, use the same source in `~/.gsd/agent/settings.json`:

```json
{
  "packages": ["git:github.com/tolmachov/pi-claude-cli@main"]
}
```

Restart Pi/GSD and select a Claude model via `/model`. All Claude models appear
under the `pi-claude-cli` provider.

## Features

- Streams text, thinking, and tool call tokens in real-time
- Maps tool names and arguments bidirectionally between Claude and pi
- Exposes custom pi tools to Claude via MCP (schema-only, no execution)
- Break-early pattern prevents Claude CLI from auto-executing tools
- Session resume via `--resume` avoids history replay on compatible follow-up turns
- Configurable thinking effort, with elevated effort mapping for Opus models
- Custom `thinkingBudgets` are ignored (the CLI accepts effort levels, not token budgets); a warning is emitted once per process
- Cross-platform subprocess management (Windows, macOS, Linux)
- Inactivity timeout and process registry for cleanup

## License

MIT
