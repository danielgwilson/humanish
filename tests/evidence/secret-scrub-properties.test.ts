import { describe, expect, it } from "vitest";
import { scrubSecretValues } from "../../src/evidence/secret-scrub.js";
import {
  registerTransientCommsSecrets,
  transientCommsKnownValueScrub,
  withTransientCommsSecrets,
} from "../../src/run/transient-comms-secrets.js";
import {
  generateText,
  generateValues,
  keepsSpelling,
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

/** Whether a value is part of a written marker, such as `CRET` or `_PATH`. */
const partOfMarker = (values: readonly string[]): boolean =>
  values.some((value) => WRITTEN_MARKERS.some((marker) => marker.includes(value)));

interface ScrubUnderTest {
  readonly scrub: Scrub;
  /**
   * Whether the scrub may change a marker's text for these values. The transient scrub's literal
   * pass replaces a value that is part of a marker inside that marker too, which reveals nothing.
   */
  readonly rewritesMarkers: (values: readonly string[]) => boolean;
}

const scrubs: [string, ScrubUnderTest][] = [
  [
    "scrubSecretValues",
    {
      scrub: async (values, text) => scrubSecretValues(values)(text),
      rewritesMarkers: () => false,
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
      rewritesMarkers: partOfMarker,
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

/** `unit` repeated to at least 1 MiB. */
const mebibyteOf = (unit: string): string => unit.repeat(Math.ceil(MIB / unit.length));

describe.each(scrubs)("%s against the reference model", (_name, { scrub, rewritesMarkers }) => {
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

  it("returns text that holds no value unchanged", async () => {
    expect(
      await checkProperty(
        property(false, async ({ values, text }) => {
          if (survivingForm(values, text) !== undefined || rewritesMarkers(values))
            return undefined;
          const output = await scrub(values, text);
          return output === text ? undefined : `changed to ${JSON.stringify(output)}`;
        }),
        run,
      ),
    ).toBeUndefined();
  });

  it("keeps the text around each value it replaces as written", async () => {
    expect(
      await checkProperty(
        property(true, async ({ values, text }) => {
          if (rewritesMarkers(values)) return undefined;
          const output = await scrub(values, text);
          return keepsSpelling(text, output) ? undefined : `scrubbed to ${JSON.stringify(output)}`;
        }),
        run,
      ),
    ).toBeUndefined();
  });

  // The bound is generous: a scrub that compared each find with every marker took about 6 s on
  // the first input.
  it.each([
    ["markers and percent-escaped values", ["743921"], mebibyteOf("[REDACTED_SECRET]%20743921 ")],
    ["marker-shaped spans that hold hex", ["743921"], mebibyteOf("[REDACTED_373433393231] ")],
    ["one percent run", ["743921"], `${mebibyteOf("%41")}743921${mebibyteOf("%41")}`],
    ["escapes split by markers", ["743921"], mebibyteOf("7%343921[REDACTED_SECRET]\\u0037")],
  ])("scrubs 1 MiB of %s in linear time", async (_shape, values, text) => {
    const started = performance.now();
    const output = await scrub(values, text);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(survivingForm(values, output)).toBeUndefined();
  });

  it("scrubs 1 MiB of generated text in linear time", async () => {
    const random = seededRandom(run.seed);
    const values = generateValues(random);
    let text = "";
    while (text.length < MIB) text += `${generateText(random, values, true)}\n`;
    const started = performance.now();
    const output = await scrub(values, text);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(survivingForm(values, output)).toBeUndefined();
  });
});
