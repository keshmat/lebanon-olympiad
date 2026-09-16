import { expect, test } from "bun:test";
import { get, parseRef, pickFed } from "./server.ts";

const g = (id: string, feds: string[]) => ({ id, name: id, status: "*", players: feds.map((fed) => ({ fed })) });

test("pickFed keeps only games with a player from the federation, in order", () => {
  const out = pickFed([g("a", ["UZB", "JAM"]), g("b", ["LBN", "KHM"]), g("c", ["KHM", "LBN"])], "LBN", "R1");
  expect(out.map((b) => b.gameId)).toEqual(["b", "c"]);
  expect(out.map((b) => b.boardNo)).toEqual([1, 2]);
  expect(out[0].roundId).toBe("R1");
});

test("parseRef accepts a Lichess URL or roundId/gameId", () => {
  const want = { roundId: "B2BIs1MS", gameId: "8wlAzKdt" };
  expect(parseRef("https://lichess.org/broadcast/some-slug/round-1/B2BIs1MS/8wlAzKdt")).toEqual(want);
  expect(parseRef("https://lichess.org/embed/broadcast/-/-/B2BIs1MS/8wlAzKdt/")).toEqual(want);
  expect(parseRef("  B2BIs1MS/8wlAzKdt ")).toEqual(want);
  expect(parseRef("nope")).toBeNull();
});

test("get serves stale data on fetch failure and does not retry within ttl", async () => {
  let calls = 0;
  const real = globalThis.fetch;
  globalThis.fetch = (async () => (++calls === 1 ? Response.json({ v: 1 }) : new Response("slow down", { status: 429 }))) as any;
  try {
    expect(await get("u", 0)).toEqual({ v: 1 }); // ttl 0 → every call refetches
    expect(await get("u", 0)).toEqual({ v: 1 }); // 429 → stale value
    expect(calls).toBe(2);
    expect(await get("u", 120_000)).toEqual({ v: 1 }); // fresh enough → cache hit
    expect(calls).toBe(2);
    const err = await get("fresh-url", 0).then(() => null, (e) => String(e)); // no stale copy → error surfaces
    expect(err).toContain("429");
  } finally {
    globalThis.fetch = real;
  }
});
