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
    url: "https://github.com/danielgwilson/humanish/releases/download/runtime-2026.09.26.3/runtime-linux-amd64.tar.gz",
    sha256: "7d88977a159b107f4f2081de5cc7f5bfc4ed5989f5d091ea7dcc0f575c2094e6",
    bytes: 846965794,
    image: "sha256:f578c0b3ce6d4095563727f2d6ccc1be44a935780e1f8238c883ade27981858d"
  },
  arm64: {
    url: "https://github.com/danielgwilson/humanish/releases/download/runtime-2026.09.26.4/runtime-linux-arm64.tar.gz",
    sha256: "ea23a2707efe9498aefc4aa8aa69f51bf844625a78baa6a3f26164f9c2f1233a",
    bytes: 828212084,
    image: "sha256:6018709a97259749994688580f4384f1463ef6d45ebb717a7841410692d9b748"
  }
};
