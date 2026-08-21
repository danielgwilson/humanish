import { Box, Text } from "ink";
import React from "react";

import { PALETTE } from "../palette.js";

/**
 * The keys, on demand.
 *
 * Held back through rev 8 on the grounds that a surface needing a help screen has already failed.
 * That is a good principle and it was applied too literally: a person who cannot remember whether
 * Escape backs out or quits does not need the design fixed, they need one line of text. The legend
 * at the bottom of every screen still carries the keys that matter THERE; this carries all of them,
 * including the ones a legend has no room to explain.
 */
export function HelpScreen({ columns }: { columns: number }): React.ReactElement {
  const rows: [string, string][] = [
    ["↑ ↓  ·  k j", "move the cursor"],
    ["⏎  ·  →", "open what the cursor is on, or run the action it names"],
    ["esc  ·  ←", "back — and it cancels an armed confirmation first"],
    ["g  ·  G", "jump to the top, jump to the bottom"],
    ["?", "these keys"],
    ["q", "quit — a run you started keeps going without this window"]
  ];
  return (
    <Box flexDirection="column" width={columns}>
      <Text color={PALETTE.accent} bold>
        Keys
      </Text>
      <Box marginTop={1} flexDirection="column">
        {rows.map(([keys, means]) => (
          <Box key={keys}>
            <Box width={16}>
              <Text bold>{keys}</Text>
            </Box>
            <Text dimColor>{means}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Starting a run asks twice when it spends money: the first ⏎ arms and</Text>
        <Text dimColor>restates the cost, the second commits. A dry run never asks.</Text>
      </Box>
    </Box>
  );
}
