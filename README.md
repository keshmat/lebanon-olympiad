# Lebanon at the Chess Olympiad

One page per round showing all 8 Lebanese boards (Open + Women) as live Lichess embeds.
Boards are found automatically from the Lichess broadcast API; an admin form lets you set them by hand when detection fails.

## Run

```bash
ADMIN_PASSWORD=change-me bun run dev      # http://localhost:3000
bun test
```

## Environment

| Var | Default | Meaning |
|---|---|---|
| `ADMIN_PASSWORD` | (unset → admin disabled) | Basic-auth password for `/admin/round/N`, user `admin` |
| `PORT` | `3000` | |
| `SEED_TOUR_ID` | `n1pPI5Q0` | Any section tour of the Olympiad group; its JSON lists all sections |
| `FED` | `LBN` | FIDE federation code to look for |
| `TEAM` | `Lebanon` | Display name |
| `DATA_DIR` | `data` | Where `overrides.json` lives. Mount a volume here in production |

## Code map

| File | Owns |
|---|---|
| `server.tsx` | The Hono app: middleware, routes, static files, Bun export. Start here. |
| `views.tsx` | Every template as a Hono JSX component, server-rendered to a string. The htmx round-trip is documented on `Grid`. |
| `lichess.ts` | Talking to Lichess: cached, paced fetch; finding the federation's boards. |
| `overrides.ts` | The admin overrides file and URL parsing. |
| `config.ts` | Environment variables. |
| `public/eval.js` | Browser-side Stockfish worker that paints the eval bars. |
| `public/stockfish-19-lite-single.{js,wasm}` | The engine, unmodified from the stockfish.js v19.0.0 release. |
| `public/style.css` | Layout on top of missing.css. |

## How it works

- `/` redirects to the latest round that has started.
- `/round/N` looks through round N of every section once, keeps the games with a `FED` player, and remembers them. After that only the one or two rounds the team plays in are fetched, once a minute (about 2 Lichess requests/min; 18 on a cold start, spaced 200 ms apart). The page polls every 60 s and only re-renders when a board or result changes. Every real Lichess fetch is logged to stdout.
- Eval bars: the browser runs Stockfish 19 (the lite single-threaded WASM build, ~1.7 MB, GPLv3, from [stockfish.js](https://github.com/nmrugg/stockfish.js) releases, vendored in `public/`) in a worker and evaluates each board's FEN from `/round/N/fens` at depth 12, once a minute. No server CPU, no extra Lichess calls.
- Styling is [missing.css](https://missing.style) with a serif font. Boards are at least 400 px wide (narrower and the embed clips names next to the clock); two rows of four fit a tall monitor and scroll a little on laptops. Under 900 px it is one full-width column.
- `/admin/round/N` shows what auto-detection found and lets you paste up to 4 Lichess game URLs (or `roundId/gameId`) per section. Leave all four empty to return to auto.
- No cron, no background jobs, no database. Lichess streams the moves straight into the embeds.

## Deploy

Render: `render.yaml` is a Blueprint (Docker, starter plan, 1 GB disk at `/data`). In the Render dashboard choose New → Blueprint, pick this repo, and enter `ADMIN_PASSWORD` when prompted. Any other host works too: run the Docker image with a volume at `/data` and `ADMIN_PASSWORD` set.
