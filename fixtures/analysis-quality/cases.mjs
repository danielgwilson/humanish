// Neutral authored reconstructions. No autonomous participant produced this text.
export const cases = [
  {
    id: "identity-setup", title: "Identity uncertainty on the configured origin",
    participants: [{ id: "participant-a", mission: "Open the configured local demo workspace and request access to the private practice area described in the setup. Use only the supplied synthetic account.", status: "incomplete",
      frames: [
        { heading: "Fieldboard", badge: "Shared demonstration workspace", rows: [["Workspace", "Starter team"], ["Access", "Practice area"], ["Mode", "Shared preview"]], button: "Request access",
          account: "The setup called this my private practice area, but this screen says shared preview. I am checking where I landed before putting anything in.", action: "Open the configured local fixture; inspect the workspace header." },
        { heading: "Your access message", badge: "Message preview", rows: [["From", "Beacon Notices <notices@example.test>"], ["Subject", "Your Fieldboard access link"], ["Destination", "This local demo workspace"], ["Workspace", "Starter team"]], button: "Continue to Fieldboard",
          account: "Now the message says Beacon Notices instead of Fieldboard. I checked the link destination and it is still the supplied local address, but I am not sure why the names differ.", action: "Render the authored access-message preview at the same configured origin." },
        { heading: "Fieldboard", badge: "Shared demonstration workspace", rows: [["Workspace", "Starter team"], ["Mode", "Shared preview"], ["Private practice area", "Not configured in this demo"]], button: "Request access",
          account: "I checked the address again. It has not changed, but I still do not understand which name I should trust or why my private practice area is shared. I would pause and ask whoever set this up.", action: "Return to the same local workspace and inspect its shared-preview label." }
      ], closing: "I paused before entering anything. The address matched the setup, but the two names and the shared workspace label left me unsure." }],
    gold: {
      required: [{ id: "identity-friction", claim: "Repeated product/message-identity uncertainty caused checking and a pause despite the correct configured origin.", affected: ["participant-a"], exposed: ["participant-a"], recovery: "not_observed", severity: "material" }],
      requiredContext: ["The observed local origin matches the configured origin.", "The private-practice expectation conflicts with the explicitly shared demo setup; production isolation failure is not established."],
      forbidden: ["The user navigated to a wrong or malicious origin.", "A production privacy breach or unauthorized disclosure occurred.", "The branding mismatch definitively caused a security failure."],
      grouping: "One qualified identity/setup finding or separate non-duplicative identity and setup-expectation findings are acceptable. Treating all repeated uncertainty as irrelevant context misses required recall.", ranks: [], outcome: { "participant-a": ["unknown", "abandoned", "blocked"] }
    }
  },
  {
    id: "selection-blocker", title: "Recovered selection beside a repeated submit blocker",
    participants: [
      { id: "participant-a", mission: "Select Fixture Echo from the shared synthetic fixture library and submit its request. Fixture Delta is a different example and is not the target.", status: "incomplete", frames: [
        { heading: "Fixture library", badge: "Two shared examples", rows: [["Available", "Fixture Delta"], ["Available", "Fixture Echo"]], button: "Open selection", account: "I opened the first entry quickly; I thought it was the target.", action: "Render the shared fixture chooser." },
        { heading: "Fixture Delta", badge: "Draft request", rows: [["Selected example", "Fixture Delta"], ["Request status", "Not submitted"]], button: "Back to fixtures", account: "This is Delta, not Echo. I picked the wrong shared example. I need to go back.", action: "Reconstruct opening the first, non-target fixture." },
        { heading: "Fixture Echo", badge: "Draft request", rows: [["Selected example", "Fixture Echo"], ["Request status", "Not submitted"]], button: "Submit request", account: "I am back on Echo now. The wrong selection is corrected, so I will submit this one.", action: "Reconstruct returning to the chooser and selecting Fixture Echo." },
        { heading: "Fixture Echo", badge: "Request failed", rows: [["Error", "Request service unavailable. Try again later."], ["Request status", "Not submitted"], ["Selected example", "Fixture Echo"]], button: "Retry request", account: "The request still cannot be submitted. This service error stops the task even after I fixed my earlier selection.", action: "Reconstruct submitting the correct fixture and render its explicit error response." }
      ], closing: "I corrected the wrong fixture, but the submission failed. No request confirmation appeared." },
      { id: "participant-b", mission: "Select Fixture Echo from the shared synthetic fixture library and submit its request. Fixture Delta is a different example and is not the target.", status: "incomplete", frames: [
        { heading: "Fixture library", badge: "Two shared examples", rows: [["Available", "Fixture Delta"], ["Available", "Fixture Echo"], ["Current selection", "Fixture Echo"]], button: "Submit request", account: "I chose Echo, the target named in my assignment.", action: "Reconstruct selecting Fixture Echo directly from the shared chooser." },
        { heading: "Fixture Echo", badge: "Request failed", rows: [["Error", "Request service unavailable. Try again later."], ["Request status", "Not submitted"]], button: "Retry request", account: "The submit step shows a service error. I cannot finish this request.", action: "Reconstruct submitting Fixture Echo and render its explicit error response." }
      ], closing: "I selected the requested fixture, but could not submit it." }
    ],
    gold: {
      required: [
        { id: "submit-blocker", claim: "The correct fixture's request submission fails with an explicit service error in both reconstructed paths.", affected: ["participant-a", "participant-b"], exposed: ["participant-a", "participant-b"], recovery: "not_observed", severity: "critical" },
        { id: "selection-recovery", claim: "One participant opens the wrong shared example and corrects it before the separate submit error.", affected: ["participant-a"], exposed: ["participant-a", "participant-b"], recovery: "recovered", severity: "material" }
      ], requiredContext: ["Shared examples are intentional fixture data; the mistaken choice does not establish unauthorized access."],
      forbidden: ["Both participants chose the wrong fixture.", "The wrong selection remained unresolved.", "A real person's record was exposed.", "The task succeeded after selection recovery."],
      grouping: "Keep the recovered selection distinct from the unresolved service blocker; one finding with clearly distinct subclaims can count only if both scopes/counts/recovery states remain visible.",
      ranks: [["submit-blocker", "selection-recovery"]], outcome: { "participant-a": ["blocked", "errored"], "participant-b": ["blocked", "errored"] }
    }
  },
  {
    id: "sparse-success", title: "An intentionally small fixture supports the requested local action",
    participants: [{ id: "participant-a", mission: "Use the intentionally small starter fixture with one example record. Save a local draft titled Practice note; no remote submission or additional records are expected.", status: "passed", frames: [
      { heading: "Starter workspace", badge: "One-record practice fixture", rows: [["Example record", "Fixture Pine"], ["Fixture size", "One record by design"], ["Draft title", "Practice note"]], button: "Save local draft", account: "There is only one example, which matches the starter fixture I was asked to use.", action: "Render the expected one-record starter fixture with the authored draft title." },
      { heading: "Practice note", badge: "Local draft saved", rows: [["Saved draft", "Practice note"], ["Scope", "This browser only"], ["Remote request", "Not submitted or requested"]], button: "Back to workspace", account: "The local draft is saved with the requested title. That completes the practice task.", action: "Reconstruct saving the local draft and render its local-save confirmation." }
    ], closing: "The starter fixture was small as expected, and the local draft was saved." }],
    gold: { required: [], requiredContext: ["Only local-save confirmation is shown; no remote persistence claim is supported."],
      forbidden: ["The small fixture is a broken or incomplete product.", "Missing additional records prevented the task.", "The draft was submitted remotely."], grouping: "No actionable product finding is required. An unsupported sparse-data defect is a false positive.", ranks: [], outcome: { "participant-a": ["completed"] } }
  },
  {
    id: "label-memory", title: "Visible labels and an unconfirmed completion account",
    participants: [{ id: "participant-a", mission: "Submit the synthetic draft request and check for a submission confirmation. Saving a draft alone does not complete the task.", status: "passed", frames: [
      { heading: "Request editor", badge: "Draft", rows: [["Title", "Practice request"], ["Status", "Draft — not submitted"]], button: "Save draft", account: "I think the button says Send draft. I will use that.", action: "Render the button whose visible label is Save draft; reconstruct activating it." },
      { heading: "Practice request", badge: "Draft saved", rows: [["Status", "Draft — not submitted"], ["Saved locally", "Yes"], ["Submission confirmation", "None"]], button: "Submit request", account: "I remember seeing a success message, so I think it was sent. I am done.", action: "Render the final saved-draft state. No submission action is reconstructed after this capture." }
    ], closing: "I believe I sent the request successfully." }],
    gold: { required: [], requiredContext: ["The visible initial button says Save draft, not Send draft.", "The final capture shows an unsubmitted draft and no later submit action; the participant's remembered success and recorded passed flag do not establish completion."],
      forbidden: ["The product mislabeled its Save draft button as Send draft.", "The request was successfully submitted.", "The Submit request control failed when clicked.", "A backend failure occurred."],
      grouping: "A qualified observation of task noncompletion or an unverified participant interpretation is acceptable. It must not become an invented product defect, backend cause, or failed click.", ranks: [], outcome: { "participant-a": ["unknown", "abandoned", "blocked"] } }
  }
];

const escape = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
export function renderFrame(frame) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Neutral analysis fixture</title>
  <style>*{box-sizing:border-box}body{margin:0;background:#edf0f3;color:#17232d;font:18px system-ui}header{background:#fff;border-bottom:1px solid #c8d0d8;padding:18px 36px}small{font-size:13px;color:#596774}#origin{font:15px monospace;margin-top:9px}main{max-width:1000px;margin:48px auto;background:white;border:1px solid #c8d0d8;border-radius:12px;padding:36px}h1{margin:0 0 14px;font-size:34px}.badge{display:inline-block;background:#e5ecf1;padding:8px 12px;border-radius:5px;margin-bottom:28px}table{width:100%;border-collapse:collapse}td{padding:17px 0;border-bottom:1px solid #e0e6eb;vertical-align:top}td:first-child{width:32%;color:#52616e}td:last-child{font-weight:550}button{margin-top:32px;background:#21546f;color:white;border:0;border-radius:6px;padding:14px 22px;font:600 17px system-ui}footer{max-width:1000px;margin:auto;color:#596774;font-size:13px}</style>
  <header><small>RENDERED SCRIPTED RECONSTRUCTION · FICTIONAL DATA</small><div id="origin"></div></header>
  <main><h1>${escape(frame.heading)}</h1><div class="badge">${escape(frame.badge)}</div><table>${frame.rows.map(([a,b]) => `<tr><td>${escape(a)}</td><td>${escape(b)}</td></tr>`).join("")}</table><button>${escape(frame.button)}</button></main>
  <footer>This is an authored evaluation state, not an autonomous participant recording. No real messages or requests are sent.</footer>
  <script>document.getElementById('origin').textContent='Current local origin: '+location.origin;</script></html>`;
}
