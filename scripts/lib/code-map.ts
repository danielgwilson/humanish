/**
 * Architecture.md's code map is the table under "Find the code for each part of the system". Every
 * directory directly under src/, and every folder under src/routes/, needs a row, and every row
 * that names a directory must name one that exists. Directories only: files are not listed.
 */
const SECTION = "## Find the code for each part of the system";

/** The directories the code map's first column names, such as `src/cli/` or `observer/`. */
export function codeMapFolders(architecture: string): string[] {
  const start = architecture.indexOf(SECTION);
  if (start < 0) return [];
  const rest = architecture.slice(start + SECTION.length);
  const end = rest.search(/\n## /);
  const section = end < 0 ? rest : rest.slice(0, end);
  const folders: string[] = [];
  for (const line of section.split("\n")) {
    const cell = /^\|\s*`([^`*]+\/)`\s*\|/.exec(line);
    if (cell) folders.push(cell[1]!);
  }
  return folders;
}

/** src/<dir>/ and src/routes/<route>/ for every directory that holds a file. */
export function requiredFolders(files: readonly string[]): string[] {
  const folders = new Set<string>();
  for (const file of files) {
    const parts = file.split("/");
    if (parts[0] !== "src" || parts.length < 3) continue;
    folders.add(`src/${parts[1]}/`);
    if (parts[1] === "routes" && parts.length >= 4) folders.add(`src/routes/${parts[2]}/`);
  }
  return [...folders].sort();
}

export function findCodeMapIssues(architecture: string, files: readonly string[]): string[] {
  const listed = codeMapFolders(architecture);
  if (listed.length === 0) return [`ARCHITECTURE.md has no code map under "${SECTION}"`];
  const existing = new Set(
    files.flatMap((file) =>
      file
        .split("/")
        .slice(0, -1)
        .map((_part, index, parts) => `${parts.slice(0, index + 1).join("/")}/`),
    ),
  );
  const rows = new Set(listed);
  return [
    ...requiredFolders(files)
      .filter((folder) => !rows.has(folder))
      .map((folder) => `${folder} has no row in ARCHITECTURE.md's code map`),
    ...listed
      .filter((folder) => !existing.has(folder))
      .map((folder) => `ARCHITECTURE.md's code map lists ${folder}, which does not exist`),
  ];
}
