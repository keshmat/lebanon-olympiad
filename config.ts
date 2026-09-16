/**
 * All configuration comes from environment variables, read once at startup.
 * Every other module imports from here so there is a single place to look.
 */

export const PORT = Number(process.env.PORT ?? 3000);

/** Basic-auth password for /admin/*. When unset the admin panel is disabled. */
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

/**
 * Any one section tour of the Olympiad broadcast group (e.g. "Open | I").
 * Its JSON lists every section in the group, which is how we discover all 9 tours.
 */
export const SEED_TOUR_ID = process.env.SEED_TOUR_ID ?? "n1pPI5Q0";

/** FIDE federation code to look for on the boards, and the display name. */
export const FED = process.env.FED ?? "LBN";
export const TEAM = process.env.TEAM ?? "Lebanon";

/** Directory holding overrides.json. Mount a persistent disk here in production. */
export const DATA_DIR = process.env.DATA_DIR ?? "data";

/** Olympiad length. Round numbers are validated against this. */
export const ROUNDS = 11;
