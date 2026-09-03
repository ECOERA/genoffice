# Claude Code as an AI provider

Status: working prototype on this branch. The bridge is proven end-to-end against
a real `claude` CLI (7 integration tests, ~2 min including a forced
compaction), the whole suite typechecks and lints clean, and the docs tests pass.
The four P0 correctness items (compaction, prompt changes, tab-close teardown,
cancel) are resolved; what remains in [Outstanding](#outstanding) is fidelity,
platform coverage (no Windows support) and UX. The macOS packaged build,
previously the biggest unknown, is verified end to end.

The provider lets a user drive GenOffice's document agents with the Claude Code
subscription they already have, instead of an API key. Nothing here ever reads a
credential — the Agent SDK spawns the user's own `claude` binary, which finds its
own OAuth token in the OS keychain.

## Why this is not just another provider entry

Every provider in `packages/ai-provider` is a naked model behind an HTTP endpoint.
The renderer's `AgentLoop` owns the conversation: it asks for one turn, receives
`tool_use`, executes the tools against the ProseMirror document, and comes back
with results. The provider layer is stateless.

Claude Code is not a model. It is a second agent harness with its own loop, its
own context management and its own credentials. Two harnesses cannot both drive.

The naive resolutions both lose something big:

- **Let Claude Code own the loop.** Tool execution has to move out of the renderer
  or round-trip to it over new IPC, and GenOffice's snapshots, compaction,
  degenerate-loop guards, `verifyResponse` and tool-card UI are all bypassed.
- **Use Claude Code as a model.** The CLI has no mode that returns raw `tool_use`
  blocks for arbitrary caller-supplied schemas. It executes its own tools.

### The design that keeps both

Claude Code's loop is made to _look like_ a sequence of ordinary GenOffice turns.
`apps/docs/src/main/claude-code.ts:1-31` carries this as a header comment.

1. A turn arrives on `ai:stream`. With no session for this window we start one
   `query()` over a pushable input stream and keep it open for the conversation.
2. Assistant text and thinking stream out as ordinary `delta` / `reasoning`
   chunks. The AI panel renders them exactly as for any other provider.
3. When Claude Code wants a tool, `canUseTool` fires in the main process
   (`claude-code.ts:437`). We execute nothing there — the tools edit a document
   that lives in the renderer. Instead we emit the call as a `tool-call` chunk
   followed by `done` with `stopReason: 'tool_use'`, which is precisely how a
   tool-calling turn ends for every other provider. **The permission callback
   then parks.**
4. The `AgentLoop` executes the tool and opens the next turn carrying the result.
   We match it to the parked call by id (`deliverToolResults`), resolve it, and
   the in-process MCP handler returns it to Claude Code — which never notices it
   was suspended.

The parking trick is the whole idea. `canUseTool` receives the `toolUseID` and is
documented to have no deadline ("permission prompts have no park deadline"), so
it is the one place where a turn can be suspended mid-flight and resumed from a
different IPC request.

Carrying the id from `canUseTool` to the MCP handler needs a channel, because the
handler is not told which call it serves. We return it in `updatedInput` as
`__genoffice_call_id` (`claude-code.ts:47`) and declare it in the generated zod
shape so validation cannot strip it. A FIFO of unclaimed ids is the fallback for
CLI versions that drop the rewrite.

## What exists

### The bridge

`apps/docs/src/main/claude-code.ts` — 582 lines, no Electron import, so it is unit
testable outside a window.

| Piece                               | Notes                                                                                                                                                                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `findClaudeBinary()` `:144`         | Checks `~/.local/bin`, `~/.claude/local`, Homebrew, `/usr/local/bin`, then PATH. A packaged app launched from the dock inherits no login shell — the same reason the proxy setting had to become explicit in issue #45. |
| `claudeCodeVersion()` `:162`        | `claude --version` probe; drives test skipping and (eventually) the settings pane.                                                                                                                                      |
| `zodTypeFor` / `zodShapeFor` `:182` | JSON Schema → zod raw shape. The SDK's `tool()` takes zod; every GenOffice skill emits JSON Schema.                                                                                                                     |
| `makePushable()`                    | The input stream. One `query()` stays open across turns; new user messages are pushed in rather than starting a new session.                                                                                            |
| `runClaudeCodeTurn()` `:351`        | The entry point. Continuation → new user turn → new session, in that order.                                                                                                                                             |
| `cancelClaudeCodeSession()` `:331`  | Resolves every parked call with an error, ends input, aborts.                                                                                                                                                           |

Session options worth knowing:

```ts
systemPrompt: { type: 'custom', prompt: turn.system },   // :491 — replaces the coding-agent preset
settingSources: [],                                       // :499 — the user's CLAUDE.md and skills stay out
disallowedTools: DISALLOWED_BUILTINS,                     // :61  — Bash/Read/Write/… off
pathToClaudeCodeExecutable: binary,                       // the user's own login, untouched
includePartialMessages: true,                             // token-level streaming
```

Defence in depth on tools: `disallowedTools` is a hand-maintained list, but
`canUseTool` independently denies anything not in the turn's own tool set, so a
newly added built-in cannot slip through by being absent from the list.

### Shared registry

| File                                  | Change                                                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `packages/ai-provider/src/types.ts:5` | `'claude-code'` in `AiProviderId`                                                                                           |
| `types.ts:46`                         | new `AiProviderMeta.keyless`                                                                                                |
| `providers.ts:44`                     | provider meta; models are the CLI's own aliases (`default`/`opus`/`sonnet`/`haiku`) so no catalogue has to track the vendor |
| `providers.ts:225`                    | `activeProvider()` — a keyless provider with an empty key is configured, not half-filled                                    |
| `registry.ts:129`                     | adapter, `auth: 'cli'`, `protocol: 'claude-code'`                                                                           |
| `stream.ts:38`                        | `streamForProvider` throws `AiHostOnlyProviderError`: only a host that can spawn processes may serve this                   |
| `chat.ts:42`                          | `chatForProvider` returns it as a failed reply rather than throwing                                                         |

### Wiring and UI

- `apps/docs/src/main/docs-main.ts:2685` — the branch, placed **before** the
  `!config?.apiKey` gate at `:2708`. 38 lines.
- `docs-main.ts:2625` — `claudeCodeSessionOf`, because a CLI-backed run outlives
  the single turn that started it; cancelling must reach the session.
- `apps/shell/src/renderer/src/SettingsModal.tsx` — `isKeyless` replaces
  `isGenspark` at the three places that hid the key field.
- `provider-logos.tsx`, `strings.ts` (`setAiCliHint`, 19 locales),
  `preload/index.ts` (skip endpoint resolution for keyless providers).

### Reach: it already covers more than Docs

Worth stating plainly, because it corrects an earlier assumption. In the shipped
**shell**, `registerAiIpc` is imported from `docs-main` and registered exactly
once for every window type (`apps/shell/src/main/index.ts:106,4158`). Sheets'
and Slides' own AI handlers are only registered when those apps run standalone.

So inside the suite, **Docs, Sheets, Slides, PDF and Markdown all already route
through the patched handler**. The remaining gates at `sheets-main.ts:3073`,
`:3109` and `slides/ai-ipc.ts:156` only matter for `npm run dev:sheets` /
`dev:slides`.

The schema converter was audited against every `inputSchema` in the repo: the
whole suite uses only `type`, `properties`, `required`, `items`, `enum` and
`description`. Nothing uses `anyOf`, `oneOf`, `$ref`, `nullable` or numeric
bounds. The converter covers the full surface as it stands today.

### Packaged build

`GenOffice-0.8.0-arm64.dmg`, 157 MB, built from this branch with
`electron-builder --mac --arm64`. Unsigned: the build host holds no signing
identity, so the app is ad-hoc signed and needs
`xattr -d com.apple.quarantine` (or right-click → Open) on any machine it is
copied to.

The open risk was bundling. Vite has no `externalizeDepsPlugin` entry for the
SDK in the shell, so Rollup inlines it into `out/main/sdk-*.js` (1.8 MB) — and
the SDK normally resolves a platform-native companion package plus its own
`manifest.json` and `bridge.mjs` from `node_modules`, none of which a packaged
app ships. Static analysis of the shipped chunk found no surviving reference to
any of them, and no `require("zod")` or `require("@anthropic-ai/claude-agent-sdk")`
in any main chunk — both are fully inlined, so nothing is resolved at runtime.
The keychain lookup survives intact: `execFile("security", ["find-generic-password", …])`
is still there, which is how the spawned CLI's OAuth login is found.

Static analysis is not proof, so the chunk was extracted straight out of
`app.asar` and driven from `/tmp`, outside any `node_modules`:

```
[ok] bundled chunk loaded, exports intact
[ok] canUseTool parked: mcp__genoffice__get_document_context toolu_01NS5S…
[ok] MCP handler invoked, call id = toolu_01NS5S…
[ok] result: success
  → "The open document, q3.docx, has 431 words (across 12 blocks)."
[PASS] bundled SDK spawned the CLI, parked a tool call, and used the result
```

The Sheets Rust sidecar ships as a separate 8.2 MB arm64 binary in
`Contents/Resources/native/`. It was exercised through its own stdio protocol
against a generated workbook, using the binary inside the app bundle: `open`
returned the sheet metadata and `read_range` returned both values and
`=AVERAGE(B2:B4)`. With `cargo` on PATH the previously-skipped Sheets suite is
green too — 161 Rust tests alongside 2262 JS tests — so the repo now has no
excluded tests.

### Evidence

`apps/docs/tests/claude-code-bridge.test.ts` runs against the real CLI and skips
where none is installed.

```
✓ finds the CLI the SDK will spawn
✓ streams a plain answer back as delta chunks
✓ parks a tool call, delivers the result, and finishes the run
3 passed (10.4s)   — against claude 2.1.259
```

The third is the one that matters: turn 1 yields a `tool-call` plus
`done{stopReason:'tool_use'}`; turn 2 sends back exactly what the `AgentLoop`
would; the model uses the injected figure in its answer. That closes the loop.

Gates: `typecheck` 0 errors across all workspaces · `lint` 0 errors (12
pre-existing warnings) · `prettier` clean (the repo's 63 warnings exist on HEAD
too) · docs suite 1505 tests · shell and docs both build. The only red in
`npm test` is the Sheets Rust sidecar, which needs `cargo` and is unrelated.

---

## Outstanding

### P0 — correctness

**1. History compaction silently corrupts the session. — RESOLVED**
`AgentLoop.summarizeViaLlm` (`packages/agent-core/src/loop.ts`) does not use a
separate channel: it calls `transport.stream` with `tools: []`, a different
system prompt (`SUMMARIZE_SYSTEM`) and the folded history. The bridge sees a turn
on a live session whose last message is a plain user message, so it would push
`"Compress the conversation above as instructed."` straight into Claude Code's
running session: `SUMMARIZE_SYSTEM` discarded, the summary produced from Claude
Code's own view rather than the folded history, and the instruction left in the
transcript. Plausible nonsense rather than an error.

Fix as shipped — the app stops compacting and Claude Code's own auto-compaction
carries the session:

- `AiProviderMeta.managesContext` marks claude-code as owning the conversation;
  `providerManagesContext(settings)` judges it on the _effective_ provider (a
  broken claude-code selection that falls back to genspark keeps compaction on).
- `AgentLoopOptions.compaction` also accepts a getter, re-read at every decision
  point, so the loops built once per panel follow a provider switch. All five
  renderers (and the Slides QC loop) pass
  `compaction: () => providerManagesContext(settings) ? false : undefined`.
- The bridge states `settings.autoCompactEnabled: true` explicitly and reports
  each compaction back as a `compaction` stream chunk (`AiCompaction`: trigger,
  pre/post token counts from the CLI's `compact_boundary` message, summary from
  its `PostCompact` hook). The IPC transport forwards it as `onCompaction`; the
  loop exposes it as an event. No UI consumes it yet.
- `ClaudeCodeTurn.autoCompactWindow` pins the window through the CLI's
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` environment variable. Measured against
  2.1.259: the CLI clamps it to [100K, 1M] tokens, compacts at window minus a
  ~33K summary buffer, and the `autoCompactWindow` _settings_ key has no effect
  on an SDK session. With no pin, a `claude-opus-5[1m]` account compacts at
  ~967K tokens, so a document session practically never compacts on its own.
- `/compact` sent as a user message also works (trigger `manual`); nothing uses
  it yet.

Tests: loop tests for the getter and the event, transport test for the chunk,
provider test for the helper, and a bridge integration test that forces an
auto-compaction with the 100K window and checks the session survives it with a
parked tool call on the far side.

**2. The system prompt is pinned at session creation. — RESOLVED**
`turn.system` is read once when the CLI session starts. The `AgentLoop` re-sends
it every turn, and it genuinely varies: `composeSkills` exposes `systemPrompt`
as a getter keyed on runtime capability (gsk login state, tool availability),
and `systemSuffix: aiLangDirective` follows the UI language. Switch language
mid-conversation and the directive went stale.

Fix as shipped: the session remembers the prompt it was created with and the
CLI's own session id (from the `init` message). A fresh user turn arriving with
a different prompt ends the session and starts a new one with `resume: sessionId`
and the new prompt — the CLI reloads the transcript from disk, so nothing is
forgotten (verified: an aborted session resumed with a new prompt kept its
memory and followed the new rule; same session id). A tool-result continuation
always goes to its parked call, so a change during a run takes effect at the
next user turn. Cost of a restart: one CLI spawn, a couple of seconds.

**3. Sessions leak when a tab closes. — RESOLVED**
The shell hosts each document in its own `WebContentsView`, so `event.sender.id`
is a correct per-document key, but nothing tore the session down when that
webContents was destroyed — the `claude` child survived until the app exited.
Fix as shipped: `releaseClaudeCodeSessionWith(event.sender, sessionKey)` on
every turn hooks `destroyed` once per owner and cancels the session; the
integration test checks the child process is actually reaped.
`cancelClaudeCodeSession` now returns the drain promise (resolved once the
child is gone) and closes an open turn towards the renderer as a cancelled
`done`, which the old abort-only path never did — the renderer stayed busy
until its 240s silence watchdog.

**4. Cancel destroys the conversation. — RESOLVED**
`ai:stream-cancel` aborted the whole session, so pressing stop discarded Claude
Code's entire context and the next message started cold. Fix as shipped:
`interruptClaudeCodeSession` fails any parked tool call, calls
`query.interrupt()` and marks the session; the CLI answers with an
`error_during_execution` result (verified: ~4ms, memory intact), which the
drain loop turns into `done` with `stopReason: 'cancelled'`. Falls back to a
full cancel if the control request is rejected. Interrupting an idle session is
a no-op.

### P1 — fidelity

**5. Images are dropped.** `AgentMessage.images` never reaches the SDK; only
`lastUserText()` is forwarded. Vision input is silently unavailable even though
the adapter declares `vision: true`. Fix: build a `MessageParam` with image
content blocks instead of a bare string.

**5b. Large tool results are truncated by the CLI.** Claude Code caps every
MCP tool result at 25K tokens by default (`MAX_MCP_OUTPUT_TOKENS`; verified in
2.1.259), and the bridge's document tools are MCP tools. A `get_document_context`
on a long document therefore reaches the model cut off, silently, where the HTTP
providers see all of it. Found while forcing a compaction in the integration
test: a 70K-token tool result never moved the context. Options: raise the cap
through the session's environment (the same `env` the compaction window uses),
or have the skills page long context. Either way the truncation marker should
be detected and surfaced rather than trusted as the document.

**6. Errors are not classified.** The renderer localizes on
`errorCode: 'timeout' | 'credits' | 'network' | 'overloaded'`
(`electron-transport.ts`), and the bridge sets none. A Claude Code rate-limit —
the 5-hour window, which subscription users _will_ hit — surfaces as raw English
text instead of the localized message. Map the SDK's result subtypes and stderr
signatures onto the existing codes.

**7. Bridge strings are hardcoded English.** Every message in `claude-code.ts`
("Claude Code was not found on this machine…", the park-timeout text) bypasses
`tm()` and the 19-locale dictionary.

**8. Parallel tool calls are serialized.** `session.gate` (`:455`) allows one
tool round-trip at a time, because a second concurrent call would stream into a
turn the renderer has already settled. Correct but slow: Claude Code likes to
batch reads. Lifting it means letting one `ai:stream` request carry several
`tool-call` chunks before `done` and correlating several parked calls against one
returning `tool` message — the `AgentLoop` already handles multiple `toolCalls`
per turn, so the renderer side is ready.

**9. `maxOutputTokens` is ignored.** The settings field applies to every other
provider; Claude Code decides its own budget. Grey it out for this provider
rather than showing a control that does nothing.

**10. Usage and cost are discarded.** The SDK's `result` message carries token
usage. T3 Code reconstructs spend by scanning `~/.claude/projects/**/*.jsonl` and
pricing against LiteLLM's table; we could read it directly off the message. There
is no separate quota to exploit — a GenOffice turn eats the user's normal Claude
Code limits — so showing what was spent is the honest UI.

### P2 — coverage and platform

**11. Standalone Sheets and Slides.** `sheets-main.ts:3073`, `:3109` and
`slides/ai-ipc.ts:156` still reject a keyless provider. The branch copies
verbatim from `docs-main.ts:2685`. Only affects `dev:sheets` / `dev:slides`; the
shell is already covered. The deeper cleanup is that this gate is duplicated five
times and should be one helper.

**12. Windows is unsupported.** `findClaudeBinary()` looks for a bare `claude`
with no `.exe`/`.cmd` handling and no PATHEXT resolution. The SDK spawns
`pathToClaudeCodeExecutable` without a shell, so an npm `claude.cmd` shim fails
with `spawn EINVAL` (Node ≥ 20.12). T3 Code solved this in
`apps/server/src/provider/Drivers/ClaudeExecutable.ts` — resolve against
PATH/PATHEXT, and when the result is a launcher shim follow it to
`node_modules/@anthropic-ai/claude-code/bin/claude.exe` or `cli.js`. Port it.

**13. Standalone Docs cannot be packaged.** The shell build is verified (see
[Packaged build](#packaged-build) above) but `apps/docs` externalizes the SDK as a
dynamic import while its `files: ["out/**"]` ships no `node_modules`, so a
`dist:mac -w @genoffice/docs` still fails at `loadSdk()`. Either add the SDK to
that app's `externalizeDepsPlugin` exclusions or drop standalone Docs packaging
as unsupported — the shell is the shipped artifact either way.

Untested platforms remain: only macOS arm64 has been packaged. Windows is
blocked on item 12; Linux and macOS x64 are unexercised.

**14. No multi-account support.** T3 Code isolates accounts with
`CLAUDE_CONFIG_DIR`, and its `ClaudeHome.ts:27-33` records why: overriding `HOME`
relocates the macOS keychain lookup and the spawned CLI reports "Not logged in".
We do not override `HOME` today, so we are accidentally correct — but anyone
adding profile support must use `CLAUDE_CONFIG_DIR`, not `HOME`.

### P3 — UX

**15. No health state in the settings pane.** Selecting Claude Code with no CLI
installed, or installed but logged out, looks fine until the first message fails.
Add an `ai:claude-code-status` IPC over `claudeCodeVersion()` plus the SDK's
`AccountInfo` (`subscriptionType`, `tokenSource`, `apiProvider` — the same fields
T3 Code reads in `ClaudeProvider.ts:217-226`) and show "Claude Max · signed in"
or an actionable "run `claude auth login`".

**16. The connection test is meaningless.** The pane's Test button calls
`chatForProvider`, which for this provider returns
`AiHostOnlyProviderError`. It should instead probe the CLI and report the account.

**17. No first-run explanation.** `setAiCliHint` says no key is needed. It does
not say that turns consume the user's Claude Code allowance, that the CLI must be
installed and signed in, or that the model runs with the app's document tools and
none of its own.

### P4 — tests

**18. Only the happy path is covered.** Three tests, one trivial tool. Missing:
cancel mid-park; the 10-minute park timeout; session reuse across two user turns;
the `__genoffice_call_id` FIFO fallback; the schema converter against the real
`AGENT_TOOLS` (all 1078 lines of `apps/docs/src/renderer/ai/tools.ts`); the
"unknown tool is denied" branch; and a regression test for defect 1 once fixed.

**19. The integration tests need a signed-in CLI.** They skip cleanly elsewhere,
but that means CI proves nothing about this provider. A fake CLI honouring the
SDK's stdio protocol would let the bridge's own logic be tested everywhere.

### P5 — policy and process

**20. Document the trust model in `SECURITY.md`.** The bridge never reads a
credential; it spawns a binary the user installed and authenticated. Worth
writing down explicitly, alongside the fact that `settingSources: []` keeps the
user's own `CLAUDE.md`, skills and permission rules out of a session the app
opened on their behalf.

**21. Decide on upstreaming.** GenSpark has an open PR adding ChatGPT/Codex OAuth
(#24) and a stalled provider-agnostic PR (#115), so a CLI-backed provider is not
out of scope for them. If this stays a fork, note that `packages/ai-provider` is
the only shared surface touched, which keeps rebases cheap.

---

## Non-goals

- **Reading the OAuth token and calling `api.anthropic.com` directly.** It would
  work and it breaks Anthropic's terms. It is also what T3 Code deliberately did
  not do despite having the code in front of them.
- **Replacing `AgentLoop`.** The entire value of the parking design is that
  snapshots, tool cards, guards and compaction stay where they are.
- **Shipping our own Claude Code.** The user installs and authenticates the CLI;
  we drive it.

## Appendix

### Turn trace

```
renderer                       main                      claude CLI
  │ ai:stream(req1, sys, msgs, tools)
  │──────────────────────────────>│ query() opens, prompt pushed
  │                               │────────────────────────>│
  │        delta "Jag läser…"     │<────── text_delta ──────│
  │<──────────────────────────────│
  │                               │<─── canUseTool(id=X) ───│  ← parks here
  │   tool-call{id:X} + done      │
  │<──────────────────────────────│
  │ executeTool(X) on the docx    │
  │ ai:stream(req2, …, tool[X])   │
  │──────────────────────────────>│ resolve park(X)
  │                               │──── MCP result ────────>│
  │        delta "Dokumentet…"    │<────── text_delta ──────│
  │<──────────────────────────────│
  │            done               │<────── result ──────────│
```

### Settings shape

`~/Library/Application Support/GenOffice*/ai-settings.json`:

```json
{
  "provider": "claude-code",
  "providers": { "claude-code": { "apiKey": "", "model": "default" } }
}
```

`model` accepts `default` (the CLI decides from the account's entitlements),
`opus`, `sonnet` or `haiku`. An empty `model` deliberately falls back to
genspark — keyless does not mean unconfigured.

### Running it

```bash
npm install
npm run dev:docs                                  # standalone Docs
npx vitest run tests/claude-code-bridge.test.ts    # from apps/docs, needs a signed-in CLI
```

Prerequisite: `claude` installed and `claude auth login` completed.
