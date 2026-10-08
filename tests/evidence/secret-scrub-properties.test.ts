import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { scrubSecretValues } from "../../src/evidence/secret-scrub.js";
import {
  registerTransientCommsSecrets,
  transientCommsKnownValueScrub,
  withTransientCommsSecrets,
} from "../../src/run/transient-comms-secrets.js";
import { propertyParameters, scrubInputs, type ScrubInput } from "../helpers/scrub-arbitraries.js";
import { modelDecode, survivingForm, WRITTEN_MARKERS } from "../helpers/scrub-model.js";

type Scrub = (values: readonly string[], text: string) => Promise<string>;

interface ScrubUnderTest {
  readonly scrub: Scrub;
  /** Whether the text holds no value, so the scrub returns it as `withoutValue` does. */
  readonly holdsNoValue: (values: readonly string[], text: string) => boolean;
  readonly withoutValue: (text: string) => string;
}

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
        survivingForm(values, text) === undefined &&
        !values.some((value) => WRITTEN_MARKERS.some((marker) => marker.includes(value))),
      withoutValue: (text) => text,
    },
  ],
];

const parameters = propertyParameters();
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
  const { scrub, holdsNoValue, withoutValue } = scrubUnderTest;

  it("leaves no form of a value in any reading of the output", async () => {
    await fc.assert(
      fc.asyncProperty(scrubInputs({ holdsValues: true }), async ({ values, text }) => {
        expect(survivingForm(values, await scrub(values, text))).toBeUndefined();
      }),
      parameters,
    );
  });

  // Replacing the whole text passes the property above by itself. It covers a value encoded twice,
  // a value that holds a bracket and so can be spelled again at a marker's edge, and a value that
  // holds an escape, which decoding turns into another string. Without those it must stay rare, so
  // that the replacements pass the property.
  it("replaces values in place when none is encoded twice or holds a marker or escape character", async () => {
    const inputs = scrubInputs({
      holdsValues: true,
      twiceEncoded: false,
      markerOrEscapeCharacters: false,
    });
    await fc.assert(
      fc.asyncProperty(inputs, async ({ values, text }) => {
        expect(survivingForm(values, await scrub(values, text))).toBeUndefined();
      }),
      parameters,
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
