# Bundled games

Each folder here is a self-contained HTML game (`index.html` plus assets)
that the shell hosts as a tab; `src/main/games.ts` lists them and
`electron-builder.cjs` ships them under `resources/games/`.

`dune-adventure` — "Dune: Sands of Arrakis", a canvas action adventure. The
originals live outside the repo (`~/code/games/games/dune-adventure`); the copy
here went through `tools/optimize-game-assets.mjs` (sprites capped at 1024 px
and palette-quantized, music re-encoded), 255 MB down to about 50 MB. Rerun
that script after replacing assets from the originals.
