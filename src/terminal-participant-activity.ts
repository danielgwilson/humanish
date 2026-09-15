const itemEvents = new Set(["item.started", "item.updated", "item.completed"]);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Count distinct participant items in the retained Codex JSON stdout stream.
 * The caller supplies stdout only, after transport reconciliation and redaction.
 * Lifecycle, usage, launcher diagnostics, and nested command output are not activity.
 * Zero means no recognized item was retained, not that the participant succeeded.
 */
export function countTerminalParticipantItems(stdout: string): number {
  const ids = new Set<string>();
  for (const line of stdout.split("\n")) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (!object(event) || typeof event.type !== "string" || !itemEvents.has(event.type) || !object(event.item)) continue;
    const item = event.item;
    if (!nonempty(item.id)) continue;
    const active = ((item.type === "agent_message" || item.type === "reasoning") && nonempty(item.text))
      || (item.type === "command_execution" && nonempty(item.command))
      || (item.type === "web_search" && (nonempty(item.query) || (object(item.action) && nonempty(item.action.type))))
      || (item.type === "file_change" && Array.isArray(item.changes)
        && item.changes.some(change => object(change) && nonempty(change.path) && nonempty(change.kind)));
    if (active) ids.add(item.id);
  }
  return ids.size;
}
