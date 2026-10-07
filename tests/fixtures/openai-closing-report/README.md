# Closing-report API fixtures

Minimal response excerpts from a real OpenAI gpt-5.6-sol computer-use run on2026-09-05: `cua-2026-09-05T01-53-04-062Z-189bb3b5`.
Source capture `.humanish/wire/debrief-typed-pilot/` last computer-call and closing response. Retained original run under private operator evidence; full raw wire is kept privately, not committed. The final response was requested with computer tool available but tool_choice:none, strictJSONschema(summary,frictionReports), and max_output_tokens1024.

Only response id, status, output computer/message items, and usage retained. Opaque response/item/call IDs replaced with consistent synthetic identifiers. Reasoning and unrelated response metadata omitted. The app/task/text are synthetic. Shapes and field names derive from the live response; none were inferred from a desired parser shape.

`typed-closing-report-impressions.json` is `typed-closing-report.json` with an `impressions` list
added to the report text. The response shape and usage are unchanged from the capture; only the
synthetic JSON inside `output_text` was extended when the closing schema gained `impressions`.
