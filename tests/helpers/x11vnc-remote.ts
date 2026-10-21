/**
 * x11vnc's remote-control channel as live E2B and Modal desktops answer it (spike 2026-10-21):
 * `-R viewonly` switches the running server, and `-Q viewonly` prints `ans=viewonly:0` or `:1`.
 * One instance per fake desktop, since the state belongs to that desktop's server.
 */
export function x11vncRemote(): (
  command: string,
) => { exitCode: number; stdout: string } | undefined {
  let viewOnly = false;
  return (command) => {
    if (!command.startsWith("x11vnc ")) return undefined;
    if (command.endsWith(" -R viewonly")) {
      viewOnly = true;
      return { exitCode: 0, stdout: "" };
    }
    if (command.endsWith(" -Q viewonly")) {
      return { exitCode: 0, stdout: `ans=viewonly:${viewOnly ? 1 : 0}\n` };
    }
    return undefined;
  };
}
