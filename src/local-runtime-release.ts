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
    url: "https://github.com/danielgwilson/humanish/releases/download/runtime-2026.09.26.1/runtime-linux-amd64.tar.gz",
    sha256: "4f352a8b499d06e5d35c01f2a3d5dbd306d71bdeef07014b8440b40e98131f62",
    bytes: 846993108,
    image: "sha256:cc40a86169ba8281c07247cdada01ab2ff2f9a2fec5a0f0971ae1e1e1af2c9e7"
  },
  arm64: {
    url: "https://github.com/danielgwilson/humanish/releases/download/runtime-2026.09.26.2/runtime-linux-arm64.tar.gz",
    sha256: "a87b3d10c2b1c298398332e61dec5736f53388626bd6cbcd70fb11451fdb4c6c",
    bytes: 828220836,
    image: "sha256:ea1beba9a943b5994c259910abe5a50e48b260fe07b99bc235a495d9635862ae"
  }
};
