/**
 * The Hono app: middleware, routes, and the Bun server export.
 *
 * Request flow for the public page:
 *   GET /               → find the latest started round, redirect to /round/N
 *   GET /round/N        → full page (views.roundPage) with 8 Lichess iframes
 *   GET /round/N/grid   → the boards fragment, polled by htmx every 60 s (see views.grid)
 *   GET /round/N/fens   → { gameId: fen } JSON, polled by public/eval.js for the eval bars
 *
 * Admin (basic auth, user "admin"):
 *   GET  /admin/round/N          → form per section
 *   POST /admin/round/N/:section → save or clear that section's override, redirect back
 */
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { serveStatic } from "hono/bun";
import { ADMIN_PASSWORD, PORT, ROUNDS } from "./config.ts";
import { boardsForRound, currentRoundNo, gridHash } from "./lichess.ts";
import { parseGameRef, readOverrides, SECTIONS, writeOverrides, type GameRef, type Section } from "./overrides.ts";
import { adminPage, grid, roundPage } from "./views.ts";

const app = new Hono();

/** Route params arrive as strings; this is the one place they are validated. Returns null for anything but 1..ROUNDS. */
const parseRoundNo = (raw: string): number | null => (/^\d+$/.test(raw) && +raw >= 1 && +raw <= ROUNDS ? +raw : null);

// ---------- static files ----------

app.use("/public/*", serveStatic({ root: "./" }));

// ---------- public ----------

app.get("/", async (context) => context.redirect(`/round/${await currentRoundNo()}`));

app.get("/round/:n", async (context) => {
  const roundNo = parseRoundNo(context.req.param("n"));
  if (!roundNo) return context.notFound();
  return context.html(roundPage(roundNo, await boardsForRound(roundNo)));
});

/**
 * The htmx poll target. `h` is the hash the browser's grid was rendered with.
 * 204 tells htmx "nothing to swap"; otherwise we send the fragment and htmx replaces the grid.
 */
app.get("/round/:n/grid", async (context) => {
  const roundNo = parseRoundNo(context.req.param("n"));
  if (!roundNo) return context.notFound();
  const data = await boardsForRound(roundNo);
  if (context.req.query("h") === gridHash(data)) return context.body(null, 204);
  return context.html(grid(roundNo, data));
});

/** Current positions for the browser-side engine. Served from the same cache as the page, so no extra Lichess calls. */
app.get("/round/:n/fens", async (context) => {
  const roundNo = parseRoundNo(context.req.param("n"));
  if (!roundNo) return context.notFound();
  const data = await boardsForRound(roundNo);
  const fens = SECTIONS.flatMap((section) => data[section].boards.filter((board) => board.fen).map((board) => [board.gameId, board.fen]));
  return context.json(Object.fromEntries(fens));
});

// ---------- admin ----------

/** Middleware runs before every /admin/* route. `next()` continues to the route; not calling it ends the request. */
app.use("/admin/*", async (context, next) => {
  if (!ADMIN_PASSWORD) return context.text("Set ADMIN_PASSWORD to enable the admin panel.", 503);
  return basicAuth({ username: "admin", password: ADMIN_PASSWORD })(context, next);
});

app.get("/admin/round/:n", async (context) => {
  const roundNo = parseRoundNo(context.req.param("n"));
  if (!roundNo) return context.notFound();
  const [data, overrides] = await Promise.all([boardsForRound(roundNo), readOverrides()]);
  return context.html(adminPage(roundNo, data, overrides[roundNo] ?? {}));
});

app.post("/admin/round/:n/:section", async (context) => {
  const roundNo = parseRoundNo(context.req.param("n"));
  const section = context.req.param("section") as Section;
  if (!roundNo || !SECTIONS.includes(section)) return context.notFound();

  // Form fields b0..b3; blanks are ignored, anything unparsable rejects the whole submission.
  const form = await context.req.parseBody();
  const inputs = [0, 1, 2, 3].map((index) => String(form[`b${index}`] ?? "").trim()).filter(Boolean);
  const refs = inputs.map(parseGameRef);
  const overrides = await readOverrides();
  if (refs.some((ref) => !ref)) {
    const bad = inputs.filter((_, index) => !refs[index]).join(", ");
    return context.html(adminPage(roundNo, await boardsForRound(roundNo), overrides[roundNo] ?? {}, `Could not parse: ${bad}. Nothing saved.`), 400);
  }

  overrides[roundNo] ??= {};
  if (refs.length) overrides[roundNo][section] = refs as GameRef[];
  else delete overrides[roundNo][section]; // all blank → back to auto-detection
  if (!Object.keys(overrides[roundNo]).length) delete overrides[roundNo];
  await writeOverrides(overrides);
  return context.redirect(`/admin/round/${roundNo}`);
});

// Bun serves whatever the entry module exports as default.
export default { port: PORT, fetch: app.fetch };
