/** Read completed participant messages from a Codex terminal transcript. */
export function terminalParticipantReport(transcript) {
  const messages = [];
  let malformedLines = 0;
  for (const line of transcript.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event;
    try { event = JSON.parse(line); } catch { malformedLines += 1; continue; }
    if (event?.type === "item.completed" && event.item?.type === "agent_message"
      && typeof event.item.text === "string") messages.push(event.item.text);
  }
  return { last: messages.at(-1), malformedLines };
}
