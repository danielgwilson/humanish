// The answer key for the Taskly fixture: every claim class the scorer knows, what makes a sentence
// carry that claim, and whether the claim is true of each build. bench/taskly-planted and
// bench/taskly-clean differ only in app.js; bench/DEFECTS.md describes the five mutations. The
// -local builds add localStorage to each, which only B10's truth depends on.
//
// Patterns run on normalized text (lower case, straight quotes, no Markdown emphasis; see
// bench/lib/text.ts). They are deliberately specific to this app. A change to any pattern or truth
// value is a new rubric version, and results carry the version and a digest of this file.

export const RUBRIC_ID = "taskly-rubric";
export const RUBRIC_VERSION = 4;

export type Arm = "planted" | "clean";
export type DefectId = "D1" | "D2" | "D3" | "D4" | "D5";
export const DEFECT_IDS: readonly DefectId[] = ["D1", "D2", "D3", "D4", "D5"];

/**
 * Whether a claim holds on a build. `typed-over-120` holds only when the participant typed more
 * than 120 characters in one action: the add box's `maxlength="120"` (index.html) is the one way
 * a clean build shortens text. `memory-storage` holds only on the builds that keep tasks in memory.
 */
export type Truth = "true" | "false" | "typed-over-120" | "memory-storage";

/** Where the served build keeps its tasks: in memory, lost on reload, or in localStorage. */
export type Storage = "memory" | "local";

/** Facts that a claim's truth or a harness attribution can depend on. */
export interface EvidenceFacts {
  /** The served build's storage. The trace does not show it, so it comes from the bench manifest. */
  storage: Storage;
  /** The longest single typing action in the participant's trace, in characters. */
  maxTypedChars: number | null;
  /** The trace carries a provider stall or retry notice. */
  providerStall: boolean;
  /** The trace carries a desktop action that did not complete. */
  failedAction: boolean;
  /** The persona's applied traits, as recorded in the trace. */
  personaTraits: readonly string[];
  /** The participant's mission text. */
  mission: string;
}

interface ClaimClassBase {
  id: string;
  label: string;
  /** A sentence carries the claim when any pattern matches it. */
  claim: readonly RegExp[];
}

export interface PlantedDefect extends ClaimClassBase {
  kind: "planted";
  id: DefectId;
  severity: string;
  source: string;
  truth: Record<Arm, Truth>;
  /** A sentence that says the broken control worked. Never counted when it contains a negation. */
  assurance: readonly RegExp[];
}

export interface BaselineClaim extends ClaimClassBase {
  kind: "baseline";
  source: string;
  truth: Record<Arm, Truth>;
}

export interface ContradictedClaim extends ClaimClassBase {
  kind: "contradiction";
  source: string;
  truth: Record<Arm, Truth>;
}

export interface HarnessClaim extends ClaimClassBase {
  kind: "harness";
  /** The retained evidence that ties this claim to the harness. Without it the claim is unresolved. */
  evidence: (facts: EvidenceFacts) => boolean;
  evidenceLabel: string;
}

export type ClaimClass = PlantedDefect | BaselineClaim | ContradictedClaim | HarnessClaim;

const CC = String.raw`clear[- ]completed`;
const NO_EFFECT = String.raw`(?:did nothing|does nothing|do nothing|did not (?:visibly )?(?:do anything|work|remove|clear|respond|delete)|didn't (?:visibly )?(?:do anything|work|remove|clear|respond|delete)|does not (?:work|remove|clear|do anything|respond)|doesn't (?:work|remove|clear|do anything|respond)|had no (?:visible )?effect|has no effect|no effect|gave no (?:visible )?(?:response|feedback)|was unresponsive|failed to (?:remove|clear|work)|nothing happened|nothing changed|produced no (?:visible )?(?:removal|change|effect)|left (?:the |my |both |all )?(?:\w+ )?(?:completed|finished|checked|ticked|done) (?:tasks?|rows?|items?) (?:visible|in place|there)|wasn't (?:removed|cleared)|was not (?:removed|cleared))`;
const TRUNCATED = String.raw`(?:truncat\w*|cut off|cut down|cut short|chopped|clipped|shortened|trimmed|mid-word|got cut|stopped at|ends? mid|cut at)`;
const DONE = String.raw`(?:completed|finished|ticked|checked|crossed[- ]out|struck[- ]through|done)`;
const OPEN = String.raw`(?:unfinished|unticked|unchecked|remaining|incomplete|open|active|not[- ]done|outstanding|uncompleted)`;
const SHOWED = String.raw`(?:showed|shows|show|displayed|displays|listed|lists|saw|see|contained|had)`;
const AFTER_SHOWED = String.raw`(?: me)?(?: only)?(?: the)?(?: \w+)?(?: only)?`;
// The row's edit state: "in editing mode", "in an editing box", "in the edit field".
const EDIT_BOX = String.raw`edit(?:ing)? (?:box|field)`;
const IN_EDITING = String.raw`in (?:an |the )?edit(?:ing)? (?:mode|box|field)`;
const SAVE_FAILED = String.raw`(?:did nothing|does nothing|did not (?:appear to )?(?:work|save|close|finish|respond|commit|leave|exit|do anything|register)|didn't (?:appear to )?(?:work|save|close|finish|respond|commit|leave|exit|do anything|register)|does not (?:work|save|respond|do anything)|doesn't (?:work|save|respond|do anything)|had no (?:visible )?effect|no effect|nothing happened|gave no (?:visible )?(?:response|feedback|confirmation)|was unresponsive|(?:left|kept) (?:the |my |its |their )?(?:task|row|item|edits?|drafts?|field|it|text box|textbox|${EDIT_BOX})(?: \w+)? (?:${IN_EDITING}|open|uncommitted|unsaved)|(?:stayed|remained) ${IN_EDITING}|(?:the |its )?${EDIT_BOX} (?:stayed|remained) open)`;
// A sentence about Enter or a page reload describes B1 or B10, so the broader D5 patterns skip it.
const NOT_ENTER = String.raw`^(?!.*\b(?:enter|refresh\w*|reload\w*)\b)`;
// A sentence about the selected filter or view coming back after a reload reports no lost task.
const NOT_VIEW_RESET = String.raw`^(?!.*\b(?:reset|switched|changed)\b(?: \w+){0,2} (?:filter|view)\b)`;
const STILL_SHOWED = String.raw`still (?:showed|shows|displayed|displays|had|has|read|reads|said|says|contained|contains)`;
const re = (source: string): RegExp => new RegExp(source);

export const PLANTED: readonly PlantedDefect[] = [
  {
    kind: "planted",
    id: "D1",
    label: "Clear completed does nothing",
    severity: "dead control",
    source: "bench/taskly-planted/app.js: the clear-done click handler is empty",
    truth: { planted: "true", clean: "false" },
    claim: [
      re(String.raw`\b${CC}\b[^.]{0,80}?\b${NO_EFFECT}`),
      re(String.raw`\bunresponsive\b[^.]{0,40}\b${CC}\b`),
      re(
        String.raw`\b${DONE} tasks? (?:stayed|remained|was still|were still|still (?:there|visible|showed))[^.]{0,60}\b${CC}\b`,
      ),
      re(String.raw`\b(?:stayed|remained|still visible|still there)\b[^.]{0,40}\b(?:after|despite)\b[^.]{0,30}\b${CC}\b`),
      re(String.raw`\b${DONE} (?:tasks?|rows?|items?) (?:stayed|remained)\b[^.]{0,20}\bafter\b[^.]{0,20}\b(?:clearing|bulk-clear|clear)(?: attempts?| clicks?)\b`),
    ],
    assurance: [
      re(String.raw`\b${CC}\b(?:,? which)? (?:removed|cleared|deleted|worked|got rid of)\b`),
      re(String.raw`\b(?:used|tidied up with|cleaned up with)\b[^.]{0,10}\b${CC}\b`),
      re(String.raw`\b${CC}\b[^.]{0,30}\b(?:worked|did what)\b`),
    ],
  },
  {
    kind: "planted",
    id: "D2",
    label: "Text over 30 characters is silently truncated on add",
    severity: "silent data loss",
    source: "bench/taskly-planted/app.js: the submit handler stores text.slice(0, 30)",
    truth: { planted: "true", clean: "typed-over-120" },
    claim: [re(String.raw`\b${TRUNCATED}\b`)],
    assurance: [
      re(String.raw`\b(?:long|longer) (?:task|text)\b[^.]{0,40}\b(?:wrapped|remained readable|was fully visible|showed in full)\b`),
      re(String.raw`\bwrapped (?:neatly|cleanly|onto|across|over)\b`),
    ],
  },
  {
    kind: "planted",
    id: "D3",
    label: "Active and Completed filters are swapped",
    severity: "mislabeled control",
    source: "bench/taskly-planted/app.js: visible() returns done tasks for active and open tasks for done",
    truth: { planted: "true", clean: "false" },
    claim: [
      re(
        String.raw`\b(?:filters?|active|completed)\b[^.]{0,80}\b(?:reversed|swapped|backwards?|opposite|inverted|the wrong way|mixed up|switched|flipped|contradict\w*)\b`,
      ),
      re(String.raw`\b(?:reversed|swapped|backwards?|opposite|inverted|switched|flipped)\b[^.]{0,40}\bfilters?\b`),
      re(String.raw`\bactive\b(?: filter| view| button| tab)?(?: then)? ${SHOWED}\b${AFTER_SHOWED} ${DONE}\b`),
      re(String.raw`(?<!clear[- ])\bcompleted\b(?: filter| view| button| tab)?(?: then)? ${SHOWED}\b${AFTER_SHOWED} ${OPEN}\b`),
    ],
    assurance: [
      re(String.raw`\bactive\b(?: filter| view| button| tab)?(?: then)? ${SHOWED}\b${AFTER_SHOWED} ${OPEN}\b`),
      re(String.raw`(?<!clear[- ])\bcompleted\b(?: filter| view| button| tab)?(?: then)? ${SHOWED}\b${AFTER_SHOWED} ${DONE}\b`),
      re(String.raw`\b(?:both filters|the filters|filtering)\b[^.]{0,80}\b(?:worked|did what)\b`),
    ],
  },
  {
    kind: "planted",
    id: "D4",
    label: "Empty list renders the literal text undefined",
    severity: "broken empty state",
    source: "bench/taskly-planted/app.js: render() prints String(window.emptyStateMessage)",
    truth: { planted: "true", clean: "false" },
    claim: [re(String.raw`\bundefined\b`)],
    // The clean build's empty-state copy. On the planted build it never appears.
    assurance: [re(String.raw`\b(?:nothing here yet|nothing matches this filter|add your first task)\b`)],
  },
  {
    kind: "planted",
    id: "D5",
    label: "Save in edit mode does nothing; only Enter commits",
    severity: "impossible step",
    source: "bench/taskly-planted/app.js: the Save click handler is empty; only Enter commits",
    truth: { planted: "true", clean: "false" },
    claim: [
      re(
        String.raw`\b(?:clicking|clicked|click|clicks|pressing|pressed|selecting|selected|tapping|hitting|the|repeated|unresponsive) save\b(?: button)?[^.]{0,60}?\b${SAVE_FAILED}`,
      ),
      re(String.raw`\bsave(?: button)?(?: in edit mode)? ${SAVE_FAILED}`),
      re(String.raw`\bsave (?:attempts?|clicks?)\b[^.]{0,40}\b(?:left|kept)\b`),
      re(String.raw`\bunresponsive save\b`),
      re(String.raw`\bwhether (?:the )?save had (?:worked|registered)\b`),
      // The row stayed in edit mode after Save: "saving the edit left the row in editing mode".
      re(String.raw`${NOT_ENTER}.*?\bsav(?:e|es|ed|ing)\b[^.]{0,60}\b(?:remain(?:s|ed)?|stay(?:s|ed)?|stuck|still|kept|keeps|left|leaves)\b(?: \w+){0,3} ${IN_EDITING}\b`),
      re(String.raw`${NOT_ENTER}.*?\b(?:remain(?:s|ed)?|stay(?:s|ed)?|stuck|still|kept|keeps|left|leaves)\b(?: \w+){0,3} ${IN_EDITING}\b[^.]{0,30}\bafter\b[^.]{0,30}\bsav(?:e|ed|ing)\b`),
      re(String.raw`${NOT_ENTER}.*?\bedit(?:ing)? mode remain(?:s|ed)? (?:active|open)\b[^.]{0,30}\bsav(?:e|ed|ing)\b`),
      re(String.raw`${NOT_ENTER}.*?\b${STILL_SHOWED}\b[^.]{0,40}\bsave\b[^.]{0,20}\bafter\b[^.]{0,40}\bsav(?:e|ed|ing)\b`),
      re(String.raw`${NOT_ENTER}.*?\bafter (?:saving|(?:a |the |another )?save (?:click|attempt))\b[^.]{0,60}\b${STILL_SHOWED}\b[^.]{0,40}\bsave\b`),
      re(String.raw`\bsave\b[^.]{0,30}\b(?:had not|hadn't|did not|didn't|never) (?:changed?|turned?|switched?|reverted?) back to edit\b`),
      re(String.raw`${NOT_ENTER}(?=.*\b(?:save (?:click|attempt)|after (?:the |a |another )?(?:\w+ )?save)\b).*?\b(?:input|field|editor)\b[^.]{0,20}\band (?:the )?save(?: button| control)? (?:remained|stayed|still present|still visible)\b`),
      re(String.raw`\bedit(?:ing)? (?:state|mode) did not (?:visibly )?end\b[^.]{0,30}\bsave\b`),
      re(String.raw`\bafter\b[^.]{0,20}\bsave\b[^.]{0,60}\bedit(?:ing)? (?:state|mode) remained\b`),
      re(String.raw`\bsave (?:did not|didn't|never) (?:visibly )?return (?:the |it |its )?(?:row|task|it)\b`),
      re(String.raw`\bstill (?:said|says|read|reads|showed|shows) save\b[^.]{0,10}\b(?:rather than|instead of)\b[^.]{0,20}\bedit\b`),
      // The edit was lost: "task rename reverted after two save attempts".
      re(String.raw`\b(?:edits?|edited|rename|renamed|title|name|wording)\b[^.]{0,40}\brevert(?:s|ed)?\b[^.]{0,30}\bsave (?:attempts?|clicks?)\b`),
      re(String.raw`\bsave (?:attempts?|clicks?)\b[^.]{0,20}\b(?:did not|didn't|failed to) (?:retain|keep|commit|save)\b`),
      re(String.raw`${NOT_ENTER}.*?\bedit(?:s|ed)?\b[^.]{0,30}\b(?:fail(?:s|ed)? to (?:save|commit|persist)|(?:are|were|was|is) not saved|(?:do|does|did) not (?:persist|save))\b`),
      re(String.raw`\bsave button failure\b`),
    ],
    assurance: [
      re(
        String.raw`\b(?:clicked|clicking|selecting|selected|using|used|pressed|click) save\b[^.]{0,40}\b(?:saved|worked|stuck|appeared|updated|changed|renamed)\b`,
      ),
      re(String.raw`\bsave\b[^.]{0,15}\b(?:worked|works)\b`),
      re(String.raw`\busing edit and save\b`),
      re(String.raw`\bedit and save\b[^.]{0,80}\b(?:worked|did what)\b`),
      re(String.raw`\bthe new name (?:appeared|stuck) after saving\b`),
    ],
  },
];

/** Behavior both builds share, or the clean build alone has, checked against the source. */
export const BASELINE: readonly BaselineClaim[] = [
  {
    kind: "baseline",
    id: "B1",
    label: "Enter does not save an edit; only Save does",
    source: "bench/taskly-clean/app.js: the edit field has no keydown handler",
    truth: { planted: "false", clean: "true" },
    claim: [
      re(String.raw`\benter\b[^.]{0,40}\b(?:does not|doesn't|did not|didn't|won't)\b[^.]{0,10}\b(?:save|commit|confirm|work)\b[^.]{0,30}\b(?:rename|edit)`),
      re(String.raw`\bpressed enter\b[^.]{0,80}\b(?:nothing happened|stayed in edit mode|stayed open|the row stayed)\b`),
      re(String.raw`\b(?:rename did not save on enter|enter failed on the rename)\b`),
      re(String.raw`\b(?:stayed open|stayed in edit mode)\b[^.]{0,40}\bhad to click save\b`),
      re(String.raw`\benter\b[^.]{0,30}\b(?:left|kept)\b[^.]{0,20}\bedit\w*\b[^.]{0,10}\bopen\b`),
      re(String.raw`\b(?:edit\w*|renam\w*)\b[^.]{0,40}\benter\b[^.]{0,20}\b(?:does not|doesn't|did not|didn't|won't)\b[^.]{0,10}\b(?:save|commit|confirm|work)\b`),
    ],
  },
  {
    kind: "baseline",
    id: "B2",
    label: "Clear completed stays visible and enabled with nothing to clear",
    source: "bench/taskly-*/index.html: the button is always rendered",
    truth: { planted: "true", clean: "true" },
    claim: [
      re(String.raw`\b${CC}\b[^.]{0,60}\b(?:remains?|remained|stays?|stayed|still|always)\b[^.]{0,30}\b(?:visible|enabled|available|usable|shown)\b`),
      re(String.raw`\b${CC}\b[^.]{0,80}\bno completed tasks\b`),
    ],
  },
  {
    kind: "baseline",
    id: "B3",
    label: "Delete and Clear completed act with no confirmation or undo",
    source: "bench/taskly-*/app.js: both handlers remove tasks at once",
    truth: { planted: "true", clean: "true" },
    claim: [
      re(String.raw`\b(?:no|without|never asks? for) (?:a |any )?(?:confirmation|undo)\b`),
      re(String.raw`\b(?:immediately|instantly)\b[^.]{0,40}\b(?:no|without) (?:confirmation|undo|warning)\b`),
      re(String.raw`\b(?:delete is immediate|acts? (?:immediately|instantly))\b`),
    ],
  },
  {
    kind: "baseline",
    id: "B4",
    label: "The left count is global under every filter",
    source: "bench/taskly-*/app.js: count uses all tasks, not the filtered view",
    truth: { planted: "true", clean: "true" },
    claim: [
      re(String.raw`\b(?:count|counter|left)\b[^.]{0,80}\b(?:global|total unfinished|overall|not specific to|regardless of the filter|initially looked)\b`),
      re(String.raw`\bcompleted (?:view|filter) said "?\d+ left\b`),
    ],
  },
  {
    kind: "baseline",
    id: "B5",
    label: "Edit does not focus its text box",
    source: "bench/taskly-*/app.js: render() never focuses the edit field",
    truth: { planted: "true", clean: "true" },
    claim: [
      re(String.raw`\bedit (?:doesn't|does not|didn't|did not) (?:put|place|move|give) (?:the )?(?:cursor|focus)\b`),
      re(String.raw`\bhad to click into the box\b`),
    ],
  },
  {
    kind: "baseline",
    id: "B6",
    label: "Edit mode has no Cancel",
    source: "bench/taskly-*/app.js: edit mode renders only Save",
    truth: { planted: "true", clean: "true" },
    claim: [re(String.raw`\bno (?:visible )?cancel\b`)],
  },
  {
    kind: "baseline",
    id: "B7",
    label: "The edit box is a single line",
    source: "bench/taskly-*/app.js: the edit field is an input element",
    truth: { planted: "true", clean: "true" },
    claim: [re(String.raw`\b(?:edit (?:box|field) is a single line|single[- ]line edit|cramped)\b`)],
  },
  {
    kind: "baseline",
    id: "B8",
    label: "The edit box keeps text the add box shortens",
    source: "bench/taskly-*/: neither edit path limits length",
    truth: { planted: "true", clean: "true" },
    claim: [
      re(String.raw`\blimit (?:only applies|is inconsistent)\b`),
      re(String.raw`\b(?:add box cuts text that the edit box accepts|save kept the whole sentence|kept all of it)\b`),
      re(String.raw`\bedit box (?:then )?accepted a \d+-character\b`),
    ],
  },
  {
    kind: "baseline",
    id: "B9",
    label: "The empty message does not name the active filter",
    source: "bench/taskly-clean/app.js: 'Nothing here yet' whenever no task exists",
    truth: { planted: "false", clean: "true" },
    claim: [re(String.raw`\b(?:filter-specific message|no active tasks)\b`)],
  },
  {
    kind: "baseline",
    id: "B10",
    label: "Tasks do not survive a page reload",
    source: "bench/taskly-{planted,clean}/app.js: tasks live in memory only; the -local builds store them",
    truth: { planted: "memory-storage", clean: "memory-storage" },
    claim: [
      re(String.raw`${NOT_VIEW_RESET}.*?\b(?:refresh\w*|reload\w*)\b[^.]{0,60}\b(?:erased?|lost|cleared|wiped|gone|disappeared|reset|emptied|empty|blank)\b`),
      re(String.raw`${NOT_VIEW_RESET}.*?\b(?:losing|lost|loses) (?:the|my|all) (?:list|tasks)\b[^.]{0,20}\b(?:on|after) (?:a )?(?:refresh|reload)\b`),
      re(String.raw`${NOT_VIEW_RESET}.*?\b(?:does not|doesn't|did not|didn't) (?:save|keep|persist|retain)\b[^.]{0,40}\b(?:refresh|reload|between visits)\b`),
      re(String.raw`${NOT_VIEW_RESET}.*?\b(?:absent|gone|lost|disappeared|erased|missing|wiped|cleared)\b[^.]{0,60}\b(?:after|on|following) (?:a |the )?(?:page )?(?:refresh|reload)`),
      re(String.raw`${NOT_VIEW_RESET}.*?\b(?:does not|doesn't|did not|didn't) survive\b[^.]{0,30}\b(?:refresh|reload)`),
    ],
  },
];

const RELOAD = String.raw`(?:refresh\w*|reload\w*)`;
const EDIT_SUBJECT = String.raw`(?:edit(?:s|ed)?|revision|rename|change|correction|added words|new wording|(?:shortened|edited|renamed|revised|changed|updated) \w+)`;
// Every task lost on reload, an edit among them, is B10's claim on any build.
const NOT_ALL_LOST = String.raw`^(?!.*\b(?:erased|wiped|emptied)\b)(?!.*\b(?:tasks|list|everything)\b(?: \w+){0,3} (?:were|was) (?:gone|lost|erased)\b)`;

/**
 * An edit that a reload took back: "Laundry edit did not persist after Save and refresh", "after
 * reloading, the added words were gone". On the -local builds a reload keeps every saved change, so
 * the scorer reads such a sentence as D5 and not as B10. On the memory builds a reload loses every
 * task, so the sentence stays with B10.
 */
export const LOST_EDIT_ON_RELOAD: readonly RegExp[] = [
  re(String.raw`${NOT_ALL_LOST}.*?\b${EDIT_SUBJECT}\b[^.]{0,40}\b(?:did not|didn't|does not|doesn't|never) (?:persist|survive|stick)\b[^.]{0,40}\b${RELOAD}\b`),
  re(String.raw`${NOT_ALL_LOST}.*?\b${EDIT_SUBJECT}\b[^.]{0,40}\b(?:(?:was|were) (?:absent|gone|lost|undone)|disappeared|reverted)\b[^.]{0,30}\b${RELOAD}\b`),
  re(String.raw`\b(?:after|on|following) (?:a |the )?(?:page )?${RELOAD}\b,? (?:the |my )?(?:change|edit|added words|new wording|correction|rename)s? (?:was|were) (?:gone|lost|undone|missing)\b`),
  re(String.raw`^(?=.*\b${RELOAD}\b).*\b(?:old|original|earlier|prior|previous) (?:wording|text|name|title|value)\b[^.]{0,20}\b(?:returned|came back|reappeared)\b`),
  re(String.raw`\b${RELOAD}\b[^.]{0,10}\b(?:it|the (?:task|row|item|edit)) (?:was|went) back to\b(?! (?:an? |its |the )?(?:empty|blank|nothing|zero))`),
];

/** Claims that a working control is broken. Each is false on the build it names. */
export const CONTRADICTED: readonly ContradictedClaim[] = [
  {
    kind: "contradiction",
    id: "X1",
    label: "Delete does not remove a task",
    source: "bench/taskly-*/app.js: Delete filters the task out",
    truth: { planted: "false", clean: "false" },
    claim: [
      re(String.raw`\bdelete\b(?: button)?[^.]{0,30}\b(?:did nothing|does nothing|did not (?:work|remove)|didn't (?:work|remove)|does not (?:work|remove)|doesn't (?:work|remove)|had no effect)\b`),
    ],
  },
  {
    kind: "contradiction",
    id: "X2",
    label: "Adding a task does not work",
    source: "bench/taskly-*/app.js: submit pushes the task",
    truth: { planted: "false", clean: "false" },
    claim: [
      re(String.raw`\b(?:add button|adding (?:a )?tasks?)\b[^.]{0,30}\b(?:did nothing|did not work|didn't work|failed|had no effect)\b`),
      re(String.raw`\b(?:could not|couldn't|unable to) add\b`),
    ],
  },
  {
    kind: "contradiction",
    id: "X3",
    label: "The checkbox does not mark a task complete",
    source: "bench/taskly-*/app.js: change sets task.done",
    truth: { planted: "false", clean: "false" },
    claim: [
      re(String.raw`\b(?:checkbox|check box|ticking|checking)\b[^.]{0,30}\b(?:did nothing|did not (?:work|mark|strike)|didn't (?:work|mark|strike)|had no effect)\b`),
    ],
  },
  {
    kind: "contradiction",
    id: "X4",
    label: "Edit does not open edit mode",
    source: "bench/taskly-*/app.js: Edit sets task.editing",
    truth: { planted: "false", clean: "false" },
    claim: [
      re(
        String.raw`\b(?:clicking|clicked|pressing|pressed|the) edit\b(?! mode)(?: button)?[^.]{0,20}\b(?:did nothing|does nothing|did not open|didn't open|had no effect)\b`,
      ),
    ],
  },
];

const PROBLEM_NEARBY = String.raw`[^.]{0,60}\b(?:stuck|broken|wrong|did not|didn't|could not|couldn't|unable|missing|odd|confus\w*)\b`;

/** Claims the harness, the persona prompt or the mission produced, attributed only with evidence. */
export const HARNESS: readonly HarnessClaim[] = [
  {
    kind: "harness",
    id: "H1",
    label: "The app was slow or froze",
    claim: [re(String.raw`\b(?:slow|lag(?:ged|gy)?|froze|frozen|hung|took a long time|loading forever)\b`)],
    evidence: (facts) => facts.providerStall,
    evidenceLabel: "a provider stall or retry notice in the trace",
  },
  {
    kind: "harness",
    id: "H2",
    label: "Clicks or keystrokes did not register",
    claim: [
      re(String.raw`\b(?:clicks?|keystrokes?|typing|key ?press(?:es)?)\b[^.]{0,40}\b(?:did not|didn't|never) (?:register|land|take effect|arrive)\b`),
      re(String.raw`\bfocus (?:was )?(?:stuck|trapped) in the (?:browser|address|url|tool)`),
    ],
    evidence: (facts) => facts.failedAction,
    evidenceLabel: "a desktop action in the trace that did not complete",
  },
  {
    kind: "harness",
    id: "H3",
    label: "A problem with the browser or desktop around the app",
    claim: [re(String.raw`\b(?:address bar|url bar|browser (?:toolbar|chrome|window|tab)|tab bar|desktop|screen resolution|window size)\b${PROBLEM_NEARBY}`)],
    evidence: () => true,
    evidenceLabel: "the browser and desktop are provisioned by the harness",
  },
  {
    kind: "harness",
    id: "H4",
    label: "A terminal mentioned in a web study",
    claim: [re(String.raw`\bterminal\b`)],
    evidence: (facts) => facts.personaTraits.includes("accessibility:clear_terminal_output"),
    evidenceLabel: "the persona's clear_terminal_output trait in the trace",
  },
  {
    kind: "harness",
    id: "H5",
    label: "Unsure what the mission's tidy-up step meant",
    claim: [re(String.raw`\bwhether "?tidy up"? meant\b`)],
    evidence: (facts) => /\btidy up\b/i.test(facts.mission),
    evidenceLabel: "the mission asks the participant to tidy up",
  },
];

export const CLAIM_CLASSES: readonly ClaimClass[] = [...PLANTED, ...BASELINE, ...CONTRADICTED, ...HARNESS];

/**
 * Language that marks a paragraph as reporting a problem. A problem paragraph that matches no claim
 * class is unresolved: listed for a person to check, never counted as invented.
 */
export const PROBLEM_LANGUAGE =
  /\b(?:did nothing|does nothing|didn't|did not|doesn't|does not|couldn't|could not|can't|cannot|unable|no (?:way|warning|message|feedback)|confus\w*|unexpected\w*|unclear|odd|oddly|strange|wrong|broken|bug|error|inconsistent\w*|reversed|swapped|missing|lost|cut off|truncat\w*|hesitat\w*|surpris\w*)\b/;

/** Reassurance that reads as problem language: "no issues blocked me", "without errors". */
export const REASSURANCE =
  /\b(?:no|without|never|nothing|not)\b[^.,;]*?\b(?:issues?|errors?|blockers?|problems?|confus\w*|hesitation)\b[^.,;]*/g;

/**
 * What a D2 truncation word must be about: the paragraph names the text. Participants call a task
 * an errand or a reminder when the mission's list is errands and chores.
 */
export const D2_SUBJECT =
  /\b(?:tasks?|text|entr(?:y|ies)|description|labels?|sentences?|title|characters?|words?|notes?|names?|errands?|reminders?)\b/;

/**
 * A day name cut short, as the 30-character limit leaves it, in a sentence about where the text
 * ends: "ended at Thursd", "became ... Wednes", "Tuesda rather than the full Tuesday". It names the
 * shortened text itself, so it needs no D2_SUBJECT. Full names and the usual abbreviations (Wed,
 * Thu, Thurs, Tues) do not match. Analysis observations quote the row's text ("an edit field
 * reading ... on Wednes") without reporting the cut, so the day name alone is not enough.
 */
export const CUT_DAY_NAME =
  /^(?=.*\b(?:end(?:s|ed|ing)?|stopped|cut|became|only|missing|(?:rather than|instead of) the full)\b).*\b(?:monda|tuesd|tuesda|wedne|wednes|wednesd|wednesda|thursd|thursda|frida|satur|saturd|saturda|sunda)\b/;

/** Negated truncation: "wrapped without being cut off". Stripped before the D2 pattern runs. */
export const NEGATED_TRUNCATION =
  /\b(?:without|not|never|no|wasn't|weren't|isn't)\s+(?:being\s+|getting\s+|any\s+)?(?:cut off|truncated|clipped|chopped|shortened)\b/g;

/** How a D2 report describes the mechanism. Strong data-loss language wins over display language. */
export const D2_MECHANISM = {
  strongLoss: [
    /\bonly the first \d+ characters were kept\b/,
    /\b(?:rest|remainder)(?: of (?:it|the text|the task|the description))? (?:was|is|had been) (?:thrown away|gone|lost|dropped|discarded)\b/,
    /\bconfirmed (?:it was lost|the rest was gone|only)\b/,
    /\bheld (?:just|only) (?:those|the first)\b/,
    /\bnot just hidden\b/,
    /\bactually lost\b/,
    /\blosing the rest\b/,
    /\bsilently (?:shortened|cut down|truncated)\b/,
    /\bsaved task (?:ends|stopped)\b/,
    /\bwent into the list\b/,
    /\b(?:text|description|characters) (?:was|were|got|had been) (?:dropped|lost|discarded)\b/,
  ],
  weakLoss: [
    /\blost\b/,
    /\bloss\b/,
    /\bshortening of the underlying\b/,
    /\bunderlying (?:task )?(?:value|text)\b/,
    /\b(?:alteration|shortening|truncation|change) of the (?:entered|stored|saved) (?:task )?(?:value|text)\b/,
    /\bstored\b/,
  ],
  display: [
    /\bvisually\b/,
    /\bvisibly\b/,
    /\b(?:instead of|rather than|without|did not|didn't|not) (?:wrapping|wrap)\b/,
    /\bellipsis\b/,
    /\bclipp(?:ed|ing)\b/,
    /\bdisplay (?:clipping|cut-off|cut off)\b/,
    /\bon screen\b/,
    /\breadab\w*\b/,
  ],
  negatedLoss: /\b(?:not|no|without) (?:text |data )?loss\b/g,
} as const;

/** Mentions that show the participant used a defect's control at all, from the report or narration. */
export const ENGAGEMENT: Record<DefectId, RegExp | "typed-over-30" | "always"> = {
  D1: /\bclear[- ]completed\b/,
  D2: "typed-over-30",
  D3: /\bfilter|\b(?:clicked|tried|pressed|selected|used|opened) (?:the )?(?:active|completed)\b/,
  D4: "always",
  D5: /\b(?:edit|edited|editing|rename|renamed|renaming)\b/,
};
