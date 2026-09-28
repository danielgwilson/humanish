import type { LocalRuntimeRelease } from "./local-runtime.js";

/** Updated with the verified, public runtime artifact before release. */
export const LOCAL_RUNTIME_RELEASE: LocalRuntimeRelease = {
  url: "https://github.com/danielgwilson/humanish/releases/download/runtime-2026.09.28.1/runtime-linux-amd64.tar.gz",
  sha256: "224be52467d6a808c79f156c6537d8a34c2dfb7b71daa836d34c8611fbbb6647",
  bytes: 596142100,
  image: "sha256:89cec77ea8097d32f3ef14bf2bdb0a93ffd25c3975913f8c5ffc6a2f360482a2"
};

/** Architecture-specific artifacts; each retains matching sources and notices. */
export const LOCAL_RUNTIME_RELEASES: Partial<Record<"amd64" | "arm64", LocalRuntimeRelease>> = {
  amd64: LOCAL_RUNTIME_RELEASE,
  arm64: {
    url: "https://github.com/danielgwilson/humanish/releases/download/runtime-2026.09.28.2/runtime-linux-arm64.tar.gz",
    sha256: "d03e1b6335bea76a22bf88ca9aa8dc1f4fe0af16fba02c654a333766e27cd2ea",
    bytes: 582661785,
    image: "sha256:c3d584d9586d2e86833ee8d050c43774d456c6c4f8f3c9a53194bd90910fa938"
  }
};

/** Media assets are separate so ordinary browser studies keep the smaller download. */
export const LOCAL_MEDIA_RUNTIME_RELEASES: Partial<Record<"amd64" | "arm64", LocalRuntimeRelease>> = {
  amd64: {
    url: "https://github.com/danielgwilson/humanish/releases/download/runtime-2026.09.28.3/runtime-linux-amd64.tar.gz",
    sha256: "2282f499430c1db582592dab32222b76f7f55a3e62a5d6410b74b2fb9ced65f8",
    bytes: 846965535,
    image: "sha256:bf24c22eef04da133265a0511fb80f88958693a2b65a2199bb25a96be23471e0"
  },
  arm64: {
    url: "https://github.com/danielgwilson/humanish/releases/download/runtime-2026.09.28.4/runtime-linux-arm64.tar.gz",
    sha256: "aff7675e6f60cc3fd9637f0fd8be5a80d8c018b8f825081c9a5e1a860aa8b993",
    bytes: 828203919,
    image: "sha256:5725814350e213fd8775d10a0895ca92018037ebf53ad805304ffc897e210510"
  }
};
