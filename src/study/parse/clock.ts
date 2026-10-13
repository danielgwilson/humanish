import { isRecord } from "../../run/type-guards.js";
import type { StudyParseFailure } from "../types.js";
import { invalid } from "./values.js";

/**
 * A participant's clock, `actor.clock` or `participants[].clock`: `{ timeZone }`. Each turn gives the
 * participant the time in the zone, and a hosted desktop launches its browser with TZ set to it.
 * Chrome reads TZ through ICU, which takes only a tz database name spelled with its capitals: on
 * TZ=+05:00 it runs in UTC, and on TZ=europe/london it reports Etc/Unknown, though Intl here
 * accepts both. So the zone must be a name Intl knows that is not a UTC offset and is spelled with
 * capitals. Intl gives no case-sensitive check: it spells europe/belfast as Europe/London, and its
 * supportedValuesOf omits aliases such as Europe/Belfast. So the rule is the one every tz database name
 * keeps: each part between slashes starts with a capital, and a case variant of Intl's spelling is
 * refused. A miscased letter after the first in a part of an alias (Europe/BELFAST) still passes.
 */
export function parseClock(
  raw: unknown,
  path: string,
): { ok: true; value: { timeZone: string } | undefined } | StudyParseFailure {
  if (raw === undefined) return { ok: true, value: undefined };
  const timeZone = isRecord(raw) ? raw.timeZone : undefined;
  const resolved = typeof timeZone === "string" ? intlSpelling(timeZone) : undefined;
  if (typeof timeZone !== "string" || resolved === undefined)
    return invalid(
      `${path} must be { timeZone }, with timeZone a time zone name such as "Europe/London": the participant's local time, which each turn tells it and its hosted browser runs in.`,
    );
  if (/^[+-]/.test(resolved))
    return invalid(
      `${path}.timeZone "${timeZone}" is a UTC offset, and a browser's time zone takes only a time zone name. Write the name of a place in that zone, such as "Asia/Karachi" for +05:00.`,
    );
  if (
    /(^|\/)[^A-Z]/.test(timeZone) ||
    (resolved !== timeZone && resolved.toLowerCase() === timeZone.toLowerCase())
  )
    return invalid(
      `${path}.timeZone "${timeZone}" must be written with the capitals of a time zone name, such as "${resolved}" for this zone: the browser reads a time zone name only with its capitals.`,
    );
  return { ok: true, value: { timeZone } };
}

/** How Intl spells the time zone `name`, or undefined when Intl does not know it. */
function intlSpelling(name: string): string | undefined {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}
