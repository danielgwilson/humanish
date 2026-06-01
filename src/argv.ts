export function normalizeCliArgv(argv: string[]): string[] {
  const [runtime, entrypoint, separator, ...rest] = argv;

  if (runtime && entrypoint && separator === "--") {
    return [runtime, entrypoint, ...rest];
  }

  return argv;
}
