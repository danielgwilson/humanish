// The Chrome profile a desktop participant's browser starts with. Chrome asks before it hands a
// tel: or sms: link to another app, unless the profile already allows the page's origin to;
// the study's own origin is allowed, so its links reach the desktop's stand-ins without the prompt.
import { describe, expect, it } from "vitest";

import { chromiumEvidenceProfilePreferencesJson } from "../../src/evidence/browser-hygiene.js";

type Preferences = {
  protocol_handler?: { allowed_origin_protocol_pairs?: Record<string, Record<string, boolean>> };
};
const pairs = (targetUrl?: string) =>
  (JSON.parse(chromiumEvidenceProfilePreferencesJson(targetUrl)) as Preferences).protocol_handler
    ?.allowed_origin_protocol_pairs;

describe("the participant browser's profile", () => {
  it("lets the study's origin open phone and message links without Chrome's prompt", () => {
    const allowed = pairs("https://shop.example.test:8443/contact?ref=1");
    expect(Object.keys(allowed ?? {})).toEqual(["https://shop.example.test:8443"]);
    expect(allowed?.["https://shop.example.test:8443"]).toMatchObject({ tel: true, sms: true });
  });

  it("allows no origin without a web target", () => {
    expect(pairs()).toBeUndefined();
    expect(pairs("file:///home/user/index.html")).toBeUndefined();
  });
});
