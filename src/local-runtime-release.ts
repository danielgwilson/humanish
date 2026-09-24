import type { LocalRuntimeRelease } from "./local-runtime.js";

/** Updated with the verified, public runtime artifact before release. */
export const LOCAL_RUNTIME_RELEASE: LocalRuntimeRelease = {
  url: "https://github.com/danielgwilson/humanish/releases/download/runtime-2026.09.24.1/runtime-linux-amd64.tar.gz",
  sha256: "8df88a82b9615bf35ddcd4a60b1be6f95f178a254d88aab79871aace4a22ac56",
  bytes: 596136865,
  image: "sha256:9597abdb46255190640443ea485010d2a45f51699e7cb47372d6ee895d280f5c"
};

/** Architecture-specific artifacts; each retains matching sources and notices. */
export const LOCAL_RUNTIME_RELEASES: Partial<Record<"amd64" | "arm64", LocalRuntimeRelease>> = {
  amd64: LOCAL_RUNTIME_RELEASE,
  arm64: {
    url: "https://github.com/danielgwilson/humanish/releases/download/runtime-2026.09.24.2/runtime-linux-arm64.tar.gz",
    sha256: "16f10b21f6436ef39f18fb9615cae7045d3fc2a20798c1e42122d574f58c759b",
    bytes: 582695626,
    image: "sha256:52cd53169236cd70a445938bda008987f18a97303794ae0ff75cc15bbbd26671"
  }
};
