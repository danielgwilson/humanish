"use client";

import { useEffect, useId, useRef, useState } from "react";
import { track } from "@vercel/analytics";
import { copyCommand } from "../lib/copy-command";

/** Commands remain selectable when JavaScript or clipboard access is unavailable. */
export default function CopyButton({ text, label = "copy" }: { text: string; label?: string }) {
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const statusId = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempt = useRef(0);
  const busy = useRef(false);

  useEffect(() => () => {
    attempt.current += 1;
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const onClick = async () => {
    if (busy.current) return;
    busy.current = true;
    const current = ++attempt.current;
    if (timer.current) clearTimeout(timer.current);
    setStatus("copying");
    const outcome = await copyCommand(text, navigator.clipboard, track);
    if (current !== attempt.current) return;
    busy.current = false;
    setStatus(outcome === "success" ? "copied" : "failed");
    if (outcome === "success") timer.current = setTimeout(() => setStatus("idle"), 1400);
  };

  return (
    <span className="copy-control">
      <button className="copy" type="button" data-copy={text} onClick={onClick}
        disabled={status === "copying"} aria-busy={status === "copying"} aria-describedby={statusId}>
        {status === "copied" ? "copied" : status === "copying" ? "copying" : label}
      </button>
      <span id={statusId} role="status" aria-live="polite" aria-atomic="true"
        className={status === "failed" ? "copy-feedback" : "sr-only"}>
        {status === "failed" ? "Couldn’t copy. Select the command text to copy it." : status === "copied" ? "Command copied." : ""}
      </span>
    </span>
  );
}
