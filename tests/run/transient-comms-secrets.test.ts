import { describe, expect, it } from "vitest";
import { redactText } from "../../src/evidence/redaction.js";
import {
  registerTransientCommsSecrets,
  scrubTransientCommsText,
  transientCommsKnownValueScrub,
  withTransientCommsSecrets,
} from "../../src/run/transient-comms-secrets.js";
import { survivingForm } from "../helpers/scrub-model.js";

/** The known-value scrub of `text` in a scope that holds `values`. */
const knownValueScrub = (values: string[], text: string): Promise<string> =>
  withTransientCommsSecrets(async () => {
    registerTransientCommsSecrets(values);
    return transientCommsKnownValueScrub()(text);
  });
const HEX = Buffer.from("743921").toString("hex");

describe("transient run narration secrets", () => {
  it("matches literal overlapping values longest-first without altering ordinary text", async () => {
    const code = "743921";
    const link = `https://example.test/verify?code=${code}&proof=[synthetic]+(value)$`;
    await withTransientCommsSecrets(async () => {
      registerTransientCommsSecrets([code, link, code, "Hi"]);
      expect(scrubTransientCommsText(`Opened ${link}; entered ${code}.`)).toBe(
        "Opened [REDACTED_SECRET]; entered [REDACTED_SECRET].",
      );
      expect(scrubTransientCommsText("Ordinary participant feedback.")).toBe(
        "Ordinary participant feedback.",
      );
      expect(scrubTransientCommsText("Hi. History remains useful.")).toBe(
        "Hi. History remains useful.",
      );
    });
    expect(scrubTransientCommsText(code)).toBe(code);
  });

  it("isolates nested invocations and restores the outer invocation", async () => {
    await withTransientCommsSecrets(async () => {
      registerTransientCommsSecrets(["outer-canary"]);
      await withTransientCommsSecrets(async () => {
        registerTransientCommsSecrets(["inner-canary"]);
        expect(scrubTransientCommsText("outer-canary inner-canary")).toBe(
          "outer-canary [REDACTED_SECRET]",
        );
      });
      expect(scrubTransientCommsText("outer-canary inner-canary")).toBe(
        "[REDACTED_SECRET] inner-canary",
      );
    });
  });

  it("does not retain a fallback registry outside a run or after a throwing run", async () => {
    registerTransientCommsSecrets(["outside-canary"]);
    expect(scrubTransientCommsText("outside-canary")).toBe("outside-canary");
    await expect(
      withTransientCommsSecrets(async () => {
        registerTransientCommsSecrets(["failed-run-canary"]);
        throw new Error("synthetic failure");
      }),
    ).rejects.toThrow("synthetic failure");
    await withTransientCommsSecrets(async () => {
      expect(scrubTransientCommsText("failed-run-canary")).toBe("failed-run-canary");
    });
  });

  it("refuses detached work after clearing a finished invocation's values", async () => {
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let detached!: Promise<void>;
    await withTransientCommsSecrets(async () => {
      registerTransientCommsSecrets(["detached-canary"]);
      detached = gate.then(() => {
        expect(() => scrubTransientCommsText("detached-canary")).toThrow(
          "TRANSIENT_NARRATION_SCOPE_CLOSED",
        );
        expect(() => registerTransientCommsSecrets(["late-canary"])).toThrow(
          "TRANSIENT_NARRATION_SCOPE_CLOSED",
        );
      });
    });
    resume();
    await detached;
  });

  it("fails closed after exceeding memory bounds, even if the registration error was caught", async () => {
    await withTransientCommsSecrets(async () => {
      registerTransientCommsSecrets(["earlier-canary"]);
      expect(() => registerTransientCommsSecrets(["x".repeat(65_537)])).toThrow(
        /^TRANSIENT_NARRATION_SECRET_LIMIT$/,
      );
      expect(() => scrubTransientCommsText("earlier-canary")).toThrow(
        /^TRANSIENT_NARRATION_SECRET_LIMIT$/,
      );
    });
  });

  // A received email's raw link is registered at any length up to 65,536 bytes, next to the code
  // it carries. One regex of the values refused a value of 32,768 characters, and the scope failed.
  it("scrubs a registered value of every length the registry accepts", async () => {
    for (const length of [32_768, 65_536]) {
      const link = `https://example.test/${"t".repeat(length - 21)}`;
      await withTransientCommsSecrets(async () => {
        registerTransientCommsSecrets([link, "743921"]);
        expect(scrubTransientCommsText(`opened ${link}, entered 743921.`)).toBe(
          "opened [REDACTED_SECRET], entered [REDACTED_SECRET].",
        );
        expect(transientCommsKnownValueScrub()(`opened ${link}`)).toBe("opened [REDACTED_SECRET]");
      });
    }
  });

  it("removes a literal value even when the text also holds an encoded one", async () => {
    const code = "743921";
    const hex = Buffer.from(code).toString("hex");
    await withTransientCommsSecrets(async () => {
      registerTransientCommsSecrets([code]);
      const scrub = transientCommsKnownValueScrub();
      for (const text of [`${code} [REDACTED_${code}]`, `${hex} then ${code}`]) {
        expect(scrub(text)).not.toContain(code);
        expect(scrub(text)).toContain("[REDACTED_SECRET]");
      }
    });
  });

  it("removes a value that holds an escape before decoding another value's encoded form", async () => {
    const code = "743921";
    const token = "pass%41word";
    const hex = Buffer.from(code).toString("hex");
    await withTransientCommsSecrets(async () => {
      registerTransientCommsSecrets([code, token]);
      const scrubbed = transientCommsKnownValueScrub()(`${token} and ${hex}`);
      expect(scrubbed).not.toContain(token);
      expect(scrubbed).not.toContain("passAword");
      expect(scrubbed).not.toContain(hex);
    });
  });
});

describe("the known-value scrub on encoded and marker-shaped text", () => {
  it("finds a value hex-encoded or split inside a marker-shaped span", async () => {
    for (const text of [`[REDACTED_${HEX}]`, "[REDACTED_74%33921]"])
      expect(await knownValueScrub(["743921"], text)).toBe("[REDACTED_[REDACTED_SECRET]]");
  });

  it("returns text with a value decoded, and text without one as written", async () => {
    expect(await knownValueScrub(["743921"], "a%20b 7%343921 c%2Fd")).toBe(
      "a b [REDACTED_SECRET] c/d",
    );
    expect(await knownValueScrub(["743921"], "a%20b c%2Fd")).toBe("a%20b c%2Fd");
    // The decoded text holds one more marker-shaped span than it had, and the value is gone.
    expect(await knownValueScrub(["743921"], `%5BREDACTED_SECRET%5D ${HEX}`)).toBe(
      "[REDACTED_SECRET] [REDACTED_SECRET]",
    );
  });

  it("keeps a value encoded twice as written when the text holds no other value", async () => {
    const twice = "%2537%2534%2533%2539%2532%2531";
    expect(await knownValueScrub(["743921"], `code ${twice}`)).toBe(`code ${twice}`);
  });

  it("removes a percent-encoded value with a non-ASCII character", async () => {
    expect(await knownValueScrub(["café-secret"], "refused caf%C3%A9-secret here")).toBe(
      "refused [REDACTED_SECRET] here",
    );
  });

  it("leaves no value that holds a marker when decoding puts text next to the marker", async () => {
    const values = ["[REDACTED_SECRET]x", "743921"];
    const scrubbed = await knownValueScrub(values, `[REDACTED_SECRET]x%78%78 ${HEX}`);
    expect(survivingForm(values, scrubbed)).toBeUndefined();
  });

  it("shows a value that is part of a marker only inside markers", async () => {
    for (const text of ["[REDACTED_SECRET]", "SECRET [REDACTED_SECRET]"])
      expect(survivingForm(["SECRET"], await knownValueScrub(["SECRET"], text))).toBeUndefined();
    // redactText writes [REDACTED_LOCAL_PATH] after the scrub; the value is the marker's own text.
    const redacted = redactText(await knownValueScrub(["LOCAL_PATH"], "/tmp/work LOCAL_PATH"));
    expect(redacted).toBe("[REDACTED_LOCAL_PATH] [REDACTED_SECRET]");
    expect(survivingForm(["LOCAL_PATH"], redacted)).toBeUndefined();
  });

  it("leaves a marker as it is when a value is the whole marker, which shows nothing more", async () => {
    expect(await knownValueScrub(["[REDACTED_SECRET]"], "[REDACTED_SECRET]")).toBe(
      "[REDACTED_SECRET]",
    );
  });

  it("checks its output after the last literal pass", async () => {
    // The literal pass rewrites the first value inside a marker, which then spells the second
    // value across the marker's edge.
    for (const [values, text] of [
      [["CRET", "T]]x"], "CRET]x%78"],
      [["CRET", "ET]]x"], "%43RETx"],
    ] as const) {
      const scrubbed = await knownValueScrub([...values], text);
      expect(survivingForm(values, scrubbed)).toBeUndefined();
    }
  });

  it("reads `&constructor;` as written and finds the value after it", async () => {
    const run = (first: string, count: number): string =>
      String.fromCharCode(...Array.from({ length: count }, (_, at) => first.charCodeAt(0) + at));
    const value = run("a", 26) + run("0", 10) + run("A", 4);
    const text = `&constructor; %61${value.slice(1)}${"!".repeat(40)}`;
    expect(await knownValueScrub([value], text)).toBe(
      `&constructor; [REDACTED_SECRET]${"!".repeat(40)}`,
    );
  });

  it("keeps the text around a value inside an entity it does not know", async () => {
    expect(await knownValueScrub(["value"], "a%20&xvaluey;z")).toBe("a%20&x[REDACTED_SECRET]y;z");
  });

  it("replaces the whole text when a reading other than the byte reading still holds a value", async () => {
    for (const [values, text] of [
      [["xÃ©z", "éàxx"], "x%C3%A9z é%C3%A0xx é%C3%A0xx"],
      [["xÃ©z€", "éàxx"], "x%C3%A9z€ é%C3%A0xx é%C3%A0xx"],
      [["éÃ©zz", "éàxx"], "é%C3%A9zz é%C3%A0xx é%C3%A0xx"],
      [["ab\\ncd", "743921"], "ab%5Cncd 743=39=32=31 743=39=32=31"],
    ] as const)
      expect(await knownValueScrub([...values], text)).toBe("[REDACTED_SECRET]");
  });

  // A value that overlaps itself, in a text of growing length. Comparing the value again at every
  // overlapping start took 153 ms at 32,768 characters and grew fourfold per doubling.
  it("scrubs a value that overlaps itself in time linear in the text", async () => {
    const elapsed = async (n: number): Promise<number> => {
      let best = Number.POSITIVE_INFINITY;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const started = performance.now();
        expect(await knownValueScrub(["éà".repeat(n / 4)], "é%C3%A0".repeat(n / 2))).toBe(
          "[REDACTED_SECRET]",
        );
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    expect((await elapsed(32_768)) / Math.max(5, await elapsed(8_192))).toBeLessThan(8);
  });
});
