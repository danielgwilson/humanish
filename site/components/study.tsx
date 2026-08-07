import PinnedReplay from "./pinned-replay";

export default function Study() {
  return (
    <section id="study" className="band band-mineral">
      <p className="lead-claim rev">User testing for the users you can&rsquo;t recruit</p>
      <h2 className="rev" style={{ "--d": ".05s" } as React.CSSProperties}>Four missions drove <em>Excalidraw</em></h2>
      <p className="sec-sub rev" style={{ "--d": ".1s" } as React.CSSProperties}>This is run <code>cua-2026-08-07T17-44-48-760Z-87389419</code>: four computer-use lanes on hosted 1920×1080 desktops, driving a commit-pinned clone of Excalidraw, an open-source virtual whiteboard. 3/4 lanes passed; one gave up; verify ran 16/16 checks.</p>

      <dl className="manifest rev" style={{ "--d": ".15s" } as React.CSSProperties}>
        <div><dt>Run</dt><dd>cua-2026-08-07T17-44-48-760Z-87389419</dd></div>
        <div><dt>Date</dt><dd>2026-08-07</dd></div>
        <div><dt>Subject</dt><dd>excalidraw/excalidraw · commit-pinned</dd></div>
        <div><dt>Lanes</dt><dd>3/4 passed</dd></div>
        <div><dt>Verify</dt><dd>16/16 checks</dd></div>
        <div><dt>Status</dt><dd><span className="chip chip-dot chip-mute">local_only</span></dd></div>
        <div><dt>Wall-clock</dt><dd>6m 06s</dd></div>
        <div><dt>Est. cost</dt><dd>~$1.54 · estimated (rates as of 2026-08-05)</dd></div>
      </dl>

      <p className="whint">Scroll — the run advances in steps</p>
      <PinnedReplay />

      <div className="study-notes rev">
        <p>Verify passed 16/16, and the bundle still grades <code>local_only</code>: it holds full-fidelity screenshots, which the share-safety gate never marks share-ready as-is. Publishing these crops was a reviewed, deliberate act.</p>
        <p>In lane sketch-shapes, freehand strokes produced no change to the UI state for 8 consecutive turns, and the persona gave up.</p>
        <p>Excalidraw is the application studied; it is not a Humanish adopter or endorser.</p>
      </div>
    </section>
  );
}
