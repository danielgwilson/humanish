import { describe, expect, it } from "vitest";
import {
  registerTransientCommsSecrets,
  scrubTransientCommsText,
  transientCommsKnownValueScrub,
  withTransientCommsSecrets,
} from "../../src/run/transient-comms-secrets.js";

describe("transient run narration secrets", () => {
  it("removes a known value from generated text in every form, beside or inside redaction-shaped text", async () => {
    await withTransientCommsSecrets(async () => {
      registerTransientCommsSecrets(["743921", "café-secret"]);
      const scrub = transientCommsKnownValueScrub();
      const hex = Buffer.from("743921").toString("hex");
      expect(scrub("743921 [REDACTED_743921]")).toBe(
        "[REDACTED_SECRET] [REDACTED_[REDACTED_SECRET]]",
      );
      expect(scrub(`[REDACTED_${hex}] and [REDACTED_74%33921]`)).toBe(
        "[REDACTED_[REDACTED_SECRET]] and [REDACTED_[REDACTED_SECRET]]",
      );
      expect(scrub("signed in with caf%C3%A9-secret at 50%25")).toBe(
        "signed in with [REDACTED_SECRET] at 50%25",
      );
      expect(scrub("Ordinary text with [REDACTED_SECRET] and 50%25.")).toBe(
        "Ordinary text with [REDACTED_SECRET] and 50%25.",
      );
    });
  });

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
});
