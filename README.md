# interplot

A browser drawing app that drives a vintage HP-GL pen plotter (HP 7475A / 7550 class)
live over a WebSocket bridge. Draw in an MS Paint-style canvas and the strokes come
out in ink.

There is no backend here — the app talks to a socket-to-serial bridge running on the
plotter host (`DEFAULT_URL` in `src/plot.ts`).

## Running it

```sh
yarn dev       # Vite dev server
yarn build     # tsc type-check (noEmit) + vite build — also the lint gate
yarn preview   # serve the production build
yarn deploy    # rsync dist/ to the plotter host
```

## Layout

- `index.html` → `src/main.ts` — connection bar, command console and log; mounts the
  paint surface.
- `src/paint.ts` — the drawing UI.
- `src/plot.ts` — HP-GL command builders, the plotter unit system, and the WebSocket
  connection wrapper.

## To do

- [ ] Package the WebSocket client as a library
- [ ] Add our learnings to the plotter README
