# OpenAI invalid_prompt rejection body

`refusal.json` is the error body OpenAI returns with HTTP 400 when it refuses a request under its
usage policy. It was not captured by this repo. Live humanish runs record only the status and code
(`OpenAI Responses 400 invalid_prompt`), because the message can echo the prompt, and 48 direct
replays of a flagged run's first request on 2026-09-30 produced no flag to capture.

The fields and message are copied from a public report of the same rejection, relayed verbatim
inside a proxy error:
[community.openai.com/t/1246975](https://community.openai.com/t/hoje-comecei-a-receber-o-error-code-400-error-message-invalid-prompt-your-prompt-was-flagged-as-potentially-violating-our-usage-policy/1246975)
(`'type': 'invalid_request_error', 'param': None, 'code': 'invalid_prompt'`). The same message
appears in [openai/codex#43058](https://github.com/openai/codex/issues/43058). Python `None` is
written as JSON `null`.
