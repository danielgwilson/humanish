import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { Template, defaultBuildLogger } from "@e2b/desktop";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const worker = "dist/guest-media-worker.js";
const name = process.argv[2] ?? "humanish-browser-media";
const mediaInputs = JSON.parse(await readFile(new URL("./inputs.json", import.meta.url), "utf8"));

function quote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function download(input, destination) {
  if (typeof input?.url !== "string" || !/^[a-f0-9]{64}$/.test(input?.sha256 ?? "")) {
    throw new Error("Media template input is missing a fixed URL or SHA-256 digest.");
  }
  return [
    `curl --fail --location --silent --show-error --retry 3 --output ${quote(destination)} ${quote(input.url)}`,
    `printf '%s  %s\\n' ${quote(input.sha256)} ${quote(destination)} | sha256sum --check --strict -`
  ];
}

const node = {
  url: "https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz",
  sha256: "69b09dba5c8dcb05c4e4273a4340db1005abeafe3927efda2bc5b249e80437ec"
};
const whisperSource = mediaInputs.files?.["whisper.cpp-927cfce34f31707e17f2bff35c349632fb9e2c3a.tar.gz"];
const whisperModel = mediaInputs.files?.["ggml-base.en.bin"];
const whisperModelCard = mediaInputs.files?.["whisper-model-README.md"];

if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
  throw new Error("Template name must contain lowercase letters, numbers, dashes, or underscores.");
}
await access(new URL(`../../${worker}`, import.meta.url), constants.R_OK);

const template = Template({ fileContextPath: repositoryRoot })
  .fromTemplate("desktop")
  .aptInstall([
    "build-essential", "ca-certificates", "cmake", "curl", "espeak-ng", "ffmpeg",
    "pulseaudio", "pulseaudio-utils", "xz-utils"
  ], { noInstallRecommends: true })
  .copy(worker, "/opt/humanish/media/guest-media-worker.js", { mode: 0o444 })
  .runCmd([
    "install -d -m 0755 /opt/humanish/build /opt/humanish/media",
    ...download(node, "/opt/humanish/build/node.tar.xz"),
    ...download(whisperSource, "/opt/humanish/build/whisper.tar.gz"),
    ...download(whisperModel, "/opt/humanish/media/ggml-base.en.bin"),
    ...download(whisperModelCard, "/opt/humanish/media/README.whisper-model.md"),
    "tar -xJf /opt/humanish/build/node.tar.xz --strip-components=1 -C /usr/local",
    "node --version | grep -Fx v22.14.0",
    "install -m 0444 /usr/local/LICENSE /opt/humanish/media/LICENSE.nodejs",
    "install -d -m 0755 /opt/humanish/build/whisper",
    "tar -xzf /opt/humanish/build/whisper.tar.gz --strip-components=1 -C /opt/humanish/build/whisper",
    "cmake -S /opt/humanish/build/whisper -B /opt/humanish/build/whisper/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DWHISPER_BUILD_TESTS=OFF",
    "cmake --build /opt/humanish/build/whisper/build --target whisper-server --parallel 4",
    "install -m 0555 /opt/humanish/build/whisper/build/bin/whisper-server /opt/humanish/media/whisper-server",
    "install -m 0444 /opt/humanish/build/whisper/LICENSE /opt/humanish/media/LICENSE.whisper.cpp",
    "printf '{\"type\":\"module\"}\\n' > /opt/humanish/media/package.json",
    "find /opt/humanish/media -type d -exec chmod 0555 {} +",
    "find /opt/humanish/media -type f -exec chmod 0444 {} +",
    "chmod 0555 /opt/humanish/media/whisper-server",
    "rm -rf /opt/humanish/build /var/lib/apt/lists/* /var/cache/apt/archives/*"
  ], { user: "root" });

const result = await Template.build(template, name, {
  cpuCount: 4,
  memoryMB: 4096,
  minFreeDiskMb: 1024,
  onBuildLogs: defaultBuildLogger()
});
console.log(JSON.stringify({ name: result.name, templateId: result.templateId, buildId: result.buildId }));
