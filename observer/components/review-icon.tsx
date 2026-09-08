// Small, dependency-free glyphs shared by the review controls.
export function ReviewIcon({ name }: { name: "pin" | "compare" | "more" | "bookmark" | "notice" }) {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === "pin" ? <><path d="m16 3 5 5-4 2-3 5-5-5 5-3 2-4Z" /><path d="m9 15-6 6M7 8l9 9" /></>
      : name === "compare" ? <><rect x="3" y="4" width="7" height="16" rx="1.5" /><rect x="14" y="4" width="7" height="16" rx="1.5" /></>
        : name === "bookmark" ? <path d="M6 3h12v18l-6-4-6 4V3Z" />
          : name === "notice" ? <><path d="m12 3 10 18H2L12 3Z" /><path d="M12 9v5m0 3v.1" /></>
            : <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>}
  </svg>;
}
