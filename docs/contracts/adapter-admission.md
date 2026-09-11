# Adapter admission limits

Library callers can throw `CuaAdmissionLimitError` from a custom `CuaProvider`
or the `fetchFn` supplied to `createOpenAiResponsesProvider` when a configured
local control limit refuses a request **before provider dispatch**:

```ts
import { CuaAdmissionLimitError, createOpenAiResponsesProvider } from "humanish";

const provider = createOpenAiResponsesProvider({
  apiKey,
  fetchFn: async (url, init) => {
    if (localLimitReached()) {
      await recordLocalAdmissionRefusal();
      throw new CuaAdmissionLimitError();
    }
    return transport(url, init);
  }
});
```

The example's admission check, local receipt and transport belong to the caller.
The error accepts no message or payload. Import it from the same Humanish
installation as the provider and loop: a plain error with the same name or text
does not activate the contract. Do not use it for invalid configuration, a
provider rejection, or an already dispatched request with unknown outcome or
usage. An unknown prior request stays unknown even if a later call is refused.

The OpenAI provider does not retry this explicit refusal. The CUA loop records
`incomplete`, `budget_reached` and `stopCause: adapter_limit`, with a fixed
notice. It does not record another successful turn, usage, action or closing
request. Previous actions, captures, usage and observed task outcomes remain
available for review. Observer labels the ending “adapter admission limit.”
Older generic error recordings remain unchanged.

If a structured task outcome already ended interaction and the optional closing
report is refused before dispatch, that task outcome remains intact. The report
is `skipped` and `debrief.usageReported` is absent, because this declaration says
no provider request was sent. This does not invent zero usage or settle any
earlier unknown cost.

Humanish records the adapter's declaration; it does not independently attest
transport behavior or provider billing. Retain local limit/admission receipts
when auditing those facts. Keep credentials, request bodies and provider URLs
out of such receipts. The contract does not add a manifest request-count cap,
increase an allowance, or turn a safety limit into participant abandonment.
