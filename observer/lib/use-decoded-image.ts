import { useEffect, useRef, useState } from "react";

export interface DecodedImage { href: string; key: string; width: number; height: number }

/** Keep the actual decoded DOM image alive until its replacement is ready.
 * Decoding in a detached Image then assigning its URL again can refetch no-store
 * captures. Callers render these keyed slots and explicitly label old evidence. */
export function useDecodedImage(href: string | null) {
  const [decoded, setDecoded] = useState<DecodedImage | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const requested = useRef(href);
  requested.current = href;
  const candidateKey = `${href ?? ""}:${attempt}`;
  const latestKey = useRef(candidateKey);
  latestKey.current = candidateKey;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // No capture (or switching to live) unmounts the slots. Their old URLs no
  // longer imply that a decoded DOM node exists when recording resumes.
  useEffect(() => { if (!href) { setDecoded(null); setFailed(null); } }, [href]);
  const status = href && failed === candidateKey ? "error" : href && decoded?.href === href ? "ready" : "loading";
  const slots = decoded ? [{ href: decoded.href, key: decoded.key, pending: false }] : [];
  if (href && decoded?.href !== href) slots.push({ href, key: candidateKey, pending: !!decoded });
  const loaded = async (image: HTMLImageElement, key: string) => {
    const source = image.getAttribute("src");
    try {
      await image.decode?.();
      if (!mounted.current || requested.current !== source || latestKey.current !== key) return;
      if (!image.naturalWidth || !image.naturalHeight) { setFailed(key); return; }
      setDecoded({ href: source!, key, width: image.naturalWidth, height: image.naturalHeight });
      setFailed(null);
    } catch { if (mounted.current && latestKey.current === key) setFailed(key); }
  };
  const errored = (key: string) => { if (latestKey.current === key) setFailed(key); };
  return { decoded, slots, status, loaded, errored, retry: () => { setFailed(null); setAttempt((value) => value + 1); } };
}
