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

The fork includes regression tests for startup isolation, selective activation,
active `ls` preservation, and MCP tool filtering. Local verification used Pi
1.5.2; it did not certify other Pi/GSD versions or a live Claude CLI request.

## How it works

The extension registers as a custom pi provider exposing all Claude models. Each request spawns a `claude -p` subprocess using the stream-json wire protocol, with `--resume` on follow-up turns to reuse the CLI's session state instead of replaying full history. Claude proposes tool calls, pi executes them natively. Custom pi tools are exposed to Claude via a schema-only MCP server.

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
- Session resume via `--resume` eliminates history replay on follow-up turns
- Configurable thinking effort with elevated budgets for Opus models
- Cross-platform subprocess management (Windows, macOS, Linux)
- Inactivity timeout and process registry for cleanup

## License

MIT
