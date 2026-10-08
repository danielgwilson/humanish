import { describe, expect, it } from "vitest";

import { bySeverity, findingLead } from "../../src/analysis/finding-lead.js";

const plain = {
  headline: "The participant could not tell whether the form was sent.",
  experience: "They pressed Submit three times and nothing on the screen changed.",
};

describe("what a reader sees first for a finding", () => {
  it("leads with the plain headline and experience when no reviewer amended it", () => {
    expect(findingLead(plain, undefined)).toEqual({
      headline: "The participant could not tell whether the form was sent.",
      account: "They pressed Submit three times and nothing on the screen changed.",
      corrected: false,
    });
    expect(findingLead(plain, { status: "confirmed", replacementClaim: null })).toEqual({
      headline: "The participant could not tell whether the form was sent.",
      account: "They pressed Submit three times and nothing on the screen changed.",
      corrected: false,
    });
  });

  it("puts the reviewer's claim first after an amendment and says the account was replaced", () => {
    expect(
      findingLead(plain, {
        status: "amended",
        replacementClaim: "The form was sent, but its confirmation appeared late.",
      }),
    ).toEqual({
      headline: "The form was sent, but its confirmation appeared late.",
      account:
        "Corrected in human review. The reviewer's claim replaces the original headline and account.",
      corrected: true,
    });
  });

  it("has no account line for a headline written without an experience", () => {
    expect(findingLead({ headline: "Sign-in stalled.", experience: null }, null)).toEqual({
      headline: "Sign-in stalled.",
      account: null,
      corrected: false,
    });
  });

  it("gives no lead for an analysis written before headlines, amended or not", () => {
    expect(findingLead({}, undefined)).toBeNull();
    expect(
      findingLead(
        { headline: null, experience: null },
        { status: "amended", replacementClaim: "Sign-in stalled once." },
      ),
    ).toBeNull();
  });
});

describe("design findings in severity order", () => {
  it("puts major before moderate before minor and keeps the analysis order within a severity", () => {
    const ordered = bySeverity([
      { id: "D1", severity: "minor" as const },
      { id: "D2", severity: "major" as const },
      { id: "D3", severity: "moderate" as const },
      { id: "D4", severity: "major" as const },
      { id: "D5", severity: "minor" as const },
    ]);
    expect(ordered.map((finding) => finding.id)).toEqual(["D2", "D4", "D3", "D1", "D5"]);
  });

  it("leaves the analysis's own list as it was", () => {
    const findings = [
      { id: "D1", severity: "minor" as const },
      { id: "D2", severity: "major" as const },
    ];
    bySeverity(findings);
    expect(findings.map((finding) => finding.id)).toEqual(["D1", "D2"]);
  });
});
