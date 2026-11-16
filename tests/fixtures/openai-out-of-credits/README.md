# OpenAI out-of-credits body

`credit-balance-exhausted.json` is the body the Responses API sent with HTTP 429 on 2026-11-15
when the account had no credits left. It is copied byte for byte from the capture. The account
kept answering this way for every participant of the run, apart from an occasional 200, so a
later success does not show that credits are back.

The body names the cause twice: `code: credit_balance_exhausted` and `type: insufficient_quota`.
The billing URL in the message is the provider's own public page.
