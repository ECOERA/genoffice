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

## Image generation with Nano Banana (built in)

The app ships an MCP server for Google's Nano Banana image models
(`apps/shell/mcp-servers/nano-banana.mjs`, dependency-free, run with the
app's own runtime, so nothing needs installing). One entry and a key from
[aistudio.google.com](https://aistudio.google.com/) enable it:

```json
{
  "mcpServers": {
    "nano-banana": { "builtin": "nano-banana", "env": { "GEMINI_API_KEY": "AIza…" } }
  }
}
```

`builtin` is a DuneOffice extension of the format (Claude Desktop would use
`command`/`args` pointing at the same script). Optional `env` keys:
`NANO_BANANA_MODEL` (default `gemini-3-pro-image-preview`, Nano Banana Pro;
`gemini-2.5-flash-image` is cheaper and faster), `NANO_BANANA_PRESETS`
(a presets JSON; default `nano-banana-presets.json` next to the server)
and `NANO_BANANA_OUTPUT_DIR` outside the app.

The tool `mcp__nano-banana__generate_image` takes a one-sentence `prompt`
and, following the nano-banana-prompt skill, a `spec` object (style,
technical, materials, environment, composition, quality, plus
preserve/change/avoid/include for edits) that is appended to the prompt as
a "Specifications" JSON block, the structure Nano Banana Pro responds to
best. A `preset` (blue_economy, algae_cultivation, regenerative_agriculture,
startup_team, product_tech, longevity_health) fills the spec first; spec
values override it. `aspect_ratio` (16:9 for slides), `image_size` (1K, 2K
default, 4K), `reference_image_urls` (one image = edit, several = blend) and
`use_search` (Google Search grounding) complete the call. In Slides:
"generate a picture of a sandworm at dusk and put it on slide 3" → the
assistant calls the tool, the image lands under `<userData>/mcp-images/`,
and the assistant inserts it with `insert_web_image` using the URL the tool
returned. Docs uses `insert_image`. Google bills each generated image to
the key's account.

**How images travel.** The editors only insert pictures from http(s) URLs
they download themselves, and their SSRF guard blocks private addresses.
The main process therefore serves `<userData>/mcp-images/` from a loopback
port behind a per-run random token, registers that one origin as trusted,
and passes `DUNEOFFICE_IMAGE_DIR` / `DUNEOFFICE_IMAGE_URL_BASE` to every
server it spawns (and to the Claude Code CLI's copies). Images that any
server returns inline are saved the same way and referenced by URL in the
text result, so other image-producing MCP servers work too.

## Video clips with Veo (built in)

`veo.mjs` is the video counterpart: Google Veo through the same Gemini key.

```json
{
  "mcpServers": {
    "nano-banana": { "builtin": "nano-banana", "env": { "GEMINI_API_KEY": "AIza…" } },
    "veo": { "builtin": "veo", "env": { "GEMINI_API_KEY": "AIza…" } }
  }
}
```

Rendering takes one to three minutes, so the server splits the work:
`generate_video` (prompt, 4/6/8 s, 16:9 or 9:16, 720p or 1080p, optional
negative prompt and a reference image as first frame, e.g. a Nano Banana
image) returns a job id at once, and `video_status` waits up to a minute per
call until the clip is ready, downloads it into the media store and returns
its URL. Slides gets a new AI tool, `insert_video`, that embeds the clip
into the page like a manually inserted video (plays in the slideshow, saved
into the .pptx). `VEO_MODEL` defaults to `veo-3.1-fast-generate-preview`;
`veo-3.1-generate-preview` is the higher-quality model. Google bills per
generated second, and an 8 s 720p clip adds roughly 5–15 MB to the deck, so
the defaults are short and 720p.

## Web search and page reading (built in)

`web.mjs` gives every editor's assistant two tools: `search` (titles, URLs,
snippets; optional `count`, `freshness` day/week/month/year and `site`) and
`read_page` (the readable text of a page, in chunks with `offset` for long
pages; HTML, plain text, Markdown and JSON; PDFs are refused). The assistant
searches, reads the pages that matter, and then writes the findings into the
document, sheet or slide with the editor's own tools, citing the URL.

```json
{
  "mcpServers": {
    "web": { "builtin": "web", "env": { "BRAVE_API_KEY": "BSA…", "WEB_SEARCH_COUNTRY": "SE" } }
  }
}
```

Backends, first configured wins, with fallback and a note in the result when
one fails: `BRAVE_API_KEY` (Brave Search API, free plan is plenty),
`SEARXNG_URL` (a self-hosted SearXNG with the JSON format on), and with no
configuration at all DuckDuckGo's HTML endpoint, which needs no key but
answers with a bot check now and then. `WEB_SEARCH_LANG` (e.g. `sv`) and
`WEB_SEARCH_COUNTRY` tune Brave and SearXNG. `read_page` refuses private and
loopback addresses, also after redirects, so a poisoned search result cannot
point the assistant at the machine itself.

The editors' older `web_search` tool (Genspark cloud, Serper or DuckDuckGo
from `packages/ai-search`) stays; it now keeps DuckDuckGo's snippets and
reports a bot-check page as a backend error instead of "no results".

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
