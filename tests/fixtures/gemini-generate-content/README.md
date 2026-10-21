# Gemini generateContent fixtures

`structured-answer.json` is one real `generateContent` response from `gemini-3.5-flash-lite`,
captured on 2026-10-21. The request carried the request body humanish's Gemini analyst sends: a
system instruction, one text part, a `{"captureEvidenceId":"e1"}` part, a 1x1 PNG at
`MEDIA_RESOLUTION_HIGH`, a one-field JSON response schema (`summary`), `maxOutputTokens: 8192`,
`thinkingLevel: HIGH`, `serviceTier: standard` and `store: false`. The evidence text was
synthetic.

Two values were replaced: the opaque `thoughtSignature` and the `responseId`. Every field name,
the finish reason and the usage counts are as the API returned them, including the
`thoughtsTokenCount` that bills as output and the 1,089 image tokens for one high-resolution image.
