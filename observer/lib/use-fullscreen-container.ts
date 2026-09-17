import { useSyncExternalStore } from "react";

function subscribe(listener: () => void) {
  document.addEventListener("fullscreenchange", listener);
  return () => document.removeEventListener("fullscreenchange", listener);
}

function container() {
  return document.fullscreenElement instanceof HTMLElement ? document.fullscreenElement : null;
}

// Native fullscreen hides body portals outside its subtree. Every overlay must
// follow entry and exit, including select menus nested inside popovers.
export function useFullscreenContainer() {
  return useSyncExternalStore(subscribe, container, () => null);
}
