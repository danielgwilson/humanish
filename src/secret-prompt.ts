import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

/** Host-owned entry: no secret crosses the TUI view contract or reaches a writable terminal. */
export async function promptSecret(label: string, stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream): Promise<string | null> {
  if (!stdin.isTTY || !stdout.isTTY) return null;
  const wasRaw = stdin.isRaw;
  // readline owns editing, paste and raw-mode lifecycle; all of its echo goes to this sink.
  const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const reader = createInterface({ input: stdin, output: sink, terminal: true, historySize: 0 });
  // Ink unrefs stdin on unmount. A pending promise alone does not keep Node alive.
  stdin.ref?.();
  return await new Promise(resolve => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      reader.close();
      stdin.setRawMode?.(wasRaw === true);
      stdin.pause();
      stdin.unref?.();
      stdout.write("\n");
      resolve(value);
    };
    reader.once("line", line => finish(line.trim() || null));
    reader.once("SIGINT", () => finish(null));
    reader.once("close", () => finish(null));
    reader.once("error", () => finish(null));
    // Advertise readiness only after raw mode and handlers are active. Printing this first lets
    // fast paste race terminal echo and exposes the very value this prompt exists to hide.
    stdin.resume();
    stdout.write(`${label} (input hidden; Ctrl+C cancels): `);
  });
}
