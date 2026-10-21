/**
 * Browser chrome that belongs to the host environment (update prompts, password
 * save bubbles, first-run UI) pollutes product evidence. Keep these knobs in one
 * place so browser-backed routes can prefer product pixels over browser UI.
 */
export const CHROMIUM_EVIDENCE_HYGIENE_FLAGS = [
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-domain-reliability",
  "--disable-extensions",
  "--disable-sync",
  "--no-default-browser-check",
  "--no-first-run",
  "--password-store=basic",
  "--use-mock-keychain",
] as const;

const CHROMIUM_EVIDENCE_PROFILE_PREFERENCES = {
  autofill: {
    credit_card_enabled: false,
    profile_enabled: false,
  },
  browser: {
    check_default_browser: false,
    // Linux CSD adds 8px to Chrome's minimum width. Use the window manager's
    // frame so the 500px desktop floor can be physically contained.
    custom_chrome_frame: false,
  },
  credentials_enable_service: false,
  payments: {
    can_make_payment_enabled: false,
  },
  profile: {
    default_content_setting_values: {
      notifications: 2,
    },
    password_manager_enabled: false,
  },
} as const;

/**
 * Schemes whose links Chrome hands to another app after asking "Open xdg-open?". The desktop's
 * stand-ins answer them (src/substrates/e2b/desktop-handoff.ts), so the prompt is browser chrome
 * a person on their own computer would not see for that app. Chrome never asks for mailto.
 */
const EXTERNAL_APP_SCHEMES = [
  "callto",
  "facetime",
  "facetime-audio",
  "geo",
  "maps",
  "mms",
  "msteams",
  "sip",
  "skype",
  "slack",
  "sms",
  "tel",
  "webcal",
  "whatsapp",
  "zoommtg",
] as const;

/**
 * The profile preference that lets a web `targetUrl`'s origin open the external app schemes
 * without Chrome's prompt: the "always allow" choice Chrome stores per origin, which needs no root
 * and no managed policy. Links from other origins still prompt. Undefined for any other target.
 */
export function externalAppPreferences(
  targetUrl: string | undefined,
):
  | { protocol_handler: { allowed_origin_protocol_pairs: Record<string, Record<string, true>> } }
  | undefined {
  const target = targetUrl === undefined ? null : URL.parse(targetUrl);
  if (target === null || !/^https?:$/.test(target.protocol)) return undefined;
  return {
    protocol_handler: {
      allowed_origin_protocol_pairs: {
        [target.origin]: Object.fromEntries(EXTERNAL_APP_SCHEMES.map((scheme) => [scheme, true])),
      },
    },
  };
}

/** The profile's Preferences file, with externalAppPreferences for a web `targetUrl`. */
export function chromiumEvidenceProfilePreferencesJson(targetUrl?: string): string {
  return JSON.stringify({
    ...CHROMIUM_EVIDENCE_PROFILE_PREFERENCES,
    ...externalAppPreferences(targetUrl),
  });
}
