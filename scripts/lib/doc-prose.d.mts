export const ROOT_GUIDES: readonly string[];
export function docRootOf(path: string): "docs" | "site" | "evidence" | undefined;
export function isDocCapsEmphasis(run: string): boolean;
export const CONTRAST: RegExp;
export const DOC_WORD_KINDS: Readonly<Record<string, RegExp>>;
export function docProse(text: string): string;
export const CAPS_RUN: RegExp;
