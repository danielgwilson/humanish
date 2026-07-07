import type {
  RunMeaningfulUseScore,
  RunSetupQualitySnapshot
} from "./run.js";

export interface OssMetaMeaningfulUseInput {
  actorLastMessageTail?: string;
  actorLogTail?: string;
  actorRequired: boolean;
  actorStatus?: "not_started" | "running" | "passed" | "failed" | "blocked" | "timed_out" | "suspended" | "unknown";
  appStatus?: "not_started" | "running" | "blocked" | "failed" | "missing" | "unknown";
  appUrl?: string;
  nestedObserverPresent?: boolean;
  nestedVerifyPassed?: boolean;
  setupQuality?: RunSetupQualitySnapshot;
  status: "running" | "passed" | "failed" | "blocked" | "timed_out";
  visualStatus?: "not_started" | "visible" | "blocked" | "unknown";
}

type Component = RunMeaningfulUseScore["components"][number];

const SCORE = {
  actor: 15,
  feedback: 25,
  filesystem: 10,
  nested: 20,
  product: 15,
  setup: 15
} as const;

export function scoreOssMetaMeaningfulUse(input: OssMetaMeaningfulUseInput): RunMeaningfulUseScore {
  const hardFailures: string[] = [];
  const components: Component[] = [
    scoreSetupCorrectness(input.setupQuality),
    scoreFilesystemEvidence(input.setupQuality),
    scoreNestedHomunEvidence(input, hardFailures),
    scoreActorActivity(input, hardFailures),
    scoreProductSurface(input, hardFailures),
    scoreFeedbackQuality(input)
  ];

  if (input.status === "failed") {
    hardFailures.push("Remote bootstrap failed.");
  } else if (input.status === "timed_out") {
    hardFailures.push("Remote bootstrap timed out.");
  }

  const score = Math.max(0, Math.min(100, Math.round(
    components.reduce((total, component) => total + component.score, 0)
  )));
  const allComponentsPassed = components.every((component) => component.status === "pass");
  const status = hardFailures.length > 0 || score < 45
    ? "fail"
    : score >= 80 && allComponentsPassed
      ? "pass"
      : "partial";

  return {
    schema: "homun.meaningful-use-score.v1",
    status,
    score,
    summary: meaningfulUseSummary(status, score, hardFailures, components),
    hardFailures,
    components
  };
}

function scoreSetupCorrectness(setupQuality: RunSetupQualitySnapshot | undefined): Component {
  if (!setupQuality) {
    return component("setup-correctness", "Setup correctness", "fail", 0, "No setup-quality snapshot was captured.");
  }

  const total = setupQuality.checks.length;
  const passed = setupQuality.checks.filter((check) => check.ok).length;
  if (setupQuality.status === "passed" && total > 0 && passed === total) {
    return component("setup-correctness", "Setup correctness", "pass", SCORE.setup, `All ${total} setup checks passed.`);
  }
  if (passed > 0) {
    return component("setup-correctness", "Setup correctness", "partial", 8, `${passed}/${Math.max(total, 1)} setup checks passed.`);
  }
  return component("setup-correctness", "Setup correctness", "fail", 0, "No setup checks passed.");
}

function scoreFilesystemEvidence(setupQuality: RunSetupQualitySnapshot | undefined): Component {
  if (!setupQuality) {
    return component("filesystem-evidence", "Filesystem evidence", "fail", 0, "No filesystem setup evidence was captured.");
  }

  const treeCount = setupQuality.tree.length;
  const previewCount = setupQuality.previews.length;
  const hasHomunSource = setupQuality.tree.some((entry) => entry.path === "homun" || entry.path.startsWith("homun/"));
  const previewsSuppressed = setupQuality.redaction.rawPreviews === "suppressed";
  if (treeCount >= 3 && hasHomunSource && (previewCount > 0 || previewsSuppressed)) {
    return component(
      "filesystem-evidence",
      "Filesystem evidence",
      "pass",
      SCORE.filesystem,
      previewsSuppressed
        ? `Captured ${treeCount} safe tree entries; previews intentionally suppressed by redaction.`
        : `Captured ${treeCount} safe tree entries and ${previewCount} allowlisted preview(s).`
    );
  }
  if (treeCount > 0) {
    return component("filesystem-evidence", "Filesystem evidence", "partial", 8, `Captured ${treeCount} safe tree entr${treeCount === 1 ? "y" : "ies"}, but Homun setup evidence is thin.`);
  }
  return component("filesystem-evidence", "Filesystem evidence", "fail", 0, "Filesystem tree evidence is empty.");
}

function scoreNestedHomunEvidence(input: OssMetaMeaningfulUseInput, hardFailures: string[]): Component {
  if (input.nestedVerifyPassed === true && input.nestedObserverPresent === true) {
    return component("nested-homun-evidence", "Nested Homun evidence", "pass", SCORE.nested, "Nested verify passed and the nested Observer is present.");
  }

  if (input.status !== "running") {
    if (input.nestedVerifyPassed === false) hardFailures.push("Nested Homun verification failed.");
    if (input.nestedObserverPresent === false) hardFailures.push("Nested Homun Observer was missing.");
  }

  if (input.nestedVerifyPassed === true || input.nestedObserverPresent === true) {
    return component("nested-homun-evidence", "Nested Homun evidence", "partial", 10, "Only one of nested verify or nested Observer presence was proven.");
  }
  return component("nested-homun-evidence", "Nested Homun evidence", input.status === "running" ? "partial" : "fail", input.status === "running" ? 5 : 0, "Nested Homun proof is not complete.");
}

function scoreActorActivity(input: OssMetaMeaningfulUseInput, hardFailures: string[]): Component {
  const actorText = `${input.actorLastMessageTail ?? ""}\n${input.actorLogTail ?? ""}`.trim();
  if (input.actorStatus === "passed") {
    return component("actor-activity", "Actor activity", "pass", SCORE.actor, actorText ? "Actor reached passed with public-safe evidence." : "Actor reached passed.");
  }

  if (input.actorRequired && input.status !== "running") {
    hardFailures.push(`Required actor did not pass${input.actorStatus ? ` (${input.actorStatus})` : ""}.`);
  }

  if (input.actorStatus === "running" || input.actorStatus === "suspended") {
    return component("actor-activity", "Actor activity", "partial", input.actorRequired ? 6 : 10, `Actor is ${input.actorStatus}; evidence may be incomplete.`);
  }
  if (actorText) {
    return component("actor-activity", "Actor activity", "partial", 7, "Actor emitted public-safe evidence but no passed terminal state.");
  }
  return component("actor-activity", "Actor activity", input.actorRequired ? "fail" : "partial", input.actorRequired ? 0 : 5, "No actor completion evidence was captured.");
}

function scoreProductSurface(input: OssMetaMeaningfulUseInput, hardFailures: string[]): Component {
  if (input.appStatus === "running" && input.visualStatus === "visible" && Boolean(input.appUrl)) {
    return component("product-surface", "Product surface", "pass", SCORE.product, "Target app URL was running and visible in the headed desktop.");
  }

  if (input.status === "passed" && (input.appStatus !== "running" || input.visualStatus !== "visible")) {
    hardFailures.push("Completed lane did not prove a running, visible product surface.");
  }

  if (input.appStatus === "running" || input.visualStatus === "visible") {
    return component("product-surface", "Product surface", "partial", 8, "Target app or visual surface was partially proven.");
  }
  return component("product-surface", "Product surface", input.status === "running" ? "partial" : "fail", input.status === "running" ? 4 : 0, "Target app surface was not proven running and visible.");
}

function scoreFeedbackQuality(input: OssMetaMeaningfulUseInput): Component {
  const studyQuality = input.setupQuality?.studyQuality;
  if (!studyQuality) {
    return component("feedback-quality", "Feedback quality", "fail", 0, "No study-quality rubric was captured.");
  }

  switch (studyQuality.rating) {
    case "high_leverage":
      return component("feedback-quality", "Feedback quality", "pass", SCORE.feedback, studyQuality.summary);
    case "useful":
      return component("feedback-quality", "Feedback quality", "pass", 20, studyQuality.summary);
    case "ceremonial":
      return component("feedback-quality", "Feedback quality", "partial", 8, studyQuality.summary);
    case "none":
      return component("feedback-quality", "Feedback quality", "fail", 0, studyQuality.summary);
  }
}

function component(
  id: Component["id"],
  label: string,
  status: Component["status"],
  score: number,
  detail: string
): Component {
  return { id, label, status, score, detail };
}

function meaningfulUseSummary(
  status: RunMeaningfulUseScore["status"],
  score: number,
  hardFailures: string[],
  components: Component[]
): string {
  if (hardFailures.length > 0) {
    return `Meaningful-use ${status} (${score}/100): ${hardFailures[0]}`;
  }
  const weak = components.filter((entry) => entry.status !== "pass").map((entry) => entry.label.toLowerCase());
  if (weak.length === 0) {
    return `Meaningful-use pass (${score}/100): setup, evidence, actor, product surface, and feedback signals are all strong.`;
  }
  return `Meaningful-use ${status} (${score}/100): needs stronger ${weak.slice(0, 3).join(", ")}${weak.length > 3 ? ", ..." : ""}.`;
}
