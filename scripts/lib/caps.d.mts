/** Types for caps.mjs, which the plain-node prose checker imports without a build step. */
export const CAPS_FILE: string;

export function readCaps(file?: string): Record<string, unknown>;

export function flattenCaps(
  caps: Record<string, unknown>,
  prefix?: string,
): { flat: Map<string, number>; invalid: string[] };

export function holdToCaps(options: {
  caps: ReadonlyMap<string, number>;
  counts: ReadonlyMap<string, readonly string[]>;
  list?: boolean;
  file?: string;
  write: (text: string) => void;
}): { ok: boolean; rose: string[] };
