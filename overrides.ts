/**
 * Manual board overrides, set from the admin panel.
 *
 * File shape (data/overrides.json):
 *   { "3": { "open": [ { roundId, gameId }, ... ], "women": [ ... ] } }
 *
 * A round/section that has an entry is shown exactly as listed and is never
 * auto-detected. Delete the entry (empty all four inputs in the admin form)
 * to go back to automatic detection.
 */
import { renameSync } from "node:fs";
import { DATA_DIR } from "./config.ts";

const FILE = `${DATA_DIR}/overrides.json`;

export type GameRef = { roundId: string; gameId: string };
export type Section = "open" | "women";
export const SECTIONS: Section[] = ["open", "women"];
export type Overrides = Record<string, Partial<Record<Section, GameRef[]>>>;

/** Missing or malformed file counts as "no overrides" rather than an error. */
export async function readOverrides(): Promise<Overrides> {
  try {
    return JSON.parse(await Bun.file(FILE).text());
  } catch {
    return {};
  }
}

/** Write to a temp file then rename, so a crash mid-write never leaves a half-written file. */
export async function writeOverrides(overrides: Overrides): Promise<void> {
  await Bun.write(`${FILE}.tmp`, JSON.stringify(overrides, null, 2));
  renameSync(`${FILE}.tmp`, FILE);
}

/**
 * Accepts what an admin is likely to paste:
 *   https://lichess.org/broadcast/<tour-slug>/<round-slug>/<roundId>/<gameId>
 *   https://lichess.org/embed/broadcast/-/-/<roundId>/<gameId>
 *   <roundId>/<gameId>
 * Lichess ids are always 8 alphanumeric characters, so the last two path parts are enough.
 */
export function parseGameRef(input: string): GameRef | null {
  const match = input.trim().match(/([A-Za-z0-9]{8})\/([A-Za-z0-9]{8})\/?$/);
  return match ? { roundId: match[1], gameId: match[2] } : null;
}
