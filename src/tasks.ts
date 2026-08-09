// Tasks: the researcher's protocol, expressed as config (docs/principles/three-roles.md).
//
// A lab could declare a prose `mission` and nothing else. That is a brief, not a protocol — and it
// left "where did people get stuck" answerable only from an actor's own narration, which is the one
// source a study should not have to take on faith.
//
// Real usability studies are built from discrete TASKS, each with a written success criterion, and
// the result is a funnel: how far each participant got before they stopped. That funnel is the
// finding. A single pass/fail per participant throws it away.
//
// The criterion language is `stopWhen`, unchanged and already load-bearing elsewhere: a task is
// done when an observation satisfies it. Reusing it means a task criterion is exactly as expressive
// as a stop condition, and an author who knows one knows the other.
//
// A task's completion is CORROBORATED, not self-reported. The actor saying "I signed up" does not
// complete a task; the observed URL, page text, or app state does. That distinction is the whole
// reason to declare tasks at all.

import { evaluateStopWhen, type StopConditionObservation, type StopWhen } from "./stop-conditions.js";

export const TASK_FUNNEL_SCHEMA = "humanish.task-funnel.v1" as const;

/**
 * One task in a protocol. It has two halves that belong to two different people, and keeping them
 * apart is the point of the type.
 *
 * `goal` belongs to the PARTICIPANT. It is what they are asked to do, in their language, and it is
 * the only half that reaches the prompt.
 *
 * `success` belongs to the RESEARCHER. It is how the task will be measured, and the participant
 * never sees it — a moderator does not read the success criterion aloud, because telling someone
 * how they will be judged changes what they do. A persona told "you succeed when the URL contains
 * /dashboard" will go find that URL, which measures the instruction rather than the product.
 */
export interface LabTask {
  /** Stable id, used in evidence and in the funnel. Researcher-facing. */
  id: string;
  /** PARTICIPANT-FACING. What they are asked to do. The only half that reaches the prompt. */
  goal: string;
  /** RESEARCHER-FACING. Observation-shaped proof the task happened. Never rendered to the
   *  participant. Absent means the task is narrative-only: it is asked for but cannot be measured,
   *  and the funnel says so rather than quietly counting it as failed. */
  success?: StopWhen;
}

/** When a task was first observed complete. */
export interface TaskCompletion {
  id: string;
  /** Turn number on which the criterion was first satisfied. */
  turn: number;
  /** Which rule matched, for a reader who wants to know what counted as proof. */
  matchedRuleIndex: number;
  matchedKinds: string[];
}

/** The result a researcher actually wants: how far each participant got. */
export interface TaskFunnel {
  schema: typeof TASK_FUNNEL_SCHEMA;
  /** Declared tasks, in order. */
  total: number;
  /** Tasks observed complete. */
  completed: number;
  /** Declared tasks with no `done` criterion — shown to the participant, never observable. */
  unobservable: number;
  /** The first task that was NOT observed complete: where this participant stopped. */
  stoppedAt?: string;
  /** Per-task, in declaration order. */
  tasks: Array<{ id: string; completed: boolean; observable: boolean; turn?: number }>;
}

/**
 * Tracks task completion across a session. Stateful on purpose: a task completes ONCE, on the first
 * observation that satisfies it, and stays complete even if the participant navigates away — you do
 * not un-sign-up by going back to the home page.
 */
export class TaskTracker {
  private readonly completions = new Map<string, TaskCompletion>();

  constructor(private readonly tasks: readonly LabTask[]) {}

  /** Evaluate every still-incomplete task against one observation. Returns newly completed tasks. */
  observe(observation: StopConditionObservation, turn: number): TaskCompletion[] {
    const fresh: TaskCompletion[] = [];
    for (const task of this.tasks) {
      if (task.success === undefined || this.completions.has(task.id)) continue;
      const match = evaluateStopWhen(task.success, observation);
      if (!match) continue;
      const completion: TaskCompletion = {
        id: task.id,
        turn,
        matchedRuleIndex: match.ruleIndex,
        matchedKinds: match.kinds
      };
      this.completions.set(task.id, completion);
      fresh.push(completion);
    }
    return fresh;
  }

  /** The funnel as it stands. */
  funnel(): TaskFunnel {
    const tasks = this.tasks.map((task) => {
      const completion = this.completions.get(task.id);
      return {
        id: task.id,
        completed: completion !== undefined,
        observable: task.success !== undefined,
        ...(completion === undefined ? {} : { turn: completion.turn })
      };
    });
    // Where they stopped is the first task not observed complete — the thing a researcher reads
    // first. An unobservable task cannot be "where they stopped", because nothing could have
    // proven otherwise; skipping it avoids blaming a participant for a gap in the protocol.
    const stoppedAt = tasks.find((task) => task.observable && !task.completed)?.id;
    return {
      schema: TASK_FUNNEL_SCHEMA,
      total: tasks.length,
      completed: tasks.filter((task) => task.completed).length,
      unobservable: tasks.filter((task) => !task.observable).length,
      ...(stoppedAt === undefined ? {} : { stoppedAt }),
      tasks
    };
  }
}

/**
 * The task list as the PARTICIPANT reads it: numbered, in order, in their own language.
 *
 * Reads `goal` and nothing else. The success criteria are the researcher's instrument and never
 * appear here — a participant who is told how they will be measured optimizes for the measurement,
 * and the study stops being about the product. A test pins this, because it is the kind of leak a
 * later convenience change makes without noticing.
 */
export function renderTaskPrompt(tasks: readonly LabTask[]): string | undefined {
  if (tasks.length === 0) return undefined;
  const lines = tasks.map((task, index) => `${index + 1}. ${task.goal}`);
  return `Work through these in order:\n${lines.join("\n")}`;
}

/** One line a stakeholder can read, with the denominator attached. */
export function formatTaskFunnel(funnel: TaskFunnel): string {
  if (funnel.total === 0) return "no tasks declared";
  const base = `${funnel.completed}/${funnel.total} tasks completed`;
  const stopped = funnel.stoppedAt === undefined ? "" : `, stopped at "${funnel.stoppedAt}"`;
  const unobservable = funnel.unobservable === 0
    ? ""
    : `, ${funnel.unobservable} with no completion criterion`;
  return `${base}${stopped}${unobservable}`;
}
