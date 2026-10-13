import { useEffect, useState } from "react";
import { sidebarClosedByUrl } from "./autoplay";

const PHONE_WIDTH = "(max-width: 880px)";
const SIDEBAR_KEY = "humanish-sidebar";

export interface LibraryLayout {
  /** The viewport is phone width: the library opens as a drawer and the static sidebar is gone. */
  phone: boolean;
  /** The static sidebar is expanded. */
  sideOpen: boolean;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  /** The library button: the drawer on a phone, the static sidebar otherwise. */
  toggle: () => void;
}

/**
 * Where the study library shows. The static sidebar starts collapsed for `?sidebar=closed`, for a
 * saved "closed", and in a snapshot of fewer than two studies; the reviewer's choice is saved in
 * browser storage, and the control still works when storage refuses it. Read once, when the page
 * mounts. The phone drawer closes when the window widens past phone width.
 */
export function useLibraryLayout(snapshot: boolean, libraryEntries: number): LibraryLayout {
  const [sideOpen, setSideOpen] = useState(() => {
    if (sidebarClosedByUrl(window.location.search)) return false;
    try {
      const saved = window.localStorage.getItem(SIDEBAR_KEY);
      return saved === "open" || (saved !== "closed" && (!snapshot || libraryEntries > 1));
    } catch {
      return true;
    }
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [phone, setPhone] = useState(
    () => typeof window.matchMedia === "function" && window.matchMedia(PHONE_WIDTH).matches,
  );
  useEffect(() => {
    const media = window.matchMedia?.(PHONE_WIDTH);
    const resize = () => {
      setPhone(media?.matches ?? false);
      if (!media?.matches) setDrawerOpen(false);
    };
    media?.addEventListener("change", resize);
    resize(); // Reconcile a resize between the initial render and subscription.
    return () => media?.removeEventListener("change", resize);
  }, []);
  const toggle = () => {
    if (phone) {
      setDrawerOpen((v) => !v);
      return;
    }
    setSideOpen((v) => {
      try {
        window.localStorage.setItem(SIDEBAR_KEY, v ? "closed" : "open");
      } catch {
        /* session preference still works */
      }
      return !v;
    });
  };
  return { phone, sideOpen, drawerOpen, setDrawerOpen, toggle };
}
