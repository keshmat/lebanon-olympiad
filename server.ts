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
type Game = { id: string; name: string; status: string; fen?: string; players: Player[] };
type RoundJson = { round: { id: string; name: string }; tour: { id: string; name: string }; games: Game[] };
type TourJson = { tour: { id: string; name: string }; rounds: { id: string; name: string; startsAt?: number }[]; group?: { tours: { id: string; name: string }[] } };

// ponytail: one small cache. On fetch failure the last good value is served (stale) and the URL is not retried
// before ttl elapses, so a Lichess 429 never turns into a retry storm. Lichess asks for sequential requests: callers loop, no Promise.all.
const cache = new Map<string, { t: number; p: Promise<any>; ok?: any }>();
let slot = 0; // real fetches are spaced ≥200 ms apart; a cold start makes ~18 and Lichess 429s a tight burst
const paced = (url: string) => ((slot = Math.max(slot + 200, Date.now())), Bun.sleep(slot - Date.now()).then(() => (console.log("fetch", url.slice(API.length)), fetch(url))));
export function get<T>(url: string, ttl = 60_000): Promise<T> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < ttl) return hit.p;
  const e = { t: Date.now(), ok: hit?.ok, p: undefined as unknown as Promise<T> };
  e.p = paced(url)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Lichess ${r.status} for ${url}`))))
    .then((v) => (e.ok = v))
    .catch((err) => (e.ok !== undefined ? e.ok : Promise.reject(err)));
  cache.set(url, e);
  return e.p;
}
const getRound = (id: string) => get<RoundJson>(`${API}/-/-/${id}`);
const getTour = (id: string) => get<TourJson>(`${API}/${id}`, 600_000);

export type Board = { boardNo: number; roundId: string; gameId: string; name: string; status: string; fen?: string };
const embedUrl = (b: Board) => `https://lichess.org/embed/broadcast/-/-/${b.roundId}/${b.gameId}`;
const gameUrl = (b: Board) => `https://lichess.org/broadcast/-/-/${b.roundId}/${b.gameId}`;

export function pickFed(games: Game[], fed: string, roundId: string): Board[] {
  return games
    .filter((g) => g.players.some((p) => p.fed === fed))
    .map((g, i) => ({ boardNo: i + 1, roundId, gameId: g.id, name: g.name, status: g.status, fen: g.fen }));
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

// Detection (9 round fetches) runs once per round and is remembered; afterwards only the 1–2 rounds ${TEAM}
// plays in are polled. An empty result (pairings not out yet) is retried after 5 min.
const found = new Map<string, { t: number; refs: Ref[] }>();
async function autoRefs(n: number, s: Section): Promise<Ref[]> {
  const hit = found.get(`${n}:${s}`);
  if (hit && (hit.refs.length || Date.now() - hit.t < 300_000)) return hit.refs;
  const res: Record<Section, Ref[]> = { open: [], women: [] };
  for (const r of (await allRounds()).filter((r) => r.n === n)) {
    const rj = await getRound(r.roundId);
    res[r.tourName.includes("Women") ? "women" : "open"].push(...pickFed(rj.games, FED, r.roundId).map(({ roundId, gameId }) => ({ roundId, gameId })));
  }
  for (const k of SECTIONS) found.set(`${n}:${k}`, { t: Date.now(), refs: res[k] });
  return res[s];
}

async function boards(n: number): Promise<RoundData> {
  const ov = (await readOverrides())[n] ?? {};
  const out = {} as RoundData;
  for (const s of SECTIONS) {
    try {
      const refs = ov[s] ?? (await autoRefs(n, s));
      const bs: Board[] = [];
      for (const [i, ref] of refs.entries()) {
        const r = await getRound(ref.roundId);
        const g = r.games.find((g) => g.id === ref.gameId);
        if (!g && !ov[s]) found.delete(`${n}:${s}`); // game ids changed (source re-created the games): re-detect next time
        bs.push({ boardNo: i + 1, ...ref, name: g?.name ?? "(game not found in round)", status: g?.status ?? "?", fen: g?.fen });
      }
      out[s] = { boards: bs, manual: !!ov[s] };
    } catch (e) {
      out[s] = { boards: [], manual: !!ov[s], error: String(e) };
    }
  }
  return out;
}
// FENs are deliberately left out: the grid (and its iframes) must only re-render when a board or result changes.
const hashOf = (d: RoundData) => String(Bun.hash(JSON.stringify(SECTIONS.map((s) => d[s].boards.map((b) => [b.gameId, b.status])))));

// ---------- views ----------
const CSS = `
:root{--main-font:Georgia,"Iowan Old Style","Times New Roman",serif;--line-length:100rem}
body{padding:.4rem 1rem .6rem}
body>header{display:flex;flex-wrap:wrap;align-items:baseline;gap:.3rem 1.5rem;margin:0 0 .2rem;padding:0;border:0;background:none}
header h1{font-size:1.3rem;margin:0}
nav a{display:inline-block;padding:.05rem .45rem;margin:.1rem .05rem;border-radius:4px;text-decoration:none;color:inherit}
nav a[aria-current]{background:var(--accent);color:var(--bg)}
section{width:max-content;max-width:100%;margin:0 auto!important;padding:0!important}
body h2{font-size:1rem;margin:.4rem 0 .15rem!important}
/* ponytail: --h fits two rows of four on a desktop viewport. The Lichess embed needs ~92px above/below the board for
   the player bars, so board width = --h - 92px. Below 900px --h is ignored and boards fill the width. */
.grid{--h:max(300px,min(calc((100vh - 13.5rem) / 2),calc((100vw - 6rem) / 4 - 1.5rem + 92px)));display:flex;flex-wrap:wrap;justify-content:center;gap:.5rem 1rem}
.card{display:flex;flex-direction:column;gap:.1rem}
.cap{font-size:.8rem;display:flex;gap:.5rem;align-items:baseline;white-space:nowrap;width:calc(var(--h) - 92px + 1.2rem)}
.cap .name{overflow:hidden;text-overflow:ellipsis;flex:1}
.cap .score{font-variant-numeric:tabular-nums;min-width:2.5em;text-align:right}
.board{display:flex;gap:.3rem;height:var(--h)}
.board iframe{height:100%;width:calc(var(--h) - 92px);border:0;border-radius:6px;background:var(--box-bg)}
.eval{width:.6rem;border-radius:3px;background:#403d39;position:relative;overflow:hidden;flex:none}
.eval::after{content:"";position:absolute;inset:auto 0 0 0;height:var(--w,50%);background:#f0ede6;transition:height .6s}
@media (max-width:900px){section{width:auto}.grid{--h:auto}.card{width:100%}.cap{width:auto}.board{height:auto}.board iframe{width:calc(100% - .9rem);aspect-ratio:1/1.28}}
.muted{opacity:.7}.err{color:var(--bad-fg)}
form.sec{display:grid;gap:.4rem;max-width:720px;margin-bottom:1.5rem}
`;

// Stockfish 10 (60 KB js + 358 KB wasm, single-threaded, no COOP/COEP headers needed) in a worker.
// The worker reads its wasm path from the URL hash, so a blob worker can point at the CDN.
const EVAL_JS = `
const base="https://cdn.jsdelivr.net/npm/stockfish@10.0.2/src/";
const w=new Worker(URL.createObjectURL(new Blob(['importScripts("'+base+'stockfish.js")'],{type:"text/javascript"}))+"#"+base+"stockfish.wasm");
let queue=[],cur=null;
w.onmessage=e=>{const s=String(e.data),m=s.match(/score (cp|mate) (-?\\d+)/);if(m&&cur)cur.score=m;if(s.startsWith("bestmove")){paint(cur);cur=null;next()}};
function next(){if(cur||!queue.length)return;cur=queue.shift();w.postMessage("position fen "+cur.fen);w.postMessage("go depth 12")}
function paint({card,fen,score}){if(!score)return;let v=+score[2];if(fen.split(" ")[1]==="b")v=-v;
  const mate=score[1]==="mate",pct=mate?(v>0?100:0):50+50*(2/(1+Math.exp(-0.004*v))-1);
  card.querySelector(".eval").style.setProperty("--w",pct+"%");
  card.querySelector(".score").textContent=mate?"M"+Math.abs(v):(v>0?"+":"")+(v/100).toFixed(1)}
async function refresh(){const fens=await fetch("/round/"+document.body.dataset.round+"/fens").then(r=>r.json()).catch(()=>({}));
  queue=Object.entries(fens).flatMap(([id,fen])=>{const card=document.querySelector('[data-game="'+id+'"]');return card?[{card,fen}]:[]});next()}
refresh();setInterval(refresh,60000);document.addEventListener("htmx:afterSwap",refresh);
`;

const layout = (title: string, body: any, attrs = "") => html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><link rel="stylesheet" href="https://unpkg.com/missing.css@1.3.0"><script src="https://unpkg.com/htmx.org@2"></script><style>${raw(CSS)}</style></head>
<body ${raw(attrs)}>${body}</body></html>`;

const nav = (n: number, base = "/round") =>
  html`<nav>${Array.from({ length: ROUNDS }, (_, i) => i + 1).map((i) => html`<a href="${base}/${i}" ${i === n ? raw('aria-current="page"') : ""}>R${i}</a>`)}</nav>`;

const section = (s: Section, d: SectionData) => html`<section>
<h2>${s === "open" ? "Open" : "Women"}</h2>
${d.error ? html`<p class="err">${d.error}</p>` : ""}
${d.boards.length
    ? html`<div class="grid">${d.boards.map(
        (b) => html`<div class="card" data-game="${b.gameId}">
<div class="cap"><b><a href="${gameUrl(b)}" target="_blank" rel="noopener">Board ${b.boardNo} ↗</a></b><span class="name"></span><b>${b.status === "*" ? "" : b.status}</b><span class="score"></span></div>
<div class="board"><div class="eval" title="Engine eval (white's side fills from the bottom)"></div><iframe src="${embedUrl(b)}" title="Board ${b.boardNo}: ${b.name}"></iframe></div></div>`,
      )}</div>`
    : d.error ? "" : html`<p class="muted">Pairings not published yet.</p>`}</section>`;

const grid = (n: number, d: RoundData) => html`<div id="grid" hx-get="/round/${n}/grid?h=${hashOf(d)}" hx-trigger="every 60s" hx-swap="outerHTML">
${SECTIONS.map((s) => section(s, d[s]))}</div>`;

const page = (n: number, d: RoundData) =>
  layout(
    `${TEAM} – Olympiad Round ${n}`,
    html`<header><h1>${TEAM} at the Chess Olympiad</h1>${nav(n)}</header>${grid(n, d)}<script>${raw(EVAL_JS)}</script>`,
    `data-round="${n}"`,
  );

const adminPage = (n: number, d: RoundData, ov: Overrides[string], msg = "") =>
  layout(`Admin – Round ${n}`, html`<header><h1>Admin – Round ${n}</h1>${nav(n, "/admin/round")}</header>
${msg ? html`<p class="err">${msg}</p>` : ""}
${SECTIONS.map((s) => html`<h2>${s} <span class="chip">${d[s].manual ? "manual" : "auto"}</span></h2>
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
  return n ? c.html(page(n, await boards(n))) : c.notFound();
});

app.get("/round/:n/grid", async (c) => {
  const n = roundNo(c.req.param("n"));
  if (!n) return c.notFound();
  const d = await boards(n);
  return c.req.query("h") === hashOf(d) ? c.body(null, 204) : c.html(grid(n, d));
});

app.get("/round/:n/fens", async (c) => {
  const n = roundNo(c.req.param("n"));
  if (!n) return c.notFound();
  const d = await boards(n);
  return c.json(Object.fromEntries(SECTIONS.flatMap((s) => d[s].boards.filter((b) => b.fen).map((b) => [b.gameId, b.fen]))));
});

app.use("/admin/*", async (c, next) => {
  if (!ADMIN_PASSWORD) return c.text("Set ADMIN_PASSWORD to enable the admin panel.", 503);
  return basicAuth({ username: "admin", password: ADMIN_PASSWORD })(c, next);
});

app.get("/admin/round/:n", async (c) => {
  const n = roundNo(c.req.param("n"));
  if (!n) return c.notFound();
  const [d, ov] = await Promise.all([boards(n), readOverrides()]);
  return c.html(adminPage(n, d, ov[n] ?? {}));
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
