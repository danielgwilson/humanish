import type { LocalRuntimeRelease } from "./runtime.js";

/** Updated with the verified, public runtime artifact before release. */
const LOCAL_RUNTIME_RELEASE: LocalRuntimeRelease = {
  url: "https://github.com/danielgwilson/humanish/releases/download/runtime-2026.10.21.3/runtime-linux-amd64.tar.gz",
  sha256: "6fc19792e9b8f414165a73470526cc414c98d0ad368210c5e95daf29469b8dbd",
  bytes: 597049520,
  image: "sha256:4672388737bd7d136910fca6f8b6d99e09fbe96c13e1b100491c05444e7d267a",
};

/** Architecture-specific artifacts; each retains matching sources and notices. */
export const LOCAL_RUNTIME_RELEASES: Partial<Record<"amd64" | "arm64", LocalRuntimeRelease>> = {
  amd64: LOCAL_RUNTIME_RELEASE,
  arm64: {
    url: "https://github.com/danielgwilson/humanish/releases/download/runtime-2026.10.21.4/runtime-linux-arm64.tar.gz",
    sha256: "d590de49a86eabe1cd09d7556aa75b2ebd62bc2c88fe37122e2af315c478c901",
    bytes: 583551803,
    image: "sha256:4606122520504f7f587f52b872165e6ab900be0ba3eca933b2f6dd3b9dcde723",
  },
};

/** Media assets are separate so ordinary browser studies keep the smaller download. */
export const LOCAL_MEDIA_RUNTIME_RELEASES: Partial<Record<"amd64" | "arm64", LocalRuntimeRelease>> =
  {
    amd64: {
      url: "https://github.com/danielgwilson/humanish/releases/download/runtime-2026.09.28.7/runtime-linux-amd64.tar.gz",
      sha256: "f4758b39cb26c819c7f952eb329d5096fcfe9f05f7381bd37d205b2f6e51826c",
      bytes: 846986597,
      image: "sha256:91b132c72cdcb750fba3b48ee78ea8087c794d515d970a273b6f5ee22d443b9f",
    },
    arm64: {
      url: "https://github.com/danielgwilson/humanish/releases/download/runtime-2026.09.28.8/runtime-linux-arm64.tar.gz",
      sha256: "77f65fd945b582067cfde7740c26f4c06c2727afffcb0025720652c168377a01",
      bytes: 828200616,
      image: "sha256:68dd2c00f713bd8be03e209011531bbd4da5b840819cd2de203c11ece29aa255",
    },
  };
