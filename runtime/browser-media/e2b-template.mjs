import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { Template, defaultBuildLogger } from "@e2b/desktop";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const worker = "dist/guest-media-worker.js";
const name = process.argv[2] ?? "humanish-browser-media";

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
    "curl --fail --location --silent --show-error --retry 3 --output /opt/humanish/build/node.tar.xz https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz",
    "printf '%s  %s\\n' 69b09dba5c8dcb05c4e4273a4340db1005abeafe3927efda2bc5b249e80437ec /opt/humanish/build/node.tar.xz | sha256sum --check --strict -",
    "curl --fail --location --silent --show-error --retry 3 --output /opt/humanish/build/whisper.tar.gz https://github.com/ggml-org/whisper.cpp/archive/927cfce34f31707e17f2bff35c349632fb9e2c3a.tar.gz",
    "printf '%s  %s\\n' 41b664fee09e79176ac277b5237debec34f8d74af3c7d71f333f1ec67989ecde /opt/humanish/build/whisper.tar.gz | sha256sum --check --strict -",
    "curl --fail --location --silent --show-error --retry 3 --output /opt/humanish/media/ggml-tiny.en.bin 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1f/ggml-tiny.en.bin?download=true'",
    "printf '%s  %s\\n' 921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f /opt/humanish/media/ggml-tiny.en.bin | sha256sum --check --strict -",
    "curl --fail --location --silent --show-error --retry 3 --output /opt/humanish/media/README.whisper-model.md 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1f/README.md?download=true'",
    "printf '%s  %s\\n' 21fd967098804f33fc84e803fb0e5ab7666d71801f4027cf28a65e7af09c1758 /opt/humanish/media/README.whisper-model.md | sha256sum --check --strict -",
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
