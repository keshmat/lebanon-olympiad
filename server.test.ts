import { expect, test } from "bun:test";
import { getJson, pickFederationGames } from "./lichess.ts";
import { parseGameRef } from "./overrides.ts";

const game = (id: string, feds: string[]) => ({ id, name: id, status: "*", players: feds.map((fed) => ({ fed })) });

test("pickFederationGames keeps only games with a player from the federation, in order", () => {
  const boards = pickFederationGames([game("a", ["UZB", "JAM"]), game("b", ["LBN", "KHM"]), game("c", ["KHM", "LBN"])], "LBN", "R1");
  expect(boards.map((board) => board.gameId)).toEqual(["b", "c"]);
  expect(boards.map((board) => board.boardNo)).toEqual([1, 2]);
  expect(boards[0].roundId).toBe("R1");
});

test("parseGameRef accepts a Lichess URL or roundId/gameId", () => {
  const want = { roundId: "B2BIs1MS", gameId: "8wlAzKdt" };
  expect(parseGameRef("https://lichess.org/broadcast/some-slug/round-1/B2BIs1MS/8wlAzKdt")).toEqual(want);
  expect(parseGameRef("https://lichess.org/embed/broadcast/-/-/B2BIs1MS/8wlAzKdt/")).toEqual(want);
  expect(parseGameRef("  B2BIs1MS/8wlAzKdt ")).toEqual(want);
  expect(parseGameRef("nope")).toBeNull();
});

test("getJson serves stale data on fetch failure and does not retry within ttl", async () => {
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => (++calls === 1 ? Response.json({ v: 1 }) : new Response("slow down", { status: 429 }))) as any;
  try {
    expect(await getJson("u", 0)).toEqual({ v: 1 }); // ttl 0 → every call refetches
    expect(await getJson("u", 0)).toEqual({ v: 1 }); // 429 → stale value
    expect(calls).toBe(2);
    expect(await getJson("u", 120_000)).toEqual({ v: 1 }); // fresh enough → cache hit
    expect(calls).toBe(2);
    const error = await getJson("fresh-url", 0).then(() => null, (e) => String(e)); // no stale copy → error surfaces
    expect(error).toContain("429");
  } finally {
    globalThis.fetch = realFetch;
  }
});
