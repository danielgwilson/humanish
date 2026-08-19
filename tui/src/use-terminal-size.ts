import { useEffect, useState } from "react";

export interface TerminalSize {
  columns: number;
  rows: number;
}

/**
 * A terminal size that stays honest.
 *
 * Two things go wrong if you just read `stdout.columns` once. Under tmux and over a freshly
 * attached SSH session the first value can be a placeholder (commonly 80x24) that is replaced
 * milliseconds later — a layout computed from it is wrong for the rest of the session unless
 * something re-reads. And a stream that is not a TTY reports `undefined`, which silently becomes
 * `NaN` in any arithmetic and collapses every box to zero width.
 *
 * So: fall back explicitly, re-read on `resize`, and re-read once on the next tick to catch the
 * post-attach correction that arrives without a resize event.
 */
export function useTerminalSize(stdout: NodeJS.WriteStream): TerminalSize {
  const read = (): TerminalSize => ({
    columns: Math.max(20, stdout.columns || 80),
    rows: Math.max(6, stdout.rows || 24)
  });
  const [size, setSize] = useState<TerminalSize>(read);

  useEffect(() => {
    const update = (): void => {
      setSize((previous) => {
        const next = read();
        // Same size means the same object, so React does not re-render the whole tree on every
        // stray resize event a window manager emits while dragging.
        return next.columns === previous.columns && next.rows === previous.rows ? previous : next;
      });
    };
    stdout.on("resize", update);
    const settle = setTimeout(update, 0);
    return () => {
      stdout.off("resize", update);
      clearTimeout(settle);
    };
  }, [stdout]);

  return size;
}
