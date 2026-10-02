import type { RunBundle } from "../run/bundle.js";

/** A rerun bundle must link each selected participant to its prior status and a fan-out rerun event. */
export function rerunLineageFindings(bundle: RunBundle): string[] {
  const rerun = bundle.rerun;
  if (!rerun) {
    return [];
  }

  const findings: string[] = [];
  const selectedIds = rerun.selectedLaneIds;
  const selectedSet = new Set(selectedIds);
  const previousIds = rerun.previous.map((entry) => entry.laneId);
  const previousSet = new Set(previousIds);
  const currentIds = bundle.streams.map((stream) => stream.laneId);
  const currentConcreteIds = currentIds.filter(
    (id): id is string => typeof id === "string" && id.trim().length > 0,
  );
  const currentSet = new Set(currentConcreteIds);

  if (selectedSet.size !== selectedIds.length) {
    findings.push("selectedLaneIds contains duplicate participant ids");
  }
  if (previousSet.size !== previousIds.length) {
    findings.push("previous contains duplicate participant ids");
  }
  if (currentConcreteIds.length !== bundle.streams.length) {
    findings.push("every rerun stream must carry a laneId");
  }
  for (const id of selectedIds) {
    if (!previousSet.has(id)) {
      findings.push(`selected participant ${id} is missing prior status`);
    }
    if (!currentSet.has(id)) {
      findings.push(`selected participant ${id} is missing from current streams`);
    }
  }
  for (const id of previousIds) {
    if (!selectedSet.has(id)) {
      findings.push(`previous participant ${id} was not selected`);
    }
  }
  for (const id of currentConcreteIds) {
    if (!selectedSet.has(id)) {
      findings.push(`current participant ${id} was not selected`);
    }
  }
  if (!bundle.events.some((event) => event.type === "cua-lab.fanout.rerun")) {
    findings.push("missing cua-lab.fanout.rerun event");
  }

  return findings;
}
