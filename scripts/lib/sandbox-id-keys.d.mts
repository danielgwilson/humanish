export declare const SANDBOX_ID_MARKER: "[redacted-sandbox-id]";
export interface SandboxIdValue {
  key: "sandboxId" | "subjectSandboxId" | "providerResources[].id";
  value: string;
  index: number;
}
export declare function sandboxIdValues(text: string, allowed?: Set<string>): SandboxIdValue[];
export declare function sandboxIdFindings(file: string, text: string): SandboxIdValue[];
