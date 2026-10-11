export declare function bounded<T>(step: string, wait: Promise<T>, ms?: number): Promise<T>;
export declare function closeWhenOverdue(
  context: { close(): Promise<unknown> },
  label: string,
  ms: number,
): () => void;
