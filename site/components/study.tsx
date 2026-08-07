import PinnedReplay from "./pinned-replay";

export default function Study() {
  return (
    <section id="study" className="band band-mineral">
      <p className="lead-claim rev">User testing for the users you can&rsquo;t recruit</p>
      <h2 className="rev" style={{ "--d": ".05s" } as React.CSSProperties}>Four personas drove <em>drawDB</em></h2>
      <p className="sec-sub rev" style={{ "--d": ".1s" } as React.CSSProperties}>This is run <code>drawdb-study-20260801-wide-05</code>: four computer-use lanes on hosted 1920×1080 desktops, driving a commit-pinned checkout of drawDB, an open-source database diagram editor. 4/4 lanes passed; verify ran 15/15 checks.</p>

      <dl className="manifest rev" style={{ "--d": ".15s" } as React.CSSProperties}>
        <div><dt>Run</dt><dd>drawdb-study-20260801-wide-05</dd></div>
        <div><dt>Date</dt><dd>2026-08-01</dd></div>
        <div><dt>Subject</dt><dd>drawDB · commit-pinned</dd></div>
        <div><dt>Lanes</dt><dd>4/4 passed</dd></div>
        <div><dt>Verify</dt><dd>15/15 checks</dd></div>
        <div><dt>Status</dt><dd><span className="chip chip-dot chip-mute">local_only</span></dd></div>
        <div><dt>Wall-clock</dt><dd>— · not recorded</dd></div>
        <div><dt>Est. cost</dt><dd>—</dd></div>
      </dl>

      <p className="whint">Scroll — the run advances in steps</p>
      <PinnedReplay />

      <div className="study-notes rev">
        <p>Verify passed 15/15, and the bundle still grades <code>local_only</code>: it holds full-fidelity screenshots, which the share-safety gate never marks share-ready as-is. Publishing these crops was a reviewed, deliberate act.</p>
        <p>drawDB is the application studied; it is not a Humanish adopter or endorser.</p>
      </div>
    </section>
  );
}
