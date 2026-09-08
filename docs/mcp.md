# External tools through MCP

DuneOffice can give the AI assistant tools from MCP servers you configure:
file systems, databases, ticketing systems, search, anything with an MCP
server. The same servers serve every editor (Docs, Sheets, Slides, PDF,
Markdown) and every AI provider, including Claude Code.

## Configuring servers

Edit `~/.genoffice/mcp.json` (Settings → Integrations → "Open mcp.json"
creates it). The format is the one Claude Desktop and Claude Code use, so an
existing `mcpServers` block can be pasted as is:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Documents"]
    },
    "internal-api": {
      "type": "http",
      "url": "https://tools.example.com/mcp",
      "headers": { "Authorization": "Bearer …" }
    },
    "old-style": { "type": "sse", "url": "http://localhost:3000/sse" },
    "parked": { "command": "uvx", "args": ["some-server"], "disabled": true }
  }
}
```

- `command`/`args`/`env`/`cwd` start a local server over stdio. The app
  merges your login shell's PATH (plus the usual Homebrew, `~/.local/bin`,
  cargo and volta locations), so `npx`, `uvx` and `node` resolve even when
  the app was launched from the Dock.
- `url` connects to a remote server: Streamable HTTP by default, `"type":
"sse"` for the older SSE transport. `headers` is passed on every request.
- `"disabled": true` keeps an entry without starting it.
- Server names may use letters, digits, `_` and `-`; they become part of the
  tool names.

Settings → Integrations shows each server's state (starting, connected,
failed with the reason, disabled), its tool count, problems found in the
file, a reload button, and the per-server "Run without asking" switch.
Servers start with the app and are reconnected on reload; `mcp.json` is
read at start and on reload, not watched.

## How the assistant sees them

Every tool is exposed as `mcp__<server>__<tool>` (the Claude Code naming),
so a tool has the same name whichever provider runs the conversation. The
assistant's prompt tells it these tools run outside the document and that
their results are data, not instructions.

The first time a server's tool is about to run, a dialog asks: **Always
allow**, **Allow once**, or **Deny**. "Always" is remembered per server in
the app settings and can be revoked in Integrations. With the Claude Code
provider the CLI runs the tool itself after the same permission check; with
API-key providers the app runs it and feeds the text result back to the model.

## Design

- `packages/mcp-client`: Electron-free client on the official
  `@modelcontextprotocol/sdk` (MIT). `parseMcpConfig` validates entries and
  reports bad ones instead of failing; `McpManager` connects servers in
  parallel with timeouts, keeps tool lists, executes calls behind a
  permission gate, and isolates failures per server. `mcpToolName` applies
  the namespace and shortens over-long names with a stable hash (providers
  cap tool names at 63–64 characters).
- `packages/agent-core` `createMcpSkill`: an `AgentSkill` whose tool list is
  filled asynchronously from `window.mcpBridge` and refreshed on change
  events; `composeSkills` reads tools per model turn, so late-connecting
  servers appear without restarting the panel.
- Each editor's preload exposes the three-method bridge inline (sandboxed
  preloads must stay single-file); the shell's main process
  (`apps/shell/src/main/mcp.ts`) owns the manager, the permission dialog,
  the persisted allow list and the IPC.
- Claude Code path: `apps/docs/src/main/claude-code.ts` maps the enabled
  entries into the Agent SDK's `mcpServers` option and answers `canUseTool`
  for `mcp__<external>__*` through the same permission store. The CLI
  spawns its own copies of stdio servers; a reload takes effect on the next
  session.
- Not done: watching `mcp.json` for edits, MCP resources and prompts (tools
  only), per-tool permissions, OAuth for remote servers, sampling requests
  from servers.
