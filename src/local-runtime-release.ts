import type { LocalRuntimeRelease } from "./local-runtime.js";

/** Updated with the verified, public runtime artifact before release. */
export const LOCAL_RUNTIME_RELEASE: LocalRuntimeRelease = {
  url: "https://github.com/danielgwilson/humanish/releases/download/runtime-2026.09.25.1/runtime-linux-amd64.tar.gz",
  sha256: "1a70b2606d3c039dda0c850f934186b23843ee8ae3fe0058cb50061332cfa0b5",
  bytes: 596160858,
  image: "sha256:4c81172f876fc522a4a5fb03e5604486c35e74bb8ae91552f605492ed311111e"
};

/** Architecture-specific artifacts; each retains matching sources and notices. */
export const LOCAL_RUNTIME_RELEASES: Partial<Record<"amd64" | "arm64", LocalRuntimeRelease>> = {
  amd64: LOCAL_RUNTIME_RELEASE,
  arm64: {
    url: "https://github.com/danielgwilson/humanish/releases/download/runtime-2026.09.25.2/runtime-linux-arm64.tar.gz",
    sha256: "3e208e432b7df1cac41e0d6935dc8c8c7cf691490f7e66700408c4be82927417",
    bytes: 582638498,
    image: "sha256:fcb7e1e8e5641fa39c7b74016648f2f0da50760546753e5835f6e93f4d50834f"
  }
};

/** Media assets are separate so ordinary browser studies keep the smaller download. */
export const LOCAL_MEDIA_RUNTIME_RELEASES: Partial<Record<"amd64" | "arm64", LocalRuntimeRelease>> = {
  amd64: {
    url: "https://github.com/danielgwilson/humanish/releases/download/runtime-2026.09.25.3/runtime-linux-amd64.tar.gz",
    sha256: "133d49cd7d907e2b77ca3bf795afdb092c370edfcf245db1a543b1fb1c19f93a",
    bytes: 783691467,
    image: "sha256:eece7d4e0d1d4f6f22b054e02a7f7934d40e240fd8435194118f44051bfe10d2"
  },
  arm64: {
    url: "https://github.com/danielgwilson/humanish/releases/download/runtime-2026.09.25.4/runtime-linux-arm64.tar.gz",
    sha256: "854efcd7100fc6e2c17d248aff552e9690a0239d801204b1684449185da8e7a8",
    bytes: 764841695,
    image: "sha256:b670fe05d5b4cf188cc9b291c0f0837fbe6741a68aa6fef4b8b558169f25010d"
  }
};
