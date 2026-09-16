/**
 * Everything that talks to Lichess: a small memoising fetch, the broadcast
 * API shapes we rely on, and the logic that finds our federation's boards.
 *
 * Request budget matters here. Lichess answers 429 to bursts, so:
 *   - every URL is cached (60 s for live rounds, 10 min for tour lists),
 *   - real fetches are spaced 200 ms apart,
 *   - a failed refetch serves the last good value instead of an error,
 *   - the 9-section search runs once per round and is remembered.
 * Steady state is about 2 requests per minute.
 */
import { FED, SEED_TOUR_ID } from "./config.ts";
import { readOverrides, SECTIONS, type GameRef, type Section } from "./overrides.ts";

const API = "https://lichess.org/api/broadcast";

// ---------- API shapes (only the fields we read) ----------

type Player = { fed?: string; name?: string; team?: string };
type Game = { id: string; name: string; status: string; fen?: string; players: Player[] };

/** GET /api/broadcast/-/-/{roundId}  (slugs may be "-") */
type RoundJson = {
  round: { id: string; name: string };
  tour: { id: string; name: string };
  games: Game[];
};

/** GET /api/broadcast/{tourId} */
type TourJson = {
  tour: { id: string; name: string };
  rounds: { id: string; name: string; startsAt?: number }[];
  group?: { tours: { id: string; name: string }[] };
};

// ---------- memoising, paced fetch ----------

type CacheEntry = { fetchedAt: number; promise: Promise<any>; lastGood?: any };
const cache = new Map<string, CacheEntry>();

/** Time slot of the next allowed real fetch; keeps fetches ≥200 ms apart even when several miss the cache at once. */
let nextSlot = 0;
function pacedFetch(url: string): Promise<Response> {
  nextSlot = Math.max(nextSlot + 200, Date.now());
  return Bun.sleep(nextSlot - Date.now()).then(() => {
    console.log("fetch", url.slice(API.length));
    return fetch(url);
  });
}

/**
 * Fetch JSON with a TTL cache. Concurrent callers share one in-flight promise.
 * If a refetch fails (typically a 429) and we have a previous good value, return that;
 * the failed attempt is still cached, so the URL is not retried before the TTL elapses.
 */
export function getJson<T>(url: string, ttlMs = 60_000): Promise<T> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.fetchedAt < ttlMs) return hit.promise;

  const entry: CacheEntry = { fetchedAt: Date.now(), lastGood: hit?.lastGood, promise: undefined as any };
  entry.promise = pacedFetch(url)
    .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`Lichess ${response.status} for ${url}`))))
    .then((json) => (entry.lastGood = json))
    .catch((error) => (entry.lastGood !== undefined ? entry.lastGood : Promise.reject(error)));
  cache.set(url, entry);
  return entry.promise;
}

const getRound = (roundId: string) => getJson<RoundJson>(`${API}/-/-/${roundId}`);
const getTour = (tourId: string) => getJson<TourJson>(`${API}/${tourId}`, 600_000);

// ---------- boards ----------

export type Board = {
  boardNo: number;
  roundId: string;
  gameId: string;
  /** "White, Name - Black, Name" as Lichess formats it */
  name: string;
  /** "*" while playing, otherwise "1-0", "0-1", "½-½" */
  status: string;
  /** Current position, used by the browser-side engine for the eval bar */
  fen?: string;
};

export const embedUrl = (board: Board) => `https://lichess.org/embed/broadcast/-/-/${board.roundId}/${board.gameId}`;
export const gameUrl = (board: Board) => `https://lichess.org/broadcast/-/-/${board.roundId}/${board.gameId}`;

/** Games in which one player belongs to the federation, in Lichess order (which is board order). */
export function pickFederationGames(games: Game[], fed: string, roundId: string): Board[] {
  return games
    .filter((game) => game.players.some((player) => player.fed === fed))
    .map((game, index) => ({ boardNo: index + 1, roundId, gameId: game.id, name: game.name, status: game.status, fen: game.fen }));
}

/** Every round of every section tour in the group, flattened: [{ roundNo, roundId, tourName, startsAt }]. */
export async function allRounds() {
  const seed = await getTour(SEED_TOUR_ID);
  const tours: TourJson[] = [];
  for (const tour of seed.group?.tours ?? [seed.tour]) tours.push(await getTour(tour.id)); // sequential on purpose
  return tours.flatMap((tour) =>
    tour.rounds.map((round, index) => ({
      roundNo: Number(round.name.match(/\d+/)?.[0] ?? index + 1),
      roundId: round.id,
      tourName: tour.tour.name,
      startsAt: round.startsAt ?? Infinity,
    })),
  );
}

/** Round number of the latest round that has started, or 1. */
export async function currentRoundNo(): Promise<number> {
  const now = Date.now();
  const rounds = await allRounds().catch(() => []);
  return Math.max(1, ...rounds.filter((round) => round.startsAt <= now).map((round) => round.roundNo));
}

/**
 * Detection is remembered per round+section. Once found, a board's ids never change,
 * so afterwards we only poll the one or two rounds the team plays in.
 * An empty result (pairings not published yet) is retried after 5 minutes.
 */
const detected = new Map<string, { at: number; refs: GameRef[] }>();

async function detectRefs(roundNo: number, section: Section): Promise<GameRef[]> {
  const key = `${roundNo}:${section}`;
  const hit = detected.get(key);
  if (hit && (hit.refs.length || Date.now() - hit.at < 300_000)) return hit.refs;

  const found: Record<Section, GameRef[]> = { open: [], women: [] };
  for (const round of (await allRounds()).filter((round) => round.roundNo === roundNo)) {
    const roundJson = await getRound(round.roundId);
    const target: Section = round.tourName.includes("Women") ? "women" : "open";
    found[target].push(...pickFederationGames(roundJson.games, FED, round.roundId).map(({ roundId, gameId }) => ({ roundId, gameId })));
  }
  for (const each of SECTIONS) detected.set(`${roundNo}:${each}`, { at: Date.now(), refs: found[each] });
  return found[section];
}

export type SectionData = { boards: Board[]; manual: boolean; error?: string };
export type RoundData = Record<Section, SectionData>;

/**
 * The boards to show for a round: an admin override if one exists, otherwise auto-detected.
 * Each section fails independently so one Lichess error never blanks the whole page.
 */
export async function boardsForRound(roundNo: number): Promise<RoundData> {
  const overrides = (await readOverrides())[roundNo] ?? {};
  const result = {} as RoundData;
  for (const section of SECTIONS) {
    const manual = !!overrides[section];
    try {
      const refs = overrides[section] ?? (await detectRefs(roundNo, section));
      const boards: Board[] = [];
      for (const [index, ref] of refs.entries()) {
        const roundJson = await getRound(ref.roundId);
        const game = roundJson.games.find((game) => game.id === ref.gameId);
        // Broadcasters occasionally re-create games with new ids; forget the detection so it runs again next poll.
        if (!game && !manual) detected.delete(`${roundNo}:${section}`);
        boards.push({ boardNo: index + 1, ...ref, name: game?.name ?? "(game not found in round)", status: game?.status ?? "?", fen: game?.fen });
      }
      result[section] = { boards, manual };
    } catch (error) {
      result[section] = { boards: [], manual, error: String(error) };
    }
  }
  return result;
}

/**
 * Fingerprint of "which boards, and are they finished". The grid only re-renders
 * when this changes. FENs are deliberately left out: moves change every few seconds
 * and reach the browser through the iframes, not through a grid swap.
 */
export const gridHash = (data: RoundData) =>
  String(Bun.hash(JSON.stringify(SECTIONS.map((section) => data[section].boards.map((board) => [board.gameId, board.status])))));
