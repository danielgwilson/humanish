/**
 * Browser chrome that belongs to the host environment (update prompts, password
 * save bubbles, first-run UI) pollutes product evidence. Keep these knobs in one
 * place so browser-backed lanes can prefer product pixels over browser UI.
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
  "--use-mock-keychain"
] as const;

const CHROMIUM_EVIDENCE_PROFILE_PREFERENCES = {
  autofill: {
    credit_card_enabled: false,
    profile_enabled: false
  },
  browser: {
    check_default_browser: false
  },
  credentials_enable_service: false,
  payments: {
    can_make_payment_enabled: false
  },
  profile: {
    default_content_setting_values: {
      notifications: 2
    },
    password_manager_enabled: false
  }
} as const;

export function chromiumEvidenceProfilePreferencesJson(): string {
  return JSON.stringify(CHROMIUM_EVIDENCE_PROFILE_PREFERENCES);
}
