import { useSyncExternalStore } from "react";
import { IconButton } from "./ui/icon-button";
import { ReviewIcon } from "./review-icon";
import { curTheme, onThemeRedraw, syncTheme } from "@/lib/humanish/theme";

// The same register contract as humanish.dev (site components/theme-toggle.tsx):
// system scheme by default, an explicit choice writes data-theme on <html> and
// persists to localStorage (restored pre-paint by the index.html init script).
export const THEME_STORAGE_KEY = "humanish-theme";

export function ThemeToggle() {
  const theme = useSyncExternalStore(onThemeRedraw, curTheme, () => "light");
  const nextTheme = theme === "dark" ? "light" : "dark";
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
    <IconButton label={`Switch to ${nextTheme} theme`} onClick={toggle}>
      <ReviewIcon name={theme === "dark" ? "sun" : "moon"} />
    </IconButton>
  );
}
