"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Copy-to-clipboard button for install commands. Progressive enhancement:
 * CSS shows it only under html.js, so no-JS visitors just read the commands
 * as text (which stay selectable/copyable — the trust requirement).
 */
export default function CopyButton({ text, label = "copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const onClick = () => {
    const done = () => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, done);
    } else {
      done();
    }
  };

  return (
    <button className="copy" type="button" data-copy={text} onClick={onClick}>
      {copied ? "copied" : label}
    </button>
  );
}
