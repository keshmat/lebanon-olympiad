import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { html, raw } from "hono/html";
import { renameSync } from "node:fs";

// ---------- config ----------
const PORT = Number(process.env.PORT ?? 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SEED = process.env.SEED_TOUR_ID ?? "n1pPI5Q0"; // any section tour of the Olympiad group; its JSON lists all 9 section tours
const FED = process.env.FED ?? "LBN";
const TEAM = process.env.TEAM ?? "Lebanon";
const DATA = process.env.DATA_DIR ?? "data";
const OV_FILE = `${DATA}/overrides.json`;
const ROUNDS = 11;
const API = "https://lichess.org/api/broadcast";

// ---------- lichess ----------
type Player = { fed?: string; name?: string; team?: string };
type Game = { id: string; name: string; status: string; players: Player[] };
type RoundJson = { round: { id: string; name: string }; tour: { id: string; name: string }; games: Game[] };
type TourJson = { tour: { id: string; name: string }; rounds: { id: string; name: string; startsAt?: number }[]; group?: { tours: { id: string; name: string }[] } };

// ponytail: one small cache. On fetch failure the last good value is served (stale) and the URL is not retried
// before ttl elapses, so a Lichess 429 never turns into a retry storm. Lichess asks for sequential requests: callers loop, no Promise.all.
const cache = new Map<string, { t: number; p: Promise<any>; ok?: any }>();
export function get<T>(url: string, ttl = 60_000): Promise<T> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < ttl) return hit.p;
  const e = { t: Date.now(), ok: hit?.ok, p: undefined as unknown as Promise<T> };
  e.p = fetch(url)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Lichess ${r.status} for ${url}`))))
    .then((v) => (e.ok = v))
    .catch((err) => (e.ok !== undefined ? e.ok : Promise.reject(err)));
  cache.set(url, e);
  return e.p;
}
const getRound = (id: string) => get<RoundJson>(`${API}/-/-/${id}`);
const getTour = (id: string) => get<TourJson>(`${API}/${id}`, 600_000);

export type Board = { boardNo: number; roundId: string; gameId: string; name: string; status: string; tourName?: string };
export const embedUrl = (b: Board) => `https://lichess.org/embed/broadcast/-/-/${b.roundId}/${b.gameId}`;

export function pickFed(games: Game[], fed: string, roundId: string): Board[] {
  return games
    .filter((g) => g.players.some((p) => p.fed === fed))
    .map((g, i) => ({ boardNo: i + 1, roundId, gameId: g.id, name: g.name, status: g.status }));
}

export function parseRef(s: string): { roundId: string; gameId: string } | null {
  const m = s.trim().match(/([A-Za-z0-9]{8})\/([A-Za-z0-9]{8})\/?$/);
  return m ? { roundId: m[1], gameId: m[2] } : null;
}

/** Every round of every section tour in the group: [{n, roundId, tourName, startsAt}] */
async function allRounds() {
  const seed = await getTour(SEED);
  const tours: TourJson[] = [];
  for (const t of seed.group?.tours ?? [seed.tour]) tours.push(await getTour(t.id));
  return tours.flatMap((t) =>
    t.rounds.map((r, i) => ({ n: Number(r.name.match(/\d+/)?.[0] ?? i + 1), roundId: r.id, tourName: t.tour.name, startsAt: r.startsAt ?? Infinity })),
  );
}

// ---------- overrides ----------
type Ref = { roundId: string; gameId: string };
type Overrides = Record<string, { open?: Ref[]; women?: Ref[] }>;
const SECTIONS = ["open", "women"] as const;
type Section = (typeof SECTIONS)[number];

async function readOverrides(): Promise<Overrides> {
  try {
    return JSON.parse(await Bun.file(OV_FILE).text());
  } catch {
    return {};
  }
}
async function writeOverrides(ov: Overrides) {
  await Bun.write(`${OV_FILE}.tmp`, JSON.stringify(ov, null, 2));
  renameSync(`${OV_FILE}.tmp`, OV_FILE); // atomic: never leaves a half-written file
}

// ---------- boards ----------
type SectionData = { boards: Board[]; manual: boolean; error?: string };
type RoundData = Record<Section, SectionData>;

async function boards(n: number): Promise<RoundData> {
  const ov = (await readOverrides())[n] ?? {};
  const out = {} as RoundData;
  let auto: Promise<Board[]> | undefined; // shared by both sections, computed once
  const detect = () =>
    (auto ??= allRounds().then(async (rs) => {
      const out: Board[] = [];
      for (const r of rs.filter((r) => r.n === n)) {
        const rj = await getRound(r.roundId);
        out.push(...pickFed(rj.games, FED, rj.round.id).map((b) => ({ ...b, tourName: rj.tour.name })));
      }
      return out;
    }));
  for (const s of SECTIONS) {
    try {
      if (ov[s]) {
        const bs: Board[] = [];
        for (const [i, ref] of ov[s]!.entries()) {
          const r = await getRound(ref.roundId);
          const g = r.games.find((g) => g.id === ref.gameId);
          bs.push({ boardNo: i + 1, ...ref, name: g?.name ?? "(game not found in round)", status: g?.status ?? "?", tourName: r.tour.name });
        }
        out[s] = { boards: bs, manual: true };
      } else {
        const all = await detect();
        const mine = all.filter((b) => (b.tourName?.includes("Women") ? "women" : "open") === s);
        out[s] = { boards: mine.map((b, i) => ({ ...b, boardNo: i + 1 })), manual: false };
      }
    } catch (e) {
      out[s] = { boards: [], manual: !!ov[s], error: String(e) };
    }
  }
  return out;
}
const hashOf = (d: RoundData) => String(Bun.hash(JSON.stringify(SECTIONS.map((s) => d[s].boards.map((b) => [b.gameId, b.status])))));

// ---------- views ----------
const CSS = `
:root{color-scheme:light dark;font-family:system-ui,sans-serif}
body{margin:0;padding:12px 16px;max-width:1800px;margin-inline:auto}
h1{font-size:1.4rem;margin:.2rem 0 .6rem}
nav a{display:inline-block;padding:.3rem .6rem;margin:.1rem;border-radius:6px;text-decoration:none;background:#8882;color:inherit}
nav a[aria-current]{background:#c0392b;color:#fff}
h2{font-size:1.1rem;margin:1.2rem 0 .5rem;display:flex;gap:.6rem;align-items:center}
.badge{font-size:.7rem;padding:.1rem .45rem;border-radius:99px;background:#8883;font-weight:normal}
.badge.manual{background:#e67e22;color:#fff}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(320px,1fr))}
.card{display:flex;flex-direction:column;gap:.3rem}
.card .cap{font-size:.85rem;display:flex;justify-content:space-between;gap:.5rem}
.card .cap b{white-space:nowrap}
.card iframe{width:100%;aspect-ratio:1/1.28;border:0;border-radius:8px;background:#8881}
.muted{opacity:.7}
.err{color:#c0392b}
form.sec{display:grid;gap:.4rem;max-width:720px;margin-bottom:1.5rem}
form.sec input{padding:.4rem;font:inherit}
form.sec button{padding:.4rem .8rem;font:inherit;width:max-content}
`;

const layout = (title: string, body: any) => html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><script src="https://unpkg.com/htmx.org@2"></script><style>${raw(CSS)}</style></head>
<body>${body}</body></html>`;

const nav = (n: number, base = "/round") =>
  html`<nav>${Array.from({ length: ROUNDS }, (_, i) => i + 1).map((i) => html`<a href="${base}/${i}" ${i === n ? raw('aria-current="page"') : ""}>R${i}</a>`)}</nav>`;

const section = (s: Section, d: SectionData) => html`
<h2>${s === "open" ? "Open" : "Women"} <span class="badge ${d.manual ? "manual" : ""}">${d.manual ? "manual" : "auto"}</span>
  ${d.boards[0]?.tourName ? html`<span class="badge">${d.boards[0].tourName.split("|").slice(-2).join("|").trim()}</span>` : ""}</h2>
${d.error ? html`<p class="err">${d.error}</p>` : ""}
${d.boards.length
    ? html`<div class="grid">${d.boards.map(
        (b) => html`<div class="card"><div class="cap"><b>Board ${b.boardNo}</b><span>${b.name}</span><b>${b.status}</b></div>
<iframe src="${embedUrl(b)}" title="Board ${b.boardNo}: ${b.name}"></iframe></div>`,
      )}</div>`
    : d.error ? "" : html`<p class="muted">Pairings not published yet.</p>`}`;

const grid = (n: number, d: RoundData) => html`<div id="grid" hx-get="/round/${n}/grid?h=${hashOf(d)}" hx-trigger="every 60s" hx-swap="outerHTML">
${SECTIONS.map((s) => section(s, d[s]))}</div>`;

const page = (n: number, d: RoundData) =>
  layout(`${TEAM} – Olympiad Round ${n}`, html`<h1>${TEAM} at the Chess Olympiad</h1>${nav(n)}${grid(n, d)}
<p class="muted"><small>Boards refresh every minute. <a href="/admin/round/${n}">Admin</a></small></p>`);

const adminPage = (n: number, d: RoundData, ov: Overrides[string], msg = "") =>
  layout(`Admin – Round ${n}`, html`<h1>Admin – Round ${n}</h1>${nav(n, "/admin/round")}
${msg ? html`<p class="err">${msg}</p>` : ""}
${SECTIONS.map((s) => html`<h2>${s} <span class="badge ${d[s].manual ? "manual" : ""}">${d[s].manual ? "manual" : "auto"}</span></h2>
<p class="muted">Currently showing: ${d[s].boards.length ? d[s].boards.map((b) => `${b.boardNo}. ${b.name} [${b.status}]`).join(" · ") : "nothing"} ${d[s].error ?? ""}</p>
<form class="sec" method="post" action="/admin/round/${n}/${s}">
${[0, 1, 2, 3].map((i) => html`<input name="b${i}" placeholder="Board ${i + 1}: paste Lichess game URL or roundId/gameId" value="${ov?.[s]?.[i] ? `${ov[s]![i].roundId}/${ov[s]![i].gameId}` : ""}">`)}
<button>Save (empty all four to go back to auto)</button></form>`)}
<p><a href="/round/${n}">← Back to round ${n}</a></p>`);

// ---------- routes ----------
const app = new Hono();
const roundNo = (s: string) => (/^\d+$/.test(s) && +s >= 1 && +s <= ROUNDS ? +s : null);

app.get("/", async (c) => {
  const now = Date.now();
  const n = Math.max(1, ...(await allRounds().catch(() => [])).filter((r) => r.startsAt <= now).map((r) => r.n));
  return c.redirect(`/round/${n}`);
});

app.get("/round/:n", async (c) => {
  const n = roundNo(c.req.param("n"));
  return n ? c.html(page(n, await boards(n)), 200) : c.notFound();
});

app.get("/round/:n/grid", async (c) => {
  const n = roundNo(c.req.param("n"));
  if (!n) return c.notFound();
  const d = await boards(n);
  return c.req.query("h") === hashOf(d) ? c.body(null, 204) : c.html(grid(n, d), 200);
});

app.use("/admin/*", async (c, next) => {
  if (!ADMIN_PASSWORD) return c.text("Set ADMIN_PASSWORD to enable the admin panel.", 503);
  return basicAuth({ username: "admin", password: ADMIN_PASSWORD })(c, next);
});

app.get("/admin/round/:n", async (c) => {
  const n = roundNo(c.req.param("n"));
  if (!n) return c.notFound();
  const [d, ov] = await Promise.all([boards(n), readOverrides()]);
  return c.html(adminPage(n, d, ov[n] ?? {}), 200);
});

app.post("/admin/round/:n/:s", async (c) => {
  const n = roundNo(c.req.param("n"));
  const s = c.req.param("s") as Section;
  if (!n || !SECTIONS.includes(s)) return c.notFound();
  const body = await c.req.parseBody();
  const inputs = [0, 1, 2, 3].map((i) => String(body[`b${i}`] ?? "").trim()).filter(Boolean);
  const refs = inputs.map(parseRef);
  const ov = await readOverrides();
  if (refs.some((r) => !r)) {
    return c.html(adminPage(n, await boards(n), ov[n] ?? {}, `Could not parse: ${inputs.filter((_, i) => !refs[i]).join(", ")}. Nothing saved.`), 400);
  }
  ov[n] ??= {};
  if (refs.length) ov[n][s] = refs as Ref[];
  else delete ov[n][s];
  if (!Object.keys(ov[n]).length) delete ov[n];
  await writeOverrides(ov);
  return c.redirect(`/admin/round/${n}`);
});

export default { port: PORT, fetch: app.fetch };
