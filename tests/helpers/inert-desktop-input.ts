/**
 * No-op mouse and keyboard methods for a fake E2B desktop whose test never sends input. The real
 * @e2b/desktop Sandbox has these, so E2BDesktopSandbox declares them.
 */
export function inertDesktopInput() {
  const noop = async (): Promise<void> => {};
  return {
    leftClick: noop,
    rightClick: noop,
    middleClick: noop,
    doubleClick: noop,
    moveMouse: noop,
    scroll: noop,
    write: noop,
    press: noop,
    drag: noop,
  };
}
