/** The human(ish) wordmark: serif (ish) device with accent parens. */
export function Ish() {
  return (
    <span className="ish"><span className="p">(</span><i>ish</i><span className="p">)</span></span>
  );
}

export function Wordmark({ href = "#", label }: { href?: string; label?: string }) {
  return (
    <a className="wm" href={href} {...(label ? { "aria-label": label } : {})}>
      human<Ish />
    </a>
  );
}
