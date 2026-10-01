// A loop golden's `log` records every port call the loop made, in order (loop-golden.ts). The
// golden is the same JSON value as before; only the layout changes: each logged call is written on
// one line instead of one line per array element, so a golden diff still shows which call changed
// and every value it carried.

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function mapLog(outcome: Json, call: (entry: unknown) => unknown): Json {
  return Array.isArray(outcome.log) ? { ...outcome, log: outcome.log.map(call) } : outcome;
}

/** A loop outcome, or a record of named outcomes, mapping each logged call. */
function mapLogs(value: unknown, call: (entry: unknown) => unknown): unknown {
  if (!isRecord(value)) return value;
  if (Array.isArray(value.log)) return mapLog(value, call);
  return Object.fromEntries(
    Object.entries(value).map(([name, outcome]) => [
      name,
      isRecord(outcome) ? mapLog(outcome, call) : outcome,
    ]),
  );
}

/** The golden text: JSON indented by two spaces, with each logged call on one line. */
export function loopGoldenText(value: unknown): string {
  const calls: unknown[] = [];
  const placed = mapLogs(value, (entry) => {
    calls.push(entry);
    return `\u0000call ${calls.length - 1}\u0000`;
  });
  return `${JSON.stringify(placed, null, 2).replace(
    /"\\u0000call (\d+)\\u0000"/g,
    (_match, index: string) => JSON.stringify(calls[Number(index)]),
  )}\n`;
}
