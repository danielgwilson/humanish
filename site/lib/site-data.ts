/**
 * Facts the homepage renders. Every number here is read from a kept run bundle or a
 * committed receipt; the link beside each one is where a reader checks it. Update the
 * receipt first, then this file.
 */
export const GITHUB = "https://github.com/danielgwilson/humanish";
export const RECEIPTS = `${GITHUB}/blob/main/docs/goals/computer-use-actor/receipts`;
export const BENCH = `${GITHUB}/blob/main/bench`;
/** The root package.json version, read at build time by next.config.mjs. */
export const VERSION = process.env.NEXT_PUBLIC_HUMANISH_VERSION ?? "0.0.0";
/** The CLI's minimum Node version from the root package.json engines, read by next.config.mjs. */
export const NODE_FLOOR = process.env.NEXT_PUBLIC_HUMANISH_NODE ?? "22.19";
