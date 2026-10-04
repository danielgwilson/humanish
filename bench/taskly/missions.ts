// The two missions the Taskly benchmark can send. Results record which one ran, with its digest.

export type MissionId = "neutral" | "walked";

export interface Mission {
  id: MissionId;
  text: string;
  note: string;
}

export const MISSIONS: Record<MissionId, Mission> = {
  // The benchmark default. It names the app and asks for ordinary use, and it names no feature a
  // planted defect sits on, so recall here includes whether the participant found the feature.
  neutral: {
    id: "neutral",
    text:
      "You are trying Taskly, a small web app for keeping a to-do list, for the first time. You have a " +
      "handful of errands and chores to keep track of this week. Use Taskly for them the way you would " +
      "actually use a list app, until you have decided whether you would keep using it. Report what " +
      "worked, and describe anything that behaved differently from what you expected, in plain terms, " +
      "saying what you did and what you saw.",
    note: "Names no feature a planted defect sits on.",
  },
  // The mission of humanish/studies/detect-taskly-{planted,clean}.yaml, unchanged, kept so new
  // results compare with the September results. Each step leads to one planted defect: a long task
  // (D2), the filters (D3), a rename (D5) and tidying up (D1); the app opens on the empty list (D4).
  walked: {
    id: "walked",
    text:
      "You are trying Taskly, a small web app for keeping a to-do list, for the first time. Use it the " +
      "way you would actually use a list app. Add a few tasks, including one long enough to describe " +
      "something properly. Mark something complete. Try the filters to see just what is left and just " +
      "what is finished. Rename one of your tasks. Tidy up when you are done. Report what worked, and " +
      "describe anything that behaved differently from what you expected, in plain terms, saying what " +
      "you did and what you saw.",
    note: "The September mission: one step per planted defect.",
  },
};
