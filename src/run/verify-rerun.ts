import type { RunBundle } from "./bundle.js";

/** A rerun bundle must link each selected lane to its prior status and a fan-out rerun event. */
export function rerunLineageFindings(bundle: RunBundle): string[] {
  const rerun = bundle.rerun;
  if (!rerun) {
    return [];
  }

  const findings: string[] = [];
  const selectedLaneIds = rerun.selectedLaneIds;
  const selectedSet = new Set(selectedLaneIds);
  const previousLaneIds = rerun.previous.map((entry) => entry.laneId);
  const previousSet = new Set(previousLaneIds);
  const currentLaneIds = bundle.streams.map((stream) => stream.laneId);
  const currentConcreteLaneIds = currentLaneIds.filter(
    (laneId): laneId is string => typeof laneId === "string" && laneId.trim().length > 0,
  );
  const currentSet = new Set(currentConcreteLaneIds);

  if (selectedSet.size !== selectedLaneIds.length) {
    findings.push("selectedLaneIds contains duplicate lane ids");
  }
  if (previousSet.size !== previousLaneIds.length) {
    findings.push("previous contains duplicate lane ids");
  }
  if (currentConcreteLaneIds.length !== bundle.streams.length) {
    findings.push("every rerun stream must carry a laneId");
  }
  for (const laneId of selectedLaneIds) {
    if (!previousSet.has(laneId)) {
      findings.push(`selected lane ${laneId} is missing prior status`);
    }
    if (!currentSet.has(laneId)) {
      findings.push(`selected lane ${laneId} is missing from current streams`);
    }
  }
  for (const laneId of previousLaneIds) {
    if (!selectedSet.has(laneId)) {
      findings.push(`previous lane ${laneId} was not selected`);
    }
  }
  for (const laneId of currentConcreteLaneIds) {
    if (!selectedSet.has(laneId)) {
      findings.push(`current stream lane ${laneId} was not selected`);
    }
  }
  if (!bundle.events.some((event) => event.type === "cua-lab.fanout.rerun")) {
    findings.push("missing cua-lab.fanout.rerun event");
  }

  return findings;
}
