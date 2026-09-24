import type { LocalRuntimeRelease } from "./local-runtime.js";

/** Updated with the verified, public runtime artifact before release. */
export const LOCAL_RUNTIME_RELEASE: LocalRuntimeRelease = {
  url: "https://github.com/danielgwilson/humanish/releases/download/runtime-2026.09.24.3/runtime-linux-amd64.tar.gz",
  sha256: "936e4bdc5c844347c6d6ae2149f1f96cfcabab0c33c8dd7fb3ae1b74b3b91812",
  bytes: 596154336,
  image: "sha256:062f7e9eb8096f6e48906ec0d277c3a9d086ef4ebd275aa2efc43edcd86e5349"
};

/** Architecture-specific artifacts; each retains matching sources and notices. */
export const LOCAL_RUNTIME_RELEASES: Partial<Record<"amd64" | "arm64", LocalRuntimeRelease>> = {
  amd64: LOCAL_RUNTIME_RELEASE,
  arm64: {
    url: "https://github.com/danielgwilson/humanish/releases/download/runtime-2026.09.24.4/runtime-linux-arm64.tar.gz",
    sha256: "9b396d1d222917ffbac21ae448340fdcc563a9b2f757682d9806248941125cda",
    bytes: 582659561,
    image: "sha256:ed92f65a1f5b064952ea8b289f6bc1e7b5a9babe15ed1c7efec49e395e86eead"
  }
};
