/*
 * Eval bars. Runs Stockfish 10 (WASM, ~420 KB) in a Web Worker straight from a CDN and
 * evaluates each board's current position once a minute.
 *
 * Why a Blob worker: browsers refuse `new Worker("https://cdn/...")` cross-origin, but a
 * worker created from a same-origin Blob may importScripts() from anywhere. This Stockfish
 * build reads its .wasm location from the worker URL's hash, hence the "#..." suffix.
 */
const CDN = "https://cdn.jsdelivr.net/npm/stockfish@10.0.2/src/";
const workerSource = new Blob([`importScripts("${CDN}stockfish.js")`], { type: "text/javascript" });
const engine = new Worker(URL.createObjectURL(workerSource) + "#" + CDN + "stockfish.wasm");

/** Positions waiting to be evaluated, and the one the engine is on now. One search at a time. */
let queue = [];
let current = null;

// The engine speaks UCI: "info ... score cp 46 ..." lines, then "bestmove ..." when the search ends.
engine.onmessage = (event) => {
  const line = String(event.data);
  const score = line.match(/score (cp|mate) (-?\d+)/);
  if (score && current) current.score = score;
  if (line.startsWith("bestmove")) {
    paint(current);
    current = null;
    next();
  }
};

function next() {
  if (current || !queue.length) return;
  current = queue.shift();
  engine.postMessage("position fen " + current.fen);
  engine.postMessage("go depth 12");
}

/** Convert the engine's side-to-move score into white's share of the bar and a label like "+0.4" or "M3". */
function paint({ card, fen, score }) {
  if (!score) return;
  const kind = score[1]; // "cp" (centipawns) or "mate" (moves to mate)
  let value = Number(score[2]);
  if (fen.split(" ")[1] === "b") value = -value; // UCI scores are from the side to move; normalise to white
  const whitePercent = kind === "mate" ? (value > 0 ? 100 : 0) : 50 + 50 * (2 / (1 + Math.exp(-0.004 * value)) - 1);
  card.querySelector(".eval").style.setProperty("--w", whitePercent + "%");
  card.querySelector(".score").textContent = kind === "mate" ? "M" + Math.abs(value) : (value > 0 ? "+" : "") + (value / 100).toFixed(1);
}

/** Fetch { gameId: fen } for this round and queue every board that is on the page. */
async function refresh() {
  const roundNo = document.body.dataset.round;
  const fens = await fetch(`/round/${roundNo}/fens`).then((response) => response.json()).catch(() => ({}));
  queue = Object.entries(fens).flatMap(([gameId, fen]) => {
    const card = document.querySelector(`[data-game="${gameId}"]`);
    return card ? [{ card, fen }] : [];
  });
  next();
}

refresh();
setInterval(refresh, 60_000);
// htmx fires this after it swaps in a new grid; the new cards start with empty bars.
document.addEventListener("htmx:afterSwap", refresh);
