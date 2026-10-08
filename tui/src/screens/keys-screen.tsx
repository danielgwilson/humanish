import { Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";

import type { TuiCapabilities, TuiHandoff, TuiKeyStatus } from "../../../src/tui/contract.js";
import { normalizeThought } from "../../../src/run/projection.js";
import { gutter } from "../frame.js";
import { PALETTE } from "../palette.js";
import { color } from "../text-props.js";

/** What hidden key entry does, shown wherever a key is entered. */
export const KEY_ENTRY_NOTE = "Key entry is hidden. Saved keys apply to all your projects.";

/**
 * `c keys and accounts`: the provider keys `humanish keys` lists, each with the line it prints, and
 * the email connection. Enter on a key hands it to the host, which asks for the value the way
 * `humanish keys set` does; the view never sees a value.
 */
export function KeysScreen({
  keys,
  email,
  columns,
  notice,
  selected,
  onSelect,
  onBack,
  onEmail,
  onKeyEntry,
}: {
  keys: TuiCapabilities["keys"];
  /** Whether this build has the email connection screen. */
  email: boolean;
  columns: number;
  notice: string | undefined;
  /** The cursor, held by the caller so it survives a visit to the email connection. */
  selected: number;
  onSelect(index: number): void;
  onBack(): void;
  onEmail(): void;
  onKeyEntry(handoff: TuiHandoff): void;
}): React.ReactElement {
  /** `undefined` while reading, `null` when the read failed. */
  const [status, setStatus] = useState<TuiKeyStatus[] | null | undefined>(
    keys === undefined ? [] : undefined,
  );
  useEffect(() => {
    if (keys === undefined) return;
    let cancelled = false;
    keys.status().then(
      (rows) => {
        if (!cancelled) setStatus(rows);
      },
      () => {
        if (!cancelled) setStatus(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [keys]);

  // Nothing is listed until the read finishes, so the cursor cannot start on a row that moves.
  const rows =
    status === undefined
      ? []
      : [
          ...(status ?? []).map((row) => ({ id: row.name, text: row.line, set: row.set })),
          ...(email ? [{ id: "email", text: "Email connection (AgentMail)", set: undefined }] : []),
        ];
  const active = Math.min(selected, Math.max(0, rows.length - 1));

  useInput((input, key) => {
    if (key.escape || key.leftArrow) {
      onBack();
      return;
    }
    if (key.upArrow || input === "k") {
      onSelect(Math.max(0, active - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      onSelect(Math.max(0, Math.min(rows.length - 1, active + 1)));
      return;
    }
    if (!key.return && !key.rightArrow) return;
    const row = rows[active];
    if (row === undefined) return;
    if (row.id === "email") onEmail();
    else onKeyEntry({ action: "provider-key", name: row.id });
  });

  return (
    <Box flexDirection="column" width={columns}>
      <Text bold color={PALETTE.accent}>
        Provider keys
      </Text>
      {status === undefined ? <Text dimColor>checking…</Text> : null}
      {status === null ? (
        <Text color={PALETTE.bad}>Could not read the provider keys. Reopen to try again.</Text>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        {rows.map((row, index) => (
          <Box key={row.id} width={columns}>
            <Box flexShrink={0}>
              <Text
                {...color(index === active ? PALETTE.accent : undefined)}
                bold={index === active}
              >
                {gutter(index === active)}{" "}
              </Text>
            </Box>
            <Text
              {...color(
                index === active ? PALETTE.accent : row.set === false ? PALETTE.warn : undefined,
              )}
            >
              {normalizeThought(row.text, { width: columns - 2, maxLines: 8 }).lines.join("\n")}
            </Text>
          </Box>
        ))}
      </Box>
      {notice === undefined ? null : (
        <Box marginTop={1}>
          <Text>{notice}</Text>
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>⏎ on a key asks for its value.</Text>
        <Text dimColor>{KEY_ENTRY_NOTE}</Text>
      </Box>
    </Box>
  );
}
