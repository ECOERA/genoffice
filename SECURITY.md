# Security Policy

## Reporting a Vulnerability

Please report suspected vulnerabilities privately via GitHub's
[private vulnerability reporting](https://github.com/genspark-ai/genoffice/security/advisories/new)
on this repository. Do not open public issues for security reports. We aim to
acknowledge reports within 72 hours.

## Process Security Posture

All application windows run with the full Electron renderer lockdown:

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` for every
  document window and tab view (docs, sheets, slides, pdf, markdown, shell, updater).
- Renderers reach the main process only through typed, validated IPC channels
  (payloads are schema-checked in the main process; sheets uses zod end to end).
- Every `shell.openExternal` call goes through a single shared gate
  (`@genoffice/electron-utils` → `safeExternalUrl`) that parses the URL and
  enforces a protocol allowlist (http/https; pdf link annotations additionally
  allow mailto). `file:`, `javascript:`, and custom schemes are always rejected.
- No API keys are hardcoded. AI requests are proxied through the signed-in
  account by default; user-supplied keys stay in the OS-level settings store.

## Threat Model: AI-Generated Layout Scripts (slides)

The slides AI can adjust slide layouts by emitting a small script that is
parsed with Acorn and evaluated by a constrained AST interpreter
(`apps/slides/src/renderer/ai/layout-script-interpreter.ts`). The source looks
like a small, synchronous subset of JavaScript for model compatibility, but it
is not passed to `eval`, `Function`, a VM context, a worker, or the JavaScript
engine as executable source.

**What the script can do by design:** read prototype-free JSON copies of
`els`/`canvas`, perform bounded arithmetic/control flow, use explicitly
implemented string/array/regular-expression/Math helpers, and call
`setBox/moveBy/resizeBy/setText/setStyle/setFill/setStroke/log`. Every edit
primitive validates its arguments (element existence, read-only flags, finite
numbers, hex colors) and writes only into an op buffer that is applied through
the same command pipeline as manual edits.

**Interpreter boundary:**

1. Identifiers resolve only in interpreter-owned lexical scopes seeded with the
   documented data and callables. There are no ambient globals, module loader,
   DOM, network, IPC bridge, timers, process APIs, or dynamic code primitives.
2. Property reads are dispatched by value type. Data objects expose own JSON
   fields only; arrays, strings, and regexes expose a small method allowlist.
   Host prototypes and function properties are never traversed, including
   through computed property names.
3. Calls accept only interpreter-created functions or explicit builtins. A host
   function obtained through a constructor/prototype chain cannot be
   represented.
4. Inputs and values crossing into edit primitives are recursively copied as
   JSON-like, prototype-free data. Errors discard all buffered operations;
   logs are capped.
5. Execution has statement/expression and call-depth limits to bound runaway
   loops or recursion. Regular expressions run on an interpreter-owned matcher
   with its own step budget (a supported subset; no native backtracking), so a
   catastrophic pattern cannot stall the renderer past those limits.

The Electron renderer sandbox remains defense in depth, but it is not the
layout-script security boundary. The interpreter is designed so a layout
script cannot obtain renderer capabilities in the first place.

If you find a way for a layout script to reach anything beyond the injected
primitives (network, storage, IPC channels not reachable by design, or the
main process), that is a vulnerability — please report it.

## Threat Model: Rendering AI-Generated HTML (slides export)

The HTML-to-pptx export pipeline renders AI-generated HTML in a hidden
`BrowserWindow`. That window is treated as hostile content: full renderer
lockdown (`sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`),
no preload script, no IPC surface — the main process drives it exclusively
through `executeJavaScript` and destroys it under a watchdog timeout.

## Out of Scope

- The cloud AI services this client talks to are operated separately and are
  not part of this repository; issues with them should be reported through the
  service provider's channels.
- Vulnerabilities that require an already-compromised machine or a modified
  binary. This includes the deliberate environment-variable override points
  for local development (`GSK_CLI_PATH`, `XLSX_SIDECAR_PATH`): setting them
  requires control of the process environment, which is equivalent to code
  execution on the machine.

## Threat Model: Claude Code as an AI Provider

The `claude-code` provider runs the document agents on the user's own Claude
Code subscription. The bridge (`apps/docs/src/main/claude-code.ts`) drives the
locally installed `claude` CLI through the official Claude Agent SDK; it is the
same mechanism the CLI itself uses, and the only sanctioned one.

**Credentials.** GenOffice never reads, stores or forwards a Claude credential.
The SDK spawns the user's own `claude` binary, which finds its OAuth token in the
OS keychain by itself. `HOME` is never overridden (doing so would relocate the
keychain lookup); a future multi-account feature must use `CLAUDE_CONFIG_DIR`.
Nothing about the session is sent anywhere except by the CLI to Anthropic's
API, as with any Claude Code use.

**What the model can do.** Each document tab gets its own CLI session whose
world is that document:

- The system prompt replaces Claude Code's coding-agent preset entirely, and
  `settingSources: []` keeps the user's `CLAUDE.md`, skills, hooks and
  permission rules out of the session. The user's claude.ai connectors (mail,
  drive, calendar, …) are not fetched into it (`disableClaudeAiConnectors`).
- Claude Code's built-in tools are disallowed (`Bash`, `Edit`, `Write`, `Glob`,
  `Grep`, `WebFetch`, `WebSearch`, `Task`, `ToolSearch`, …). The only built-in
  the session may use is `Read`, and the permission callback allows it solely
  for the session's own persisted tool results under a private scratch
  directory; every other path is denied.
- The document tools are exposed as an in-process MCP server. They execute in
  the renderer, in order, against the open document — exactly as for every
  other provider — never in the main process and never on the filesystem. The
  permission callback independently denies any tool outside the turn's own
  set, so a newly added built-in cannot slip through an outdated list.
- The session's working directory is an empty scratch directory under the OS
  temp folder, never the user's repository or documents.

**Lifetime.** A session ends with the tab that owns it, on stop it is
interrupted rather than kept running, and every session is ended when the app
quits, so no `claude` child outlives GenOffice. Large tool results the bridge
persisted for the model are removed with the session.

**What the user is trusting.** Turns consume the user's Claude Code allowance,
and the CLI's own transcript of the session is kept where Claude Code keeps all
its sessions (`~/.claude/projects/…`), under the scratch directory's project
key. That transcript contains the document content the model saw.
