import type { LocalRuntimeRelease } from "./runtime.js";

/** Updated with the verified, public runtime artifact before release. */
const LOCAL_RUNTIME_RELEASE: LocalRuntimeRelease = {
  url: "https://github.com/danielgwilson/humanish/releases/download/runtime-2026.10.21.1/runtime-linux-amd64.tar.gz",
  sha256: "1de53db000f661e91ff6ea9a2eb8198b08b850621cf63d8ce7c1b046f5035faf",
  bytes: 597029770,
  image: "sha256:c805c310b7b086276efa74ea5735e8b559457c7edba85c5c9e3ac7934e8760f2",
};

/** Architecture-specific artifacts; each retains matching sources and notices. */
export const LOCAL_RUNTIME_RELEASES: Partial<Record<"amd64" | "arm64", LocalRuntimeRelease>> = {
  amd64: LOCAL_RUNTIME_RELEASE,
  arm64: {
    url: "https://github.com/danielgwilson/humanish/releases/download/runtime-2026.10.21.2/runtime-linux-arm64.tar.gz",
    sha256: "ea7a42e12eae3b4d9140fff41e4e3512930202f9ccbb688497b146634d1cef10",
    bytes: 583555960,
    image: "sha256:e21c33b4745afdb3bac6a69c76606814348032ee661228c9bfdd9c7d06591a28",
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
