import { Command } from "commander";
import {
  draftFeedback,
  listFeedback,
  renderIssueMarkdown,
  renderIssueUrl,
  verifyFeedback,
} from "../../feedback/feedback.js";
import type { FeedbackResult } from "../../feedback/feedback.js";
import {
  candidateOption,
  type CliIo,
  JSON_OPTION_DESCRIPTION,
  wantsJson,
  writeResult,
} from "../io.js";

export function registerFeedbackCommands(parent: Command, io: CliIo): void {
  const feedback = parent
    .command("feedback")
    .description("Create public-safe feedback drafts without GitHub API mutation.")
    .summary("Create public-safe feedback drafts, no GitHub API.");

  feedback
    .command("list")
    .description("List recorded feedback candidates and any saved draft.")
    .addHelpText(
      "after",
      "\nWith no candidates, feedback draft and feedback issue can generate a run-summary follow-up. Public drafting still requires share_ready verification.\n",
    )
    .option("--run <id>", "Run id or latest pointer.", "latest")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (options: { cwd: string; json?: boolean; run: string }, command) => {
      const result = await listFeedback(options.cwd, options.run);
      writeResult(command, io, result, formatFeedbackHuman);
      io.setExitCode(result.ok ? 0 : 2);
    });

  feedback
    .command("draft")
    .description("Generate a public-safe feedback draft from verified evidence.")
    .option("--run <id>", "Run id or latest pointer.", "latest")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--analysis <id>", "Independent analysis version; use with --finding.")
    .option("--finding <id>", "Finding within --analysis, separate from participant candidates.")
    .option(
      "--candidate <id>",
      "Which finding to draft (ids from `feedback list`); default: the first.",
    )
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(
      async (
        options: {
          candidate?: string;
          analysis?: string;
          finding?: string;
          cwd: string;
          json?: boolean;
          run: string;
        },
        command,
      ) => {
        const result = await draftFeedback(options.cwd, options.run, candidateOption(options));
        writeResult(command, io, result, formatFeedbackHuman);
        io.setExitCode(result.ok ? 0 : 2);
      },
    );

  feedback
    .command("verify")
    .description("Verify the feedback draft for public issue eligibility.")
    .option("--run <id>", "Run id or latest pointer.", "latest")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--analysis <id>", "Independent analysis version; use with --finding.")
    .option("--finding <id>", "Finding within --analysis, separate from participant candidates.")
    .option(
      "--candidate <id>",
      "Which finding to verify (ids from `feedback list`); default: the first.",
    )
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(
      async (
        options: {
          candidate?: string;
          analysis?: string;
          finding?: string;
          cwd: string;
          json?: boolean;
          run: string;
        },
        command,
      ) => {
        const result = await verifyFeedback(options.cwd, options.run, candidateOption(options));
        writeResult(command, io, result, formatFeedbackHuman);
        io.setExitCode(result.ok ? 0 : 2);
      },
    );

  feedback
    .command("issue")
    .description("Print Markdown for a public GitHub issue. Does not mutate GitHub.")
    .option("--run <id>", "Run id or latest pointer.", "latest")
    .option("--cwd <path>", "Target project directory.", ".")
    .requiredOption("--repo <owner/repo>", "Repository slug used in rendered filing instructions.")
    .option("--format <format>", "Output format.", "markdown")
    .option("--analysis <id>", "Independent analysis version; use with --finding.")
    .option("--finding <id>", "Finding within --analysis, separate from participant candidates.")
    .option(
      "--candidate <id>",
      "Which finding to file (ids from `feedback list`); default: the first.",
    )
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(
      async (
        options: {
          candidate?: string;
          analysis?: string;
          finding?: string;
          cwd: string;
          format: string;
          json?: boolean;
          repo: string;
          run: string;
        },
        command,
      ) => {
        const result = await renderIssueMarkdown(
          options.cwd,
          options.run,
          options.repo,
          candidateOption(options),
        );

        if (wantsJson(command)) {
          io.writeOut(`${JSON.stringify(result, null, 2)}\n`);
        } else if (options.format !== "markdown") {
          io.writeErr("Only --format markdown is supported.\n");
          io.setExitCode(2);
          return;
        } else if (result.ok && result.issueMarkdown) {
          io.writeOut(result.issueMarkdown);
        } else {
          io.writeErr(formatFeedbackHuman(result));
        }

        io.setExitCode(result.ok ? 0 : 2);
      },
    );

  feedback
    .command("issue-url")
    .description("Print a prefilled public issue URL. Does not mutate GitHub.")
    .option("--run <id>", "Run id or latest pointer.", "latest")
    .option("--cwd <path>", "Target project directory.", ".")
    .requiredOption("--repo <owner/repo>", "Repository slug used in the generated URL.")
    .option("--analysis <id>", "Independent analysis version; use with --finding.")
    .option("--finding <id>", "Finding within --analysis, separate from participant candidates.")
    .option(
      "--candidate <id>",
      "Which finding to link (ids from `feedback list`); default: the first.",
    )
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(
      async (
        options: {
          candidate?: string;
          analysis?: string;
          finding?: string;
          cwd: string;
          json?: boolean;
          repo: string;
          run: string;
        },
        command,
      ) => {
        const result = await renderIssueUrl(
          options.cwd,
          options.run,
          options.repo,
          candidateOption(options),
        );

        if (wantsJson(command)) {
          io.writeOut(`${JSON.stringify(result, null, 2)}\n`);
        } else if (result.ok && result.issueUrl) {
          io.writeOut(`${result.issueUrl}\n`);
        } else {
          io.writeErr(formatFeedbackHuman(result));
        }

        io.setExitCode(result.ok ? 0 : 2);
      },
    );
}

function formatFeedbackHuman(result: FeedbackResult): string {
  if (!result.ok) {
    return `${result.error?.code}: ${result.error?.message}\n`;
  }

  const candidates = result.candidates ?? [];
  const noCandidates = result.candidates !== undefined && candidates.length === 0;
  return (
    [
      noCandidates && result.draft === undefined
        ? "humanish feedback: no recorded candidates"
        : "humanish feedback ready",
      `run: ${result.run}`,
      ...(result.draftPath ? [`draft: ${result.draftPath}`] : []),
      ...(result.issuePath ? [`issue: ${result.issuePath}`] : []),
      ...(result.draft?.source_candidate_id
        ? [`candidate: ${result.draft.source_candidate_id}`]
        : []),
      ...(noCandidates
        ? [
            "candidates: none recorded",
            "With no candidates, feedback draft and feedback issue can generate a run-summary follow-up after share_ready verification.",
            ...(result.draft ? [`summary: ${result.draft.summary}`] : []),
          ]
        : []),
      // Every finding the run produced, so the second and third are one flag away (#609).
      ...(candidates.length > 1 || (candidates.length === 1 && result.draft === undefined)
        ? [
            `candidates (${candidates.length}; choose one with --candidate <id>):`,
            ...candidates.map(
              (item) => `- ${item.id} [${item.failure_owner}] ${item.persona_id}: ${item.summary}`,
            ),
          ]
        : []),
    ].join("\n") + "\n"
  );
}
