import { describe, expect, it } from "vitest";
import { decodeEscapes } from "../../src/evidence/encoded-text.js";
import { scrubSecretValues } from "../../src/evidence/secret-scrub.js";
import {
  registerTransientCommsSecrets,
  transientCommsKnownValueScrub,
  withTransientCommsSecrets,
} from "../../src/run/transient-comms-secrets.js";
import {
  generateText,
  generateValues,
  showScrubInput,
  smallerScrubInputs,
  survivingForm,
  WRITTEN_MARKERS,
  type ScrubInput,
} from "../helpers/scrub-model.js";
import {
  checkProperty,
  propertyRun,
  seededRandom,
  type Property,
} from "../helpers/seeded-random.js";

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
        survivingForm(values, decodeEscapes(text)) === undefined,
      withoutValue: decodeEscapes,
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

const run = propertyRun(400);

function property(
  holdsValues: boolean,
  check: (input: ScrubInput) => Promise<string | undefined>,
): Property<ScrubInput> {
  return {
    generate: (random) => {
      const values = generateValues(random);
      return { values, text: generateText(random, values, holdsValues) };
    },
    check,
    shrink: smallerScrubInputs,
    show: showScrubInput,
  };
}

const MIB = 1024 * 1024;

/** `unit` repeated to at least `length` characters. */
const repeatTo = (unit: string, length: number): string =>
  unit.repeat(Math.ceil(length / unit.length));

/** Generated text that holds the values, at least `length` characters long. */
function generatedText(values: readonly string[], length: number): string {
  const random = seededRandom(run.seed);
  let text = "";
  while (text.length < length) text += `${generateText(random, values, true)}\n`;
  return text;
}

const VALUE = ["743921"];
const SHAPES: [string, readonly string[], (length: number) => string][] = [
  ["markers and percent-escaped values", VALUE, (n) => repeatTo("[REDACTED_SECRET]%20743921 ", n)],
  ["marker-shaped spans that hold hex", VALUE, (n) => repeatTo("[REDACTED_373433393231] ", n)],
  ["one percent run", VALUE, (n) => `${repeatTo("%41", n / 2)}743921${repeatTo("%41", n / 2)}`],
  ["escapes split by markers", VALUE, (n) => repeatTo("7%343921[REDACTED_SECRET]\\u0037", n)],
  ["generated text", ["tango-lima", "743921"], (n) => generatedText(["tango-lima", "743921"], n)],
];

/** The fastest of three scrubs of the text, in milliseconds. */
async function fastest(scrub: Scrub, values: readonly string[], text: string): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = performance.now();
    await scrub(values, text);
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe.each(scrubs)("%s against the reference model", (_name, scrubUnderTest) => {
  const { scrub, holdsNoValue, withoutValue } = scrubUnderTest;

  it("leaves no form of a value in the output or in either decoding of it", async () => {
    expect(
      await checkProperty(
        property(true, async ({ values, text }) => {
          const output = await scrub(values, text);
          const found = survivingForm(values, output);
          return found && `scrubbed to ${JSON.stringify(output)}, which holds ${found}`;
        }),
        run,
      ),
    ).toBeUndefined();
  });

  it("returns text that holds no value as it promises", async () => {
    expect(
      await checkProperty(
        property(false, async ({ values, text }) => {
          if (!holdsNoValue(values, text)) return undefined;
          const output = await scrub(values, text);
          return output === withoutValue(text) ? undefined : `changed to ${JSON.stringify(output)}`;
        }),
        run,
      ),
    ).toBeUndefined();
  });

  // Quadrupling the text takes about four times as long, and a quadratic scrub sixteen times. A
  // scrub that compared each find with every marker took about 6 s on the first shape at 1 MiB.
  it.each(SHAPES)("scrubs %s in time linear in its length", async (_shape, values, build) => {
    const [quarter, whole] = [build(MIB / 4), build(MIB)];
    await scrub(values, quarter);
    const ratio =
      (await fastest(scrub, values, whole)) / Math.max(5, await fastest(scrub, values, quarter));
    expect(ratio).toBeLessThan(8);
    expect(survivingForm(values, await scrub(values, whole))).toBeUndefined();
  });
});
