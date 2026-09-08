import { IconButton } from "./ui/icon-button";
import { ReviewIcon } from "./review-icon";
import { curTheme, syncTheme } from "@/lib/humanish/theme";

// The same register contract as humanish.dev (site components/theme-toggle.tsx):
// system scheme by default, an explicit choice writes data-theme on <html> and
// persists to localStorage (restored pre-paint by the index.html init script).
export const THEME_STORAGE_KEY = "humanish-theme";

export function ThemeToggle() {
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
    <IconButton label="Toggle theme" hint="Switch light / dark theme" onClick={toggle}>
      <ReviewIcon name="moon" className="t-moon" /><ReviewIcon name="sun" className="t-sun" />
    </IconButton>
  );
}
