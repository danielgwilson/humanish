// The scripted-browser actor's types: the structural seams that playwright's Browser and Page satisfy
// (tests inject fakes behind them and still run the real step executor), the evidence URL policy,
// and the journey and capture types the parser, step executor and session share.

export interface ScriptedLocatorLike {
  first(): ScriptedLocatorLike;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  click(options?: { timeout?: number }): Promise<void>;
  count(): Promise<number>;
  waitFor(options?: { state?: "visible"; timeout?: number }): Promise<void>;
  isVisible(options?: { timeout?: number }): Promise<boolean>;
}

export interface ScriptedPageLike {
  goto(
    url: string,
    options?: { waitUntil?: "domcontentloaded"; timeout?: number },
  ): Promise<unknown>;
  locator(selector: string): ScriptedLocatorLike;
  waitForTimeout(ms: number): Promise<void>;
  waitForFunction(fn: string, arg: unknown, options?: { timeout?: number }): Promise<unknown>;
  screenshot(options: { path: string; fullPage: boolean }): Promise<unknown>;
  url(): string;
  evaluate<T>(pageFunction: string): Promise<T>;
}

export interface ScriptedBrowserLike {
  newContext(options: {
    deviceScaleFactor: number;
    isMobile: boolean;
    viewport: { width: number; height: number };
  }): Promise<{ newPage(): Promise<ScriptedPageLike> }>;
  close(): Promise<void>;
}

export interface ScriptedBrowserLaunchArgs {
  browserCommand: string;
  timeoutMs: number;
}

export type ScriptedBrowserEvidenceUrlPolicy =
  | { kind: "loopback" }
  | { kind: "provisioned-subject"; evidenceOrigin: string };

export const LOOPBACK_EVIDENCE_URL_POLICY: ScriptedBrowserEvidenceUrlPolicy = { kind: "loopback" };

export interface BrowserSurface {
  id: "desktop" | "mobile";
  label: string;
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    isMobile: boolean;
  };
}

export interface BrowserSurfaceCapture {
  capturedAt: string;
  durationMs: number;
  httpStatus?: number;
  ok: boolean;
  reason: string;
  /**
   * Surface-level screenshot the producer wrote (the last step's screenshot).
   * Omitted for a blocked capture whose evidence is the failure itself, so the
   * stream never claims a screenshot embed/ui reference that does not exist.
   * verifyRun fails closed on a referenced local artifact that is missing or empty.
   */
  screenshotPath?: string;
  steps: BrowserPersonaStepCapture[];
  surface: BrowserSurface;
  tracePath: string;
}

export type BrowserPersonaAction =
  | "goto"
  | "click"
  | "fill"
  | "assertText"
  | "waitForText"
  | "waitForSelector";

export interface BrowserPersonaAssertionCapture {
  id: string;
  reason: string;
  status: "passed" | "blocked";
}

export interface BrowserPersonaStepCapture {
  action: string;
  assertions?: BrowserPersonaAssertionCapture[];
  completedAt: string;
  durationMs: number;
  id: string;
  label: string;
  reason: string;
  /**
   * Path to the step screenshot the producer actually wrote. Omitted for blocked
   * steps where the failure itself is the recorded evidence and no screenshot was
   * written — the bundle must not reference an artifact that does not exist. A step that
   * ran and attempted a screenshot keeps this even when its assertions failed, so a broken
   * producer still fails verify.
   */
  screenshotPath?: string;
  status: "passed" | "blocked";
  url: string;
}

export interface BrowserPersonaStepExpectation {
  selectorVisible?: string;
  stateChanged?: boolean;
  text?: string;
  urlIncludes?: string;
}

export interface BrowserPersonaStepManifest {
  action: BrowserPersonaAction;
  expectation?: BrowserPersonaStepExpectation;
  id: string;
  label: string;
  path?: string;
  selector?: string;
  value?: string;
}

export interface BrowserPersonaJourney {
  goal: string;
  scenarioId: string;
  scenarioTitle: string;
  source: string;
  sourceDigest: string;
  startPath: string;
  steps: BrowserPersonaStepManifest[];
}

export const browserSurfaces: BrowserSurface[] = [
  {
    id: "desktop",
    label: "Desktop browser surface",
    viewport: {
      width: 1440,
      height: 960,
      deviceScaleFactor: 1,
      isMobile: false,
    },
  },
  {
    id: "mobile",
    label: "Mobile browser surface",
    viewport: {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      isMobile: true,
    },
  },
];
