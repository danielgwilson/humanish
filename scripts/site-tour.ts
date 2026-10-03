#!/usr/bin/env -S node --import tsx
// Publishes one kept run bundle as a site tour: site/lib/tour/<slug>.json for the replay player,
// and a trimmed copy of the bundle under site/public/runs/<slug>/ for its Observer link.
//
//   pnpm site:tour --project <dir> --run <runId> --slug try-live
//
// The project is the directory the run was made in; verify runs there with the humanish it has
// installed, so the published grade is the one that package gives. Screenshots become JPEG
// copies, provider resource ids are redacted, and site/public/runs/ASSETS.sha256.json is
// regenerated. Review every published frame and run `pnpm public-surface:scan` before committing.

import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { buildTour, publishedCapturePath, type TourVerifyInput } from "./lib/site-tour.js";

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    run: { type: "string" },
    slug: { type: "string" },
  },
});
if (!values.project || !values.run || !values.slug || !/^[a-z0-9-]+$/.test(values.slug)) {
  throw new Error("usage: pnpm site:tour --project <dir> --run <runId> --slug <lowercase-slug>");
}
const project = path.resolve(values.project);
const runId = values.run;
const slug = values.slug;
const bundleDir = path.join(project, ".humanish", "runs", runId);
const siteRun = path.resolve("site/public/runs", slug);
const tourFile = path.resolve("site/lib/tour", `${slug}.json`);

const readJson = async <T>(file: string): Promise<T> =>
  JSON.parse(await readFile(path.join(bundleDir, file), "utf8")) as T;

const verify = JSON.parse(
  // The project's own installed humanish, so the grade is the one the package that made the run gives.
  execFileSync(
    path.join(project, "node_modules", ".bin", "humanish"),
    ["verify", "--run", runId, "--json"],
    {
      cwd: project,
      encoding: "utf8",
      env: { ...process.env, DO_NOT_TRACK: "1" },
    },
  ),
) as TourVerifyInput;
if (verify.shareSafety.status === "blocked") {
  throw new Error(`verify blocks ${runId}: ${JSON.stringify(verify.shareSafety.reasons)}`);
}

const bundle = await readJson<Parameters<typeof buildTour>[0]["bundle"]>("run.json");
const analysis = await readJson<Parameters<typeof buildTour>[0]["analysis"]>(
  "observer/study-analysis.json",
);
const captures = (await readdir(path.join(bundleDir, "screenshots")))
  .filter((name) => name.endsWith(".png"))
  .sort((left, right) => left.localeCompare(right));
const first = await readFile(path.join(bundleDir, "screenshots", captures[0]!));
const frameSize = { w: first.readUInt32BE(16), h: first.readUInt32BE(20) };

const tour = buildTour({ bundle, analysis, verify, frameSize });

/** Published text: captures at their JPEG paths. */
const jpegPaths = (text: string): string =>
  text.replace(/screenshots\/([\w.-]+)\.png/g, (_match, name: string) =>
    publishedCapturePath(`screenshots/${name}.png`),
  );

// The run's provider resources are its E2B sandboxes; their ids are private and are redacted.
const runJson = JSON.parse(await readFile(path.join(bundleDir, "run.json"), "utf8")) as {
  providerResources?: Array<{ id?: string }>;
};
for (const resource of runJson.providerResources ?? []) resource.id = "[redacted-sandbox-id]";

await rm(siteRun, { recursive: true, force: true });
await mkdir(path.join(siteRun, "observer"), { recursive: true });
await mkdir(path.join(siteRun, "screenshots"), { recursive: true });
await writeFile(path.join(siteRun, "run.json"), jpegPaths(`${JSON.stringify(runJson, null, 2)}\n`));
const textFiles = [
  "review.json",
  "review.md",
  "observer/index.html",
  "observer/observer-data.json",
  "observer/study-analysis.json",
];
for (const file of textFiles) {
  await writeFile(
    path.join(siteRun, file),
    jpegPaths(await readFile(path.join(bundleDir, file), "utf8")),
  );
}

// No sandbox id the run's own receipts name may reach a published file.
const receipts = await readFile(path.join(bundleDir, "sandbox-receipts.ndjson"), "utf8").catch(
  () => "",
);
const sandboxIds = [...receipts.matchAll(/"sandboxId"\s*:\s*"([^"]+)"/g)].map((match) => match[1]!);
for (const file of ["run.json", ...textFiles]) {
  const text = await readFile(path.join(siteRun, file), "utf8");
  if (sandboxIds.some((id) => text.includes(id)))
    throw new Error(`site/public/runs/${slug}/${file} still names a sandbox of this run`);
}

// JPEG copies at the captures' own size, rendered by the same Chromium the proofs use.
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: frameSize.w, height: frameSize.h } });
  for (const name of captures) {
    const png = await readFile(path.join(bundleDir, "screenshots", name));
    await page.setContent(
      `<body style="margin:0"><img style="display:block" src="data:image/png;base64,${png.toString("base64")}"></body>`,
    );
    const jpeg = await page.screenshot({ type: "jpeg", quality: 85 });
    await writeFile(path.join(siteRun, publishedCapturePath(`screenshots/${name}`)), jpeg);
  }
} finally {
  await browser.close();
}
const lastFrame = tour.lanes[0]!.frames.at(-1)!.file;
await writeFile(path.join(siteRun, "poster.jpg"), await readFile(path.join(siteRun, lastFrame)));

await mkdir(path.dirname(tourFile), { recursive: true });
await writeFile(tourFile, `${JSON.stringify(tour, null, 2)}\n`);
// The manifest's note names the run each published capture came from.
const manifestFile = path.resolve("site/public/runs/ASSETS.sha256.json");
const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as { note: string };
manifest.note = manifest.note.replace(new RegExp(`(${slug}: )\\S+`), `$1${runId}`);
await writeFile(manifestFile, `${JSON.stringify(manifest, null, 1)}\n`);
execFileSync("node", ["scripts/site-run-assets-manifest.mjs"], { stdio: "inherit" });

process.stdout.write(
  `${slug}: ${tour.lanes[0]!.frames.length} frames from ${runId} · verify ${tour.verify?.status} · ${tour.facts?.cost}\n` +
    `Review site/public/runs/${slug}/ frame by frame, then run pnpm public-surface:scan.\n`,
);
