# Bundled games

DuneOffice can host self-contained HTML games as tabs. The first one is
"Dune: Sands of Arrakis" (`dune-adventure`), a canvas action adventure.

## For the player

- Home shows a **Dune Adventure** card next to AI Docs, AI Sheets and the
  others. It opens the game in a tab; clicking it again focuses that tab.
- Any document tab is one click away; the game keeps running but goes silent
  while another tab is in front, and the shell throttles its render loop.
- **F11** (or Ctrl+Cmd+F on macOS) toggles fullscreen; Esc leaves it. In a
  window the game scales to fill the tab area.
- Saved progress lives in the game's own browser storage inside the app
  profile, so it survives restarts and updates.

## For the developer

- `apps/shell/games/<id>/` holds each game as static files; `src/main/games.ts`
  lists them (`GAMES`), and `electron-builder.cjs` ships the folder as
  `resources/games/<id>`. `gamesRoot()` resolves both layouts.
- `createGameView()` builds a sandboxed `WebContentsView` (no preload, no
  Node, navigation and popups denied, autoplay allowed) and loads
  `index.html` from disk with `loadFile`. After load it injects the fullscreen
  key binding, so games need no knowledge of the shell.
- `TabManager.openGameTab(game)` gives the tab kind `game`; one tab per game
  id. `activateTab` mutes every game view that is not in front.
- The Home card calls `window.aiOffice.openGame(id)` → `home:open-game` →
  the tab manager. The tab strip and the native tab menu have their own icons
  for the kind.
- Assets: `tools/optimize-game-assets.mjs` caps sprites at 1024 px (the tile
  textures the game samples in fixed windows keep their size), palette-
  quantizes every PNG with pngquant and re-encodes music with ffmpeg. The
  bundled copy is about 50 MB; the originals stay outside the repo.
- Adding a game: drop its folder under `apps/shell/games/`, add a `GAMES`
  entry, an `extraResources` entry and a launcher card/string; run the
  optimizer if the assets are large.
