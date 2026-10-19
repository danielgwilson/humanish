// The images humanish creates Modal sandboxes from. Modal builds each one in the operator's
// workspace on first use and caches it by its definition, so humanish publishes no image. The
// base and apt snapshot are the digest-pinned ones runtime/browser-guest/inputs.json uses, so a
// humanish version always builds the same layers.
import type { ModalClient, ModalImage } from "./sdk.js";

const DEBIAN_BASE =
  "debian@sha256:7792b1f7702a86946cd518db72b6a407302c3e9bc1635634368b878189e8221c";
const DEBIAN_SNAPSHOT = "20260923T083042Z";
const SECURITY_SNAPSHOT = "20260922T123247Z";

/** The sandbox account commands run as, matching E2B's `user` and its home. */
export const MODAL_SANDBOX_USER = { name: "user", uid: 1000, home: "/home/user" } as const;

const SNAPSHOT_SOURCES =
  `printf 'Types: deb\\nURIs: http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}/\\nSuites: trixie trixie-updates\\nComponents: main\\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\\nCheck-Valid-Until: no\\n\\nTypes: deb\\nURIs: http://snapshot.debian.org/archive/debian-security/${SECURITY_SNAPSHOT}/\\nSuites: trixie-security\\nComponents: main\\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\\nCheck-Valid-Until: no\\n'` +
  " > /etc/apt/sources.list.d/humanish.sources";

// What the terminal route's steps call: the Node bootstrap's prerequisites (curl, coreutils, tar,
// gzip, sudo), git for product installs, and python3 and unzip, which E2B's stock template has.
const SHELL_PACKAGES = [
  "bash",
  "ca-certificates",
  "curl",
  "git",
  "gzip",
  "less",
  "procps",
  "python3",
  "sudo",
  "tar",
  "unzip",
  "xz-utils",
];

// What the e2b-desktop modules call in a desktop, beside the shell's packages: Xvfb and an XFCE
// session as @e2b/desktop starts them, xdotool and scrot for input and screenshots, x11vnc and
// noVNC for the stream, the X utilities the geometry and screen probes run, wmctrl, ffmpeg and
// PulseAudio for recordings, Chromium, and fonts for Latin, Chinese, Japanese, Korean and emoji
// text.
const DESKTOP_PACKAGES = [
  "chromium",
  "dbus-x11",
  "ffmpeg",
  "fonts-dejavu",
  "fonts-noto-cjk",
  "fonts-noto-color-emoji",
  "net-tools",
  "novnc",
  "pulseaudio",
  "pulseaudio-utils",
  "scrot",
  "websockify",
  "wmctrl",
  "x11-utils",
  "x11-xserver-utils",
  "x11vnc",
  "xdg-utils",
  "xdotool",
  "xfce4",
  "xfce4-terminal",
  "xvfb",
];

/** The terminal route's image: a Debian shell with a passwordless-sudo `user`, as on E2B. */
export function modalShellImage(client: ModalClient): ModalImage {
  return debianImage(client, SHELL_PACKAGES);
}

/** The computer-use route's image: the shell's packages and an XFCE desktop with Chromium. */
export function modalDesktopImage(client: ModalClient): ModalImage {
  return debianImage(client, [...SHELL_PACKAGES, ...DESKTOP_PACKAGES]);
}

function debianImage(client: ModalClient, packages: readonly string[]): ModalImage {
  const { name, uid, home } = MODAL_SANDBOX_USER;
  // prose-check: script
  return client.images
    .fromRegistry(DEBIAN_BASE)
    .dockerfileCommands([
      "ENV DEBIAN_FRONTEND=noninteractive",
      `RUN rm -f /etc/apt/sources.list /etc/apt/sources.list.d/* && ${SNAPSHOT_SOURCES} && apt-get update && apt-get install -y --no-install-recommends ${packages.join(" ")} && rm -rf /var/lib/apt/lists/*`,
      `RUN useradd --uid ${uid} --create-home --home-dir ${home} --shell /bin/bash ${name} && printf '${name} ALL=(ALL) NOPASSWD:ALL\\n' > /etc/sudoers.d/${name} && chmod 0440 /etc/sudoers.d/${name}`,
      `WORKDIR ${home}`,
    ]);
}
