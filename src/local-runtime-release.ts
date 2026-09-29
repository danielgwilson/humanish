import type { LocalRuntimeRelease } from "./local-runtime.js";

/** Updated with the verified, public runtime artifact before release. */
const LOCAL_RUNTIME_RELEASE: LocalRuntimeRelease = {
  url: "https://github.com/danielgwilson/humanish/releases/download/runtime-2026.09.28.1/runtime-linux-amd64.tar.gz",
  sha256: "224be52467d6a808c79f156c6537d8a34c2dfb7b71daa836d34c8611fbbb6647",
  bytes: 596142100,
  image: "sha256:89cec77ea8097d32f3ef14bf2bdb0a93ffd25c3975913f8c5ffc6a2f360482a2",
};

/** Architecture-specific artifacts; each retains matching sources and notices. */
export const LOCAL_RUNTIME_RELEASES: Partial<Record<"amd64" | "arm64", LocalRuntimeRelease>> = {
  amd64: LOCAL_RUNTIME_RELEASE,
  arm64: {
    url: "https://github.com/danielgwilson/humanish/releases/download/runtime-2026.09.28.2/runtime-linux-arm64.tar.gz",
    sha256: "d03e1b6335bea76a22bf88ca9aa8dc1f4fe0af16fba02c654a333766e27cd2ea",
    bytes: 582661785,
    image: "sha256:c3d584d9586d2e86833ee8d050c43774d456c6c4f8f3c9a53194bd90910fa938",
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
