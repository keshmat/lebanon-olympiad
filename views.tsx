/** @jsxImportSource hono/jsx */
/**
 * HTML templates as Hono JSX components.
 *
 * Read this like React, with one difference that matters: these components run
 * once, on the server, and render to a string. There is no client runtime, so
 * there is no state, no hooks, and an onClick function prop would have nowhere
 * to go. Interactivity comes from htmx attributes (a click becomes a request,
 * the server answers with HTML), from small scripts like public/eval.js, or,
 * if a subtree ever needs real client state, from a hydrated island.
 *
 * Interpolated values are escaped automatically, so player names can't inject
 * markup. htmx appears in exactly one place: <Grid>. See its comment.
 */
import { html } from "hono/html";
import { ROUNDS, TEAM } from "./config.ts";
import { embedUrl, gameUrl, gridHash, type Board, type RoundData, type SectionData } from "./lichess.ts";
import { SECTIONS, type Overrides, type Section } from "./overrides.ts";

/** Page shell: missing.css for base styles, htmx, our stylesheet. */
const DESCRIPTION = `Live boards of ${TEAM}'s Open and Women's teams at the 46th FIDE Chess Olympiad, Samarkand 2026, round by round.`;

/** Lichess renders any position as a board image; used for link previews. */
const boardImageUrl = (fen: string) => `https://lichess1.org/export/fen.gif?fen=${encodeURIComponent(fen)}&theme=brown&piece=cburnett`;

/**
 * Link-preview image: board 1 of the Open team. A round whose pairings are not out yet
 * reuses the last image this process rendered (typically the previous round's final position),
 * and a cold start with nothing to show falls back to the starting position.
 */
let lastImage = boardImageUrl("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
const previewImage = (data: RoundData) => {
  const fen = data.open.boards[0]?.fen;
  if (fen) lastImage = boardImageUrl(fen);
  return lastImage;
};

const Layout = ({ title, round, image = lastImage, children }: { title: string; round?: number; image?: string; children?: unknown }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <title>{title}</title>
      <meta name="description" content={DESCRIPTION} />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={DESCRIPTION} />
      <meta property="og:type" content="website" />
      <meta property="og:image" content={image} />
      <meta name="theme-color" content="#ed1c24" />
      <link rel="icon" href="/public/favicon.svg" type="image/svg+xml" />
      <link rel="stylesheet" href="https://unpkg.com/missing.css@1.3.0" />
      <link rel="stylesheet" href="/public/style.css" />
      <script src="https://unpkg.com/htmx.org@2"></script>
    </head>
    {/* data-round tells eval.js which round's FENs to fetch */}
    <body data-round={round}>{children}</body>
  </html>
);

/** R1 … R11 links; the current one gets aria-current, which the stylesheet highlights. */
const RoundNav = ({ roundNo, basePath = "/round" }: { roundNo: number; basePath?: string }) => (
  <nav>
    {Array.from({ length: ROUNDS }, (_, index) => index + 1).map((each) => (
      <a href={`${basePath}/${each}`} aria-current={each === roundNo ? "page" : undefined}>
        R{each}
      </a>
    ))}
  </nav>
);

/**
 * One board: a caption row and, below it, the eval bar next to the Lichess iframe.
 * data-game lets eval.js find the card for a game id. .eval and .score start empty
 * and are filled in by eval.js once the engine has a verdict.
 */
const BoardCard = ({ board }: { board: Board }) => (
  <div class="card" data-game={board.gameId}>
    <div class="cap">
      <b>
        <a href={gameUrl(board)} target="_blank" rel="noopener">
          Board {board.boardNo} ↗
        </a>
      </b>
      <span class="name"></span>
      <b>{board.status === "*" ? "" : board.status}</b>
      <span class="score"></span>
    </div>
    <div class="board">
      <div class="eval" title="Engine eval (white's share fills from the bottom)"></div>
      <iframe src={embedUrl(board)} title={`Board ${board.boardNo}: ${board.name}`}></iframe>
    </div>
  </div>
);

/** "Open" or "Women" heading plus its row of boards, or an explanation of why there are none. */
const SectionBlock = ({ section, data }: { section: Section; data: SectionData }) => (
  <section>
    <h2>{section === "open" ? "Open" : "Women"}</h2>
    {data.error && <p class="err">{data.error}</p>}
    {data.boards.length ? (
      <div class="grid">
        {data.boards.map((board) => (
          <BoardCard board={board} />
        ))}
      </div>
    ) : (
      !data.error && <p class="muted">Pairings not published yet.</p>
    )}
  </section>
);

/**
 * The htmx round-trip, in full:
 *
 *   1. hx-trigger="every 60s"  — every minute htmx sends GET /round/N/grid?h=<hash>
 *      (hx-get) where <hash> fingerprints the boards this page currently shows.
 *   2. The server recomputes the hash. Same → responds 204 No Content, and htmx
 *      does nothing, so the iframes are left untouched.
 *   3. Different (pairings published, a game finished, an admin override) → the
 *      server responds with this same fragment, freshly rendered, and
 *      hx-swap="outerHTML" replaces the whole <div id="grid"> with it.
 *   4. The new fragment carries the new hash in its own hx-get, so the next poll
 *      compares against the right value. eval.js listens for htmx:afterSwap to
 *      repaint eval bars on the new cards.
 */
export const Grid = ({ roundNo, data }: { roundNo: number; data: RoundData }) => (
  <div id="grid" hx-get={`/round/${roundNo}/grid?h=${gridHash(data)}`} hx-trigger="every 60s" hx-swap="outerHTML">
    {SECTIONS.map((section) => (
      <SectionBlock section={section} data={data[section]} />
    ))}
  </div>
);

/** The public round page. */
export const RoundPage = ({ roundNo, data }: { roundNo: number; data: RoundData }) => (
  <Layout title={`${TEAM} – Olympiad Round ${roundNo}`} round={roundNo} image={previewImage(data)}>
    <header>
      <h1>{TEAM} at the Chess Olympiad</h1>
      <RoundNav roundNo={roundNo} />
    </header>
    <Grid roundNo={roundNo} data={data} />
    <script src="/public/eval.js"></script>
  </Layout>
);

/**
 * Admin page: what each section currently shows, and a plain HTML form per section
 * (no htmx here; a normal POST and redirect is the simplest thing that works).
 */
export const AdminPage = ({ roundNo, data, overrides, message }: { roundNo: number; data: RoundData; overrides: Overrides[string]; message?: string }) => (
  <Layout title={`Admin – Round ${roundNo}`}>
    <header>
      <h1>Admin – Round {roundNo}</h1>
      <RoundNav roundNo={roundNo} basePath="/admin/round" />
    </header>
    {message && <p class="err">{message}</p>}
    {SECTIONS.map((section) => {
      const current = overrides?.[section] ?? [];
      const showing = data[section].boards.map((board) => `${board.boardNo}. ${board.name} [${board.status}]`).join(" · ");
      return (
        <>
          <h2>
            {section} <span class="chip">{data[section].manual ? "manual" : "auto"}</span>
          </h2>
          <p class="muted">
            Currently showing: {showing || "nothing"} {data[section].error ?? ""}
          </p>
          <form class="sec" method="post" action={`/admin/round/${roundNo}/${section}`}>
            {[0, 1, 2, 3].map((index) => (
              <input
                name={`b${index}`}
                placeholder={`Board ${index + 1}: paste Lichess game URL or roundId/gameId`}
                value={current[index] ? `${current[index].roundId}/${current[index].gameId}` : ""}
              />
            ))}
            <button>Save (empty all four to go back to auto)</button>
          </form>
        </>
      );
    })}
    <p>
      <a href={`/round/${roundNo}`}>← Back to round {roundNo}</a>
    </p>
  </Layout>
);

/** Hono's c.html() accepts what a component returns; this adds the doctype for full pages. */
export const page = (component: unknown) => html`<!doctype html>${component}`;
