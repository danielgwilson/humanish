# OpenAI Responses rejections when the server keeps nothing

Captured on 2026-10-05 from `POST /v1/responses` with `gpt-5.6-sol`, on an organization without
zero data retention. Every request in the capture sent `store: false`, so the server kept none of
its responses or items: the state a zero-data-retention organization is always in. Provider ids
in the messages are replaced with `rs_fixture` and `resp_fixture`; nothing else is changed.

- `stored-item-not-found.json`, HTTP 404: a request whose input held
  `{ "type": "item_reference", "id": "rs_..." }` for the reasoning item of an earlier
  `store: false` response.
- `previous-response-not-found.json`, HTTP 400: a request with `previous_response_id` set to an
  earlier `store: false` response.
- `model-not-found.json`, HTTP 404: a request naming a model that does not exist. It is the 404
  that must not switch modes.

The same capture found:

- Replies carried `encrypted_content` on their reasoning items without
  `include: ["reasoning.encrypted_content"]`, both with `store: false` and with `store` left at
  its default. The fake replies in `tests/actors/computer-use/openai-explicit-context.test.ts`
  have the same shape.
- A `store: false` request that carried an earlier `store: false` reply's reasoning item with
  `encrypted_content` removed was accepted (200), as was one that left the reasoning item out.
