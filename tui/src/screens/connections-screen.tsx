import { Box, Text, useInput } from "ink";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { CommsSetupStatus } from "../../../src/comms-connections.js";
import type { CommsCheckResult, CommsConfigureResult } from "../../../src/comms-setup.js";
import type { CommsRecoveryEntry } from "../../../src/comms-receiving.js";
import type { TuiCapabilities } from "../../../src/tui-contract.js";
import { listWindow } from "../../../src/run-projection.js";
import { fitLabelToWidth } from "../fit-text.js";
import { gutter } from "../frame.js";
import { PALETTE } from "../palette.js";
import { color } from "../text-props.js";
import { useTerminalSize } from "../use-terminal-size.js";

type Lab = { title: string; path: string };
type View = { kind: "home" } | { kind: "check" } | { kind: "labs" } | { kind: "preview"; lab: Lab; plan: CommsConfigureResult; openedAt: number }
  | { kind: "saved"; path: string } | { kind: "recovery" } | { kind: "recover"; entry: CommsRecoveryEntry; openedAt: number };
const CONFIRM_MIN_MS = 400; // A held Enter must not accept a newly opened preview.

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
  const [busyView, setBusyView] = useState<View["kind"]>("home");
  const busyRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(0);
  const [view, setView] = useState<View>({ kind: "home" });
  const [check, setCheck] = useState<CommsCheckResult>();
  const [labs, setLabs] = useState<Lab[]>([]);
  const [recovery, setRecovery] = useState<CommsRecoveryEntry[]>([]);
  const { rows } = useTerminalSize();
  const read = useCallback(async () => {
    setLoading(true);
    try { const next = await capabilities.read(); setStatus(next); setCheck(next.authentication); }
    catch { setStatus(undefined); setMessage("Could not read connection setup. Recheck to try again."); }
    finally { setLoading(false); }
  }, [capabilities]);
  useEffect(() => { void read(); }, [read]);
  const configured = status?.connections.some(connection => connection.name === "agentmail" && connection.apiKeyEnv === "AGENTMAIL_API_KEY");
  const source = status?.credential.source;
  const sourceLabel = source === "process env" ? "session environment" : source?.includes("provider.env") ? "project env file" : "saved key";
  const receivingAvailable = !!capabilities.labs && !!capabilities.configure;
  const pending = recovery.filter(entry => entry.status !== "closed" || entry.unresolvedCount > 0);
  const homeActions = loading ? [] : [
    ...(status?.ok ? [
      { id: "key", label: status.credential.stored ? "Replace stored key" : "Add API key" },
      ...(status.credential.present && !configured ? [{ id: "save", label: "Use this key for this project" }] : []),
      ...(status.credential.present && configured && capabilities.check ? [{ id: "check", label: "Test authentication (read-only)" }] : []),
      ...(status.credential.present && configured && receivingAvailable ? [{ id: "labs", label: "Use real email in a lab" }] : [])
    ] : []),
    ...(capabilities.recovery ? [{ id: "recovery", label: "Review inbox cleanup" }] : []),
    { id: "read", label: "Recheck local setup" }
  ];
  const actions = view.kind === "home" ? homeActions
    : view.kind === "check" ? [{ id: "check", label: "Check again" }, { id: "home", label: "Back to Connections" }]
    : view.kind === "labs" ? labs.map((lab, index) => ({ id: `lab-${index}`, label: lab.title }))
    : view.kind === "preview" ? [{ id: "apply", label: "Save lab copy" }, { id: "labs", label: "Cancel" }]
    : view.kind === "saved" ? [{ id: "home", label: "Back to Connections" }]
    : view.kind === "recovery" ? pending.map((entry, index) => ({ id: `recovery-${index}`, label: `${entry.runId} · ${entry.unresolvedCount} pending` }))
    : [...(view.entry.activeOwner === false && view.entry.unresolvedCount > 0 && capabilities.recover ? [{ id: "recover", label: "Release study inboxes" }] : []), { id: "recovery", label: "Back to cleanup" }];
  const active = Math.min(selected, Math.max(0, actions.length - 1));
  function go(next: View): void { setView(next); setSelected(0); setMessage(undefined); }
  function back(): void {
    if (view.kind === "home") onBack();
    else go({ kind: view.kind === "preview" ? "labs" : view.kind === "recover" ? "recovery" : "home" });
  }
  async function run(action: () => Promise<void>): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true; setBusyView(view.kind); setBusy(true);
    try { await action(); }
    catch { setMessage("The action could not complete. Recheck before retrying."); }
    finally { busyRef.current = false; setBusy(false); }
  }
  useInput((input, key) => {
    if (busyRef.current || loading) return;
    if (key.escape || key.leftArrow) { back(); return; }
    if (key.upArrow || input === "k") { setSelected(index => Math.max(0, index - 1)); return; }
    if (key.downArrow || input === "j") { setSelected(index => Math.min(Math.max(0, actions.length - 1), index + 1)); return; }
    if (!key.return) return;
    const action = actions[active]?.id;
    if (!action) return;
    if (action === "key") { onKeyEntry(); return; }
    if (action === "home") { go({ kind: "home" }); return; }
    if ((action === "apply" && view.kind === "preview" || action === "recover" && view.kind === "recover") && Date.now() - view.openedAt < CONFIRM_MIN_MS) return;
    void run(async () => {
      if (action === "read" || action === "save") {
        if (action === "save") setMessage((await capabilities.save()).message);
        setCheck(undefined); await read(); setSelected(0); return;
      }
      if (action === "check" && capabilities.check) {
        go({ kind: "check" }); setCheck(undefined); setCheck(await capabilities.check()); return;
      }
      if (action === "labs" && capabilities.labs) {
        const result = await capabilities.labs(); setLabs(result); go({ kind: "labs" }); return;
      }
      if (action.startsWith("lab-") && capabilities.configure) {
        const lab = labs[active]; if (!lab) return;
        const plan = await capabilities.configure(lab.path, false);
        if (!plan.ok || !plan.path || !plan.planToken) { setMessage(plan.message); return; }
        go({ kind: "preview", lab, plan, openedAt: Date.now() }); return;
      }
      if (action === "apply" && view.kind === "preview" && capabilities.configure && view.plan.planToken) {
        const result = await capabilities.configure(view.lab.path, true, view.plan.planToken);
        if (!result.ok || !result.applied || !result.path) { go({ kind: "labs" }); setMessage(result.message); return; }
        go({ kind: "saved", path: result.path }); return;
      }
      if (action === "recovery" && capabilities.recovery) {
        setRecovery(await capabilities.recovery()); go({ kind: "recovery" }); return;
      }
      if (action.startsWith("recovery-")) {
        const entry = pending[active]; if (entry) go({ kind: "recover", entry, openedAt: Date.now() }); return;
      }
      if (action === "recover" && view.kind === "recover" && capabilities.recover && capabilities.recovery && view.entry.activeOwner === false) {
        const result = await capabilities.recover(view.entry.runId, view.entry.connectionName);
        setRecovery(await capabilities.recovery()); go({ kind: "recovery" }); setMessage(result.message);
      }
    });
  });
  const window = listWindow({ total: actions.length, selected: active, viewport: view.kind === "labs" || view.kind === "recovery" ? Math.max(2, rows - 14) : actions.length });
  const menu = <Box marginTop={1} flexDirection="column">
    {window.start > 0 ? <Text dimColor>↑ {window.start} more</Text> : null}
    {actions.slice(window.start, window.end).map((action, offset) => {
      const index = window.start + offset;
      return <Text key={action.id} bold={index === active} {...color(index === active ? PALETTE.accent : undefined)}>
        {gutter(index === active)} {fitLabelToWidth(action.label, columns - 3)}{busy && busyView === view.kind && index === active ? "…" : ""}
      </Text>;
    })}
    {window.end < actions.length ? <Text dimColor>↓ {actions.length - window.end} more</Text> : null}
  </Box>;
  return <Box flexDirection="column" width={columns}>
    {view.kind === "home" ? <>
      <Text bold color={PALETTE.accent}>AgentMail · hosted email</Text>
      <Text>Connection: {loading ? "checking…" : !status?.ok ? "unavailable" : configured ? "agentmail · saved" : "not saved for this project"}</Text>
      <Text>Key: {status ? status.credential.present ? `present · ${sourceLabel}` : "missing" : "checking…"}</Text>
      <Text dimColor>Provider authentication: {check?.authenticated === true ? "passed" : check?.authenticated === false ? "rejected" : check ? "unknown" : "not checked"}</Text>
      {status?.ok === false ? <Text color={PALETTE.bad}>{status.message}</Text> : null}
      {status?.credential.explicitlyEmpty ? <Text color={PALETTE.warn}>An empty AGENTMAIL_API_KEY overrides the stored key. Unset it and reopen the TUI.</Text>
        : status?.credential.strict && !status.credential.present ? <Text color={PALETTE.warn}>Strict key mode ignores saved keys. Reopen without HUMANISH_STRICT_KEYS=1, or pass an env file.</Text>
        : (source === "process env" || source?.includes("provider.env")) && status?.credential.stored
          ? <Text dimColor>Env and project keys take precedence over your saved key.</Text> : null}
      {menu}
      {message ? <Box marginTop={1}><Text>{message}</Text></Box> : null}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Get a key: https://console.agentmail.to</Text>
        <Text dimColor>Key entry is hidden. Saved keys apply to all your projects.</Text>
        {receivingAvailable ? <Text dimColor>Fresh inbox per participant · hosted email</Text> : <Text color={PALETTE.warn}>Email receiving in studies is not available yet.</Text>}
        <Text dimColor>Local capture: lab config · SMS: unavailable</Text>
      </Box>
    </> : view.kind === "check" ? <>
      <Text bold color={PALETTE.accent}>Authentication check</Text>
      {busy && !check ? <Text>Contacting AgentMail…</Text> : check ? <>
        <Text>Credential: {check.credentialPresent ? "present" : "missing"}</Text>
        <Text>Authentication: {check.authenticated === true ? "passed" : check.authenticated === false ? "rejected" : "unknown"}</Text>
        <Text dimColor>Inbox permissions: {check.permissions}</Text>
        <Text dimColor>Capacity: {check.capacity} · delivery: untested</Text>
        <Box marginTop={1}><Text>{check.message}</Text></Box>
        {check.checkedAt ? <Text dimColor>Checked: {check.checkedAt}</Text> : null}
      </> : <Text>Authentication is unknown.</Text>}
      {menu}
    </> : view.kind === "labs" ? <>
      <Text bold color={PALETTE.accent}>Choose a lab for real email</Text>
      <Text dimColor>Preview a local copy before saving.</Text>
      {labs.length ? menu : <Text>No labs are available in this project.</Text>}
      {labs[active] ? <Box marginTop={1}><Text dimColor>{labs[active]!.path}</Text></Box> : null}
    </> : view.kind === "preview" ? <>
      <Text bold color={PALETTE.accent}>Save email-enabled lab</Text>
      <Text dimColor>From: {view.lab.path}</Text>
      <Box marginTop={1} flexDirection="column"><Text>Save as:</Text><Text>{view.plan.path}</Text></Box>
      <Box marginTop={1} flexDirection="column">
        <Text>Fresh inbox for each participant.</Text>
        <Text>Mail is hosted. Models may see content.</Text>
        <Text>Recordings remain restricted for sharing.</Text>
        <Text>Provider charges are separate.</Text>
      </Box>
      {menu}
    </> : view.kind === "saved" ? <>
      <Text bold color={PALETTE.ok}>Email lab saved</Text>
      <Text>{view.path}</Text>
      <Box marginTop={1} flexDirection="column"><Text>Select this lab from Labs to start.</Text><Text dimColor>Or run this exact path:</Text><Text>humanish lab run {view.path}</Text></Box>
      {menu}
    </> : view.kind === "recovery" ? <>
      <Text bold color={PALETTE.accent}>Inbox cleanup</Text>
      <Text dimColor>Study completion and inbox cleanup are separate.</Text>
      {pending.length ? menu : <Text>No pending inbox cleanup.</Text>}
      {pending[active] ? <Box marginTop={1} flexDirection="column"><Text>{pending[active]!.runId}</Text><Text dimColor>Connection: {pending[active]!.connectionName}</Text></Box> : null}
    </> : <>
      <Text bold color={PALETTE.accent}>Review inbox cleanup</Text>
      <Text>{view.entry.runId}</Text>
      <Text>Connection: {view.entry.connectionName}</Text>
      <Text>{view.entry.unresolvedCount} pending · {view.entry.participantCount} participants</Text>
      <Box marginTop={1} flexDirection="column">
        {view.entry.activeOwner === true ? <Text color={PALETTE.warn}>This run has an active owner. Cleanup is unavailable while it is running.</Text>
          : view.entry.activeOwner === null ? <Text color={PALETTE.warn}>Ownership is unknown. Cleanup is unavailable until ownership can be verified.</Text>
            : <><Text>Release this study’s owned inboxes.</Text><Text dimColor>An uncertain creation may be replayed, then released. Other inboxes are untouched.</Text></>}
      </Box>
      {menu}
    </>}
    {view.kind !== "home" && message ? <Box marginTop={1}><Text color={PALETTE.warn}>{message}</Text></Box> : null}
    {view.kind !== "home" && busy && busyView === view.kind ? <Text dimColor>Working…</Text> : null}
  </Box>;
}
