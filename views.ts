/**
 * HTML templates. Hono's `html` tagged template escapes every interpolated value
 * (so player names can't inject markup) and flattens arrays, so
 * `${boards.map((board) => html`...`)}` renders a list. `raw()` opts out of escaping
 * for strings we wrote ourselves, such as an attribute we build by hand.
 *
 * htmx appears in exactly one place: the grid container in `grid()`. See the
 * comment there for the full round-trip.
 */
import { html, raw } from "hono/html";
import { ROUNDS, TEAM } from "./config.ts";
import { embedUrl, gameUrl, gridHash, type Board, type RoundData, type SectionData } from "./lichess.ts";
import { SECTIONS, type Overrides, type Section } from "./overrides.ts";

/** Page shell: missing.css for base styles, htmx, our stylesheet. `bodyAttrs` lets a page tag <body>. */
const layout = (title: string, body: unknown, bodyAttrs = "") => html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <link rel="stylesheet" href="https://unpkg.com/missing.css@1.3.0">
  <link rel="stylesheet" href="/public/style.css">
  <script src="https://unpkg.com/htmx.org@2"></script>
</head>
<body ${raw(bodyAttrs)}>${body}</body>
</html>`;

/** R1 … R11 links; the current one gets aria-current, which the stylesheet highlights. */
const roundNav = (roundNo: number, basePath = "/round") =>
  html`<nav>${Array.from({ length: ROUNDS }, (_, index) => index + 1).map(
    (each) => html`<a href="${basePath}/${each}" ${each === roundNo ? raw('aria-current="page"') : ""}>R${each}</a>`,
  )}</nav>`;

/**
 * One board: a caption row and, below it, the eval bar next to the Lichess iframe.
 * data-game lets eval.js find the card for a game id. The .eval and .score elements
 * start empty and are filled in by eval.js once the engine has a verdict.
 */
const boardCard = (board: Board) => html`<div class="card" data-game="${board.gameId}">
  <div class="cap">
    <b><a href="${gameUrl(board)}" target="_blank" rel="noopener">Board ${board.boardNo} ↗</a></b>
    <span class="name"></span>
    <b>${board.status === "*" ? "" : board.status}</b>
    <span class="score"></span>
  </div>
  <div class="board">
    <div class="eval" title="Engine eval (white's share fills from the bottom)"></div>
    <iframe src="${embedUrl(board)}" title="Board ${board.boardNo}: ${board.name}"></iframe>
  </div>
</div>`;

/** "Open" or "Women" heading plus its row of boards, or an explanation of why there are none. */
const sectionBlock = (section: Section, data: SectionData) => html`<section>
  <h2>${section === "open" ? "Open" : "Women"}</h2>
  ${data.error ? html`<p class="err">${data.error}</p>` : ""}
  ${data.boards.length
    ? html`<div class="grid">${data.boards.map(boardCard)}</div>`
    : data.error ? "" : html`<p class="muted">Pairings not published yet.</p>`}
</section>`;

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
export const grid = (roundNo: number, data: RoundData) =>
  html`<div id="grid" hx-get="/round/${roundNo}/grid?h=${gridHash(data)}" hx-trigger="every 60s" hx-swap="outerHTML">
  ${SECTIONS.map((section) => sectionBlock(section, data[section]))}
</div>`;

/** The public round page. data-round tells eval.js which round's FENs to fetch. */
export const roundPage = (roundNo: number, data: RoundData) =>
  layout(
    `${TEAM} – Olympiad Round ${roundNo}`,
    html`<header><h1>${TEAM} at the Chess Olympiad</h1>${roundNav(roundNo)}</header>
${grid(roundNo, data)}
<script src="/public/eval.js"></script>`,
    `data-round="${roundNo}"`,
  );

/**
 * Admin page: what each section currently shows, and a plain HTML form per section
 * (no htmx here — a normal POST and redirect is the simplest thing that works).
 */
export const adminPage = (roundNo: number, data: RoundData, overrides: Overrides[string], message = "") =>
  layout(
    `Admin – Round ${roundNo}`,
    html`<header><h1>Admin – Round ${roundNo}</h1>${roundNav(roundNo, "/admin/round")}</header>
${message ? html`<p class="err">${message}</p>` : ""}
${SECTIONS.map((section) => {
  const current = overrides?.[section] ?? [];
  const showing = data[section].boards.map((board) => `${board.boardNo}. ${board.name} [${board.status}]`).join(" · ");
  return html`<h2>${section} <span class="chip">${data[section].manual ? "manual" : "auto"}</span></h2>
<p class="muted">Currently showing: ${showing || "nothing"} ${data[section].error ?? ""}</p>
<form class="sec" method="post" action="/admin/round/${roundNo}/${section}">
  ${[0, 1, 2, 3].map(
    (index) => html`<input name="b${index}" placeholder="Board ${index + 1}: paste Lichess game URL or roundId/gameId"
      value="${current[index] ? `${current[index].roundId}/${current[index].gameId}` : ""}">`,
  )}
  <button>Save (empty all four to go back to auto)</button>
</form>`;
})}
<p><a href="/round/${roundNo}">← Back to round ${roundNo}</a></p>`,
  );
