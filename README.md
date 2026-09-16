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

## How it works

- `/` redirects to the latest round that has started.
- `/round/N` looks through round N of every section once, keeps the games with a `FED` player, and remembers them. After that only the one or two rounds the team plays in are fetched, once a minute (about 2 Lichess requests/min; 18 on a cold start, spaced 200 ms apart). The page polls every 60 s and only re-renders when a board or result changes. Every real Lichess fetch is logged to stdout.
- Eval bars: the browser runs Stockfish 10 (WASM, ~420 KB from jsDelivr) in a worker and evaluates each board's FEN from `/round/N/fens` at depth 12, once a minute. No server CPU, no extra Lichess calls.
- Styling is [missing.css](https://missing.style) with a serif font. Boards are at least 400 px wide (narrower and the embed clips names next to the clock); two rows of four fit a tall monitor and scroll a little on laptops. Under 900 px it is one full-width column.
- `/admin/round/N` shows what auto-detection found and lets you paste up to 4 Lichess game URLs (or `roundId/gameId`) per section. Leave all four empty to return to auto.
- No cron, no background jobs, no database. Lichess streams the moves straight into the embeds.

## Deploy

Any host that runs `bun server.ts` with a persistent volume at `data/` (Fly, Railway, a VPS). Set `ADMIN_PASSWORD`.
