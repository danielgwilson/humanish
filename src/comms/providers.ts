/** Installed communication providers. Receiving provider ids are persisted; only add entries. */
export const COMMS_PROVIDERS = [
  {
    id: "agentmail",
    label: "AgentMail",
    channel: "email",
    keyEnv: "AGENTMAIL_API_KEY",
    setupAvailable: true,
    receivingAvailable: true,
    description: "A hosted email service with real inbox addresses.",
    setupUrl: "https://console.agentmail.to",
    limitation:
      "Fresh real inboxes for supported computer-use studies. Hosted processing; local evidence review only. Provider charges are separate.",
  },
] as const;
/** The provider a new connection uses; the only one installed today. */
export const DEFAULT_COMMS_PROVIDER = COMMS_PROVIDERS[0];
/** Persisted in connection profiles, lease journals and receiving evidence. */
export type ReceivingProviderId = (typeof COMMS_PROVIDERS)[number]["id"];
export const RECEIVING_PROVIDER_IDS: readonly ReceivingProviderId[] = COMMS_PROVIDERS.map(
  (provider) => provider.id,
);
export function isReceivingProviderId(value: unknown): value is ReceivingProviderId {
  return RECEIVING_PROVIDER_IDS.some((id) => id === value);
}
/** The display name of an installed provider. */
export function commsProviderLabel(id: ReceivingProviderId): string {
  return COMMS_PROVIDERS.find((provider) => provider.id === id)?.label ?? id;
}
