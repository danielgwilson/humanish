"use client";

import { curTheme, syncTheme } from "@/lib/theme";

export const THEME_STORAGE_KEY = "humanish-theme";

/**
 * The nav theme toggle. Writes data-theme on <html> (the token system keys
 * off it), persists the choice, and resyncs every canvas. Hidden without JS
 * via the POC's `.js .tbtn` rule.
 */
export default function ThemeToggle() {
  const toggle = () => {
    const next = curTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* private mode etc. — the attribute alone still themes this visit */
    }
    syncTheme();
  };

  return (
    <button className="tbtn" id="themeBtn" type="button" aria-label="Toggle color theme" onClick={toggle}>
      <svg className="t-moon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
      <svg className="t-sun" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
    </button>
  );
}
