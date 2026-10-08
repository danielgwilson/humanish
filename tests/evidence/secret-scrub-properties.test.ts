import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { scrubSecretValues } from "../../src/evidence/secret-scrub.js";
import {
  registerTransientCommsSecrets,
  scrubTransientCommsText,
  transientCommsKnownValueScrub,
  withTransientCommsSecrets,
} from "../../src/run/transient-comms-secrets.js";
import {
  literalInputs,
  propertyParameters,
  scrubInputs,
  type ScrubInput,
} from "../helpers/scrub-arbitraries.js";
import {
  inOrder,
  modelDecode,
  modelLiteralScrub,
  outsideValues,
  survivingForm,
  touchesEscape,
  WRITTEN_MARKERS,
} from "../helpers/scrub-model.js";

type Scrub = (values: readonly string[], text: string) => Promise<string>;

interface ScrubUnderTest {
  readonly scrub: Scrub;
  /** Whether the text holds no value, so the scrub returns it as `withoutValue` does. */
  readonly holdsNoValue: (values: readonly string[], text: string) => boolean;
  readonly withoutValue: (text: string) => string;
  /** The readings of the text the scrub can return with values replaced. */
  readonly returned: (text: string) => string[];
  /** Whether the scrub keeps every character outside a value's occurrence for this input. */
  readonly keepsTheRest: (values: readonly string[], text: string) => boolean;
}

/** Whether a value is part of a written marker, such as `CRET` or `_PATH`. */
const partOfMarker = (values: readonly string[]): boolean =>
  values.some((value) => WRITTEN_MARKERS.some((marker) => marker.includes(value)));

const scrubs: [string, ScrubUnderTest][] = [
  [
    "scrubSecretValues",
    {
      scrub: async (values, text) => scrubSecretValues(values)(text),
      // The scrub returns decoded text. A value encoded twice still decodes from it, so the scrub
      // replaces the whole text.
      holdsNoValue: (values, text) =>
        survivingForm(values, text) === undefined &&
        survivingForm(values, modelDecode(text)) === undefined,
      withoutValue: modelDecode,
      returned: (text) => [modelDecode(text)],
      keepsTheRest: () => true,
    },
  ],
  [
    "transientCommsKnownValueScrub",
    {
      scrub: (values, text) =>
        withTransientCommsSecrets(async () => {
          registerTransientCommsSecrets([...values]);
          return transientCommsKnownValueScrub()(text);
        }),
      // The literal pass replaces a value that is part of a marker, such as `CRET`, inside the
      // marker too. That changes the marker's text and reveals nothing.
      holdsNoValue: (values, text) =>
        survivingForm(values, text) === undefined && !partOfMarker(values),
      withoutValue: (text) => text,
      // Text whose values only the literal pass found keeps its spelling; other text comes back
      // decoded.
      returned: (text) => [modelDecode(text), text],
      // The literal pass replaces a value as written, as main does, also inside a marker and
      // where it overlaps an escape: `0000` in `%200000` takes the `0` of `%20`, so the space
      // goes with it.
      keepsTheRest: (values, text) => !partOfMarker(values) && !touchesEscape(values, text),
    },
  ],
];

const parameters = propertyParameters();
const REDACTED = "[REDACTED_SECRET]";
// No value can hold this character, so a scrub keeps it unless it replaces the whole text.
const SENTINEL = "§kept§";

/** How often the scrub replaces the whole text of sampled inputs that start with the sentinel. */
async function wholeTextRate(scrub: Scrub, inputs: fc.Arbitrary<ScrubInput>): Promise<number> {
  const sample = fc.sample(inputs, { seed: parameters.seed, numRuns: 1000 });
  let replaced = 0;
  for (const { values, text } of sample)
    if (!(await scrub(values, `${SENTINEL} ${text}`)).includes(SENTINEL)) replaced += 1;
  return replaced / sample.length;
}

const MIB = 1024 * 1024;

/** `unit` repeated to at least `length` characters. */
const repeatTo = (unit: string, length: number): string =>
  unit.repeat(Math.ceil(length / unit.length));

// Eight generated inputs, whose texts repeat to the length a timing needs.
const GENERATED = fc.sample(scrubInputs({ holdsValues: true }), { seed: 1, numRuns: 8 });
const GENERATED_VALUES = [...new Set(GENERATED.flatMap(({ values }) => values))];
const GENERATED_TEXT = GENERATED.map(({ text }) => text).join("\n");

const VALUE = ["743921"];
const SHAPES: [string, readonly string[], (length: number) => string][] = [
  ["markers and percent-escaped values", VALUE, (n) => repeatTo("[REDACTED_SECRET]%20743921 ", n)],
  ["marker-shaped spans that hold hex", VALUE, (n) => repeatTo("[REDACTED_373433393231] ", n)],
  ["one percent run", VALUE, (n) => `${repeatTo("%41", n / 2)}743921${repeatTo("%41", n / 2)}`],
  ["escapes split by markers", VALUE, (n) => repeatTo("7%343921[REDACTED_SECRET]\\u0037", n)],
  ["generated text", GENERATED_VALUES, (n) => repeatTo(`${GENERATED_TEXT}\n`, n)],
];

/** The fastest of five scrubs of the text, in milliseconds. */
async function fastest(scrub: Scrub, values: readonly string[], text: string): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const started = performance.now();
    await scrub(values, text);
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe.each(scrubs)("%s against the reference model", (_name, scrubUnderTest) => {
  const { scrub, holdsNoValue, withoutValue, returned, keepsTheRest } = scrubUnderTest;

  it("leaves no form of a value in any reading of the output", async () => {
    await fc.assert(
      fc.asyncProperty(scrubInputs({ holdsValues: true }), async ({ values, text }) => {
        expect(survivingForm(values, await scrub(values, text))).toBeUndefined();
      }),
      parameters,
    );
  });

  // Replacing the whole text passes the property above by itself. It covers a value encoded twice,
  // one that only a reading other than the byte reading holds, and one that holds part of a
  // marker. For values of plain ASCII, never encoded twice, it must stay rare, and every other
  // character of the text must survive in order, so the replacements pass the property.
  it("replaces each value in place and keeps the rest of the text in order", async () => {
    const inputs = scrubInputs({
      holdsValues: true,
      twiceEncoded: false,
      unusualCharacters: false,
    });
    const strip = (text: string) => text.replaceAll(REDACTED, "");
    await fc.assert(
      fc.asyncProperty(inputs, async ({ values, text }) => {
        fc.pre(keepsTheRest(values, text));
        const output = await scrub(values, text);
        expect(survivingForm(values, output)).toBeUndefined();
        if (output === REDACTED) return;
        const kept = returned(text).map((reading) => strip(outsideValues(values, reading)));
        expect(kept.some((characters) => inOrder(characters, strip(output)))).toBe(true);
      }),
      { ...parameters, maxSkipsPerRun: 10 },
    );
    expect(await wholeTextRate(scrub, inputs)).toBeLessThanOrEqual(0.005);
  });

  it("returns text that holds no value as it promises", async () => {
    await fc.assert(
      fc.asyncProperty(scrubInputs({ holdsValues: false }), async ({ values, text }) => {
        fc.pre(holdsNoValue(values, text));
        expect(await scrub(values, text)).toBe(withoutValue(text));
      }),
      { ...parameters, maxSkipsPerRun: 10 },
    );
  });

  // Quadrupling the text takes about four times as long, and a quadratic scrub sixteen times. A
  // scrub that compared each find with every marker took about 6 s on the first shape at 1 MiB. The
  // 20 ms floor keeps timer noise on a fast run out of the ratio.
  it.each(SHAPES)("scrubs %s in time linear in its length", async (_shape, values, build) => {
    const [quarter, whole] = [build(MIB / 4), build(MIB)];
    await scrub(values, quarter);
    const ratio =
      (await fastest(scrub, values, whole)) / Math.max(20, await fastest(scrub, values, quarter));
    expect(ratio).toBeLessThan(10);
    expect(survivingForm(values, await scrub(values, whole))).toBeUndefined();
  });
});

// With a value of 32,768 characters registered, V8 refuses the regex and the scrub searches each
// value itself. No generated text holds a `~`, so that value changes no output.
describe.each([
  ["V8's regex", []],
  ["the search it falls back to", ["~".repeat(32_768)]],
])("scrubTransientCommsText through %s", (_path, extra: string[]) => {
  it(
    "replaces the longest value that starts at each position and searches on after it",
    async () => {
      await fc.assert(
        fc.asyncProperty(literalInputs(), async ({ values, text }) => {
          const scrubbed = await withTransientCommsSecrets(async () => {
            registerTransientCommsSecrets([...values, ...extra]);
            return scrubTransientCommsText(text);
          });
          expect(scrubbed).toBe(modelLiteralScrub(values)(text));
        }),
        parameters,
      );
      // V8 takes about a millisecond to refuse the regex in each case.
    },
    Math.max(20_000, parameters.numRuns * 5),
  );
});
