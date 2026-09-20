import { Box, Text, useInput } from "ink";
import React, { useCallback, useEffect, useState } from "react";
import type { CommsSetupStatus } from "../../../src/comms-connections.js";
import type { TuiCapabilities } from "../../../src/tui-contract.js";
import { gutter } from "../frame.js";
import { PALETTE } from "../palette.js";
import { color } from "../text-props.js";

export function ConnectionsScreen({ capabilities, columns, notice, onBack, onKeyEntry }: {
  capabilities: NonNullable<TuiCapabilities["comms"]>;
  columns: number;
  notice: string | undefined;
  onBack(): void;
  onKeyEntry(): void;
}): React.ReactElement {
  const [status, setStatus] = useState<CommsSetupStatus>();
  const [message, setMessage] = useState(notice);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(0);
  const read = useCallback(async () => {
    setLoading(true);
    try { setStatus(await capabilities.read()); }
    catch { setMessage("Could not read connection setup. Recheck to try again."); }
    finally { setLoading(false); }
  }, [capabilities]);
  useEffect(() => { void read(); }, [read]);
  const configured = status?.connections.some(connection => connection.name === "agentmail" && connection.apiKeyEnv === "AGENTMAIL_API_KEY");
  const source = status?.credential.source;
  const sourceLabel = source === "process env" ? "session environment" : source?.includes("provider.env") ? "project env file" : "saved key";
  const actions = loading ? [] : status?.ok ? [
    { id: "key", label: status.credential.stored ? "Replace stored key" : "Add API key" },
    ...(status.credential.present && !configured ? [{ id: "save", label: "Use this key for this project" }] : []),
    { id: "read", label: "Recheck local setup" }
  ] : [{ id: "read", label: "Recheck local setup" }];
  useInput((input, key) => {
    if (busy) return;
    if (key.escape || key.leftArrow) { onBack(); return; }
    if (key.upArrow || input === "k") { setSelected(index => Math.max(0, index - 1)); return; }
    if (key.downArrow || input === "j") { setSelected(index => Math.min(actions.length - 1, index + 1)); return; }
    if (!key.return) return;
    const action = actions[Math.min(selected, actions.length - 1)]?.id;
    if (!action) return;
    if (action === "key") { onKeyEntry(); return; }
    setBusy(true);
    void (async () => {
      try {
        if (action === "save") setMessage((await capabilities.save()).message);
        await read();
        setSelected(0);
      } catch { setMessage("Could not save the connection. Recheck local setup before retrying."); }
      finally { setBusy(false); }
    })();
  });
  return <Box flexDirection="column" width={columns}>
    <Text bold color={PALETTE.accent}>AgentMail · hosted email</Text>
    <Box flexDirection="column">
      <Text>Connection: {loading ? "checking…" : !status?.ok ? "unavailable" : configured ? "agentmail · saved" : "not saved for this project"}</Text>
      <Text>Key: {status ? status.credential.present ? `present · ${sourceLabel}` : "missing" : "checking…"}</Text>
      <Text dimColor>Provider authentication: not checked</Text>
    </Box>
    {status?.ok === false ? <Text color={PALETTE.bad}>{status.message}</Text> : null}
    {status?.credential.explicitlyEmpty ? <Text color={PALETTE.warn}>An empty AGENTMAIL_API_KEY overrides the stored key. Unset it and reopen the TUI.</Text>
      : status?.credential.strict && !status.credential.present ? <Text color={PALETTE.warn}>Strict key mode ignores saved keys. Reopen without HUMANISH_STRICT_KEYS=1, or pass an env file.</Text>
      : (source === "process env" || source?.includes("provider.env")) && status?.credential.stored
        ? <Text dimColor>Env and project keys take precedence over your saved key.</Text> : null}
    <Box marginTop={1} flexDirection="column">
      {actions.map((action, index) => <Text key={action.id} bold={index === Math.min(selected, actions.length - 1)} {...color(index === Math.min(selected, actions.length - 1) ? PALETTE.accent : undefined)}>
        {gutter(index === Math.min(selected, actions.length - 1))} {action.label}{busy && index === selected ? "…" : ""}
      </Text>)}
    </Box>
    {message ? <Box marginTop={1}><Text>{message}</Text></Box> : null}
    <Box marginTop={1} flexDirection="column">
      <Text dimColor>Get a key: https://console.agentmail.to</Text>
      <Text dimColor>Key entry is hidden. Saved keys apply to all your projects.</Text>
      <Text color={PALETTE.warn}>Email receiving in studies is not available yet.</Text>
      <Text dimColor>Local capture: lab config · SMS: unavailable</Text>
    </Box>
  </Box>;
}
