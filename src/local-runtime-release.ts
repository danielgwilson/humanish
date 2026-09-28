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
    url: "https://github.com/danielgwilson/humanish/releases/download/runtime-2026.09.28.5/runtime-linux-amd64.tar.gz",
    sha256: "912361889503f011ef1a255e3138fc51ff67ba686529715aa4c0b79744e18d21",
    bytes: 846951548,
    image: "sha256:34d41e8345739ecb18348bb6acadcd10a8854b79528127704a704d7a4a2080ff"
  },
  arm64: {
    url: "https://github.com/danielgwilson/humanish/releases/download/runtime-2026.09.28.6/runtime-linux-arm64.tar.gz",
    sha256: "59c6321878bb392949507d1325ae39ab462462ff473da24d52b2eedf8bccd014",
    bytes: 828229067,
    image: "sha256:9e6c29bb56139204efb618e3b89fb0fc30f96db8502a05102788d3c610fa019a"
  }
};
