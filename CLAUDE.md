# CLAUDE.md

Guidance for AI agents and human contributors working in this repo.

## Theming rules (mandatory)

The suite supports light / dark / system UI themes. The switching mechanism is a
`data-theme` attribute on `<html>` plus CSS custom properties defined once in
`packages/ui/src/tokens.css` (light defaults in `:root`, overrides in
`[data-theme='dark']`, and a `prefers-color-scheme` media-query fallback for
system mode).

1. **UI chrome colors must use semantic tokens.** Never write raw `#hex` /
   `rgb()` in renderer CSS rules or chrome-related inline styles — reference
   `var(--surface)`, `var(--text)`, `var(--hover)`, etc. from
   `packages/ui/src/tokens.css`. Raw values are allowed only on custom-property
   definition lines (`--x: #...;` — token, accent, or app-scoped variable
   definitions). CI enforces this for new/changed renderer CSS lines
   (`tools/check-theme-colors.mjs`).
2. **Every new token gets both values.** Adding a token means adding it to all
   three blocks in `tokens.css` (light, dark, system-dark fallback).
3. **Accent colors stay per-app.** Each app defines `--accent` /
   `--accent-dark` / `--accent-soft` (and its dark-adjusted values) in its own
   `styles.css`. Shared rules reference `var(--accent)` and inherit the app's
   brand color.
4. **Document content never follows the theme.** Page surfaces, cell fills,
   slide content, PDF page bitmaps, export/print stylesheets, chart palettes,
   highlight color maps, stamps, and WordArt presets are document data: they
   stay hardcoded, must not reference chrome tokens, and must render/export
   identically in both themes. (Word-style "dark chrome, white paper".)
5. **Canvas-drawn UI affordances go through a constants table.** Konva/canvas
   editing chrome (selection frames, guides, handles) reads from the app's
   canvas color table (e.g. `canvas-colors.ts`) keyed by the current theme —
   no inline hex in draw calls.

## Build gotchas

- App main-process code (`apps/*/src/main`) is compiled into the **shell**
  build. After changing it, rebuild the shell or the change silently does not
  run.
- In dev mode, preload changes require a rebuild — a stale preload leaves the
  renderer blank.
- Workspace packages listed in an app's `dependencies` must also be added to
  the `externalizeDepsPlugin` `exclude` list, or the packaged app crashes on
  launch.
- `useI18n()`'s `t` is not referentially stable; never put it in a hook
  dependency array. Store the key and translate at render time.

## Tod, the assistant

Tod is the Office-97-style assistant in the bottom-right of every app (a
sandworm bent into a paperclip). He lives in `packages/ui/src/tod/`:

- `Tod.tsx` is IPC-free and takes `breakMinutes` in / `onPlayGame` out, so it
  renders in a test or a harness. `TodHost.tsx` is the wired version the apps
  mount; it talks to `window.todBridge` (installed by every preload from
  `@genoffice/electron-utils/tod-bridge`).
- The break clock is **suite-wide and lives in the main process**
  (`apps/shell/src/main/tod.ts`), because each app is its own renderer and six
  independent timers would never add up to one working day. Renderers ping
  while focused; the main process accumulates, decides, and pushes the nudge.
- The artwork's segment rings are sampled from the body path at run time
  (`tod-geometry.ts`) — never hand-place them, or they drift off the wire when
  the path changes. Animating a `<g>` that carries an SVG `transform`
  attribute silently replaces it; positioning and animation need separate
  groups.
- His strings live in `packages/ui/src/tod/i18n/` rather than in each app's
  dictionary: he says the same things everywhere.

## UI strings (i18n)

- The suite ships **three languages: English, Swedish and Spanish** (`Lang` in
  `packages/i18n`). English is the source language and defines the key set;
  new profiles default to English. Adding a fourth language means adding a
  shard for it in every domain — don't reintroduce the upstream language packs.
- Large dictionaries are sharded per locale: `i18n/strings-<domain>.ts` is a
  thin aggregator over `i18n/<domain>/<lang>.ts` (one file per language, `en`
  defines the key set). Add a new key to `en.ts` and to every sibling shard;
  the `satisfies Record<keyof typeof en, string>` on each shard turns a
  missing or extra key into a type error, so a half-translated key never
  ships. Never collapse the shards back into one multi-locale object.
- Shortcut hints are written in Mac notation (`⌘S`, `⇧⌘Z`); `platformShortcuts`
  rewrites them to Ctrl/Alt/Shift form on Windows and Linux.
