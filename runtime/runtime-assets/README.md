# Development browser boot inputs

This directory pins the actual amd64 inputs for a browser-kernel development
build. It does not authorize an installed runtime, root import, VM allocation or
image distribution. `inputs.json` is a reviewed build-input record, not the
future CLI/broker catalog.

From the repository root, use a new output directory for each attempt:

```sh
mkdir -p .humanish
python3 runtime/runtime-assets/fetch.py --output .humanish/boot-inputs
```

The fetcher downloads only fixed HTTPS inputs, enforces exact sizes and SHA256,
checks the Firecracker checksum sidecar and member checksums, and extracts only
six named regular release members. It never executes them. Failures preserve
partial evidence and never overwrite an earlier attempt. Only amd64 is admitted. A transfer checks a 180-second monotonic
deadline between single reads/redirects; an in-flight socket wait can add up to
30 seconds. This is not a hard 180-second process wall-clock guarantee, including
platform DNS resolution. No whole-operation hard deadline is claimed.

## Provenance

- Firecracker and jailer are the matching **v1.17.0** amd64 release pair. The
  official release archive's downloaded digest matched its GitHub asset digest
  and checksum sidecar. The tag resolves to
  `95f868c8e345b1cc8faccd1a3c910b4989dc3f58`. That tag is unsigned and the
  GitHub release is mutable; no detached release signature was provided. Pins
  preserve the reviewed bytes. This is official HTTPS origin plus integrity
  verification, not a cryptographically signed VMM release claim.
- The complete Firecracker source archive at that commit, LICENSE, NOTICE and
  THIRD-PARTY are retained. The locked Rust dependency source archives are not
  mirrored here, and these release binaries have not been independently rebuilt.
- The browser kernel uses Amazon's **kernel6.18 6.18.39-79.141.amzn2023** source
  RPM from the fixed `2023.12.20260817` repository. Its signed metadata and source
  RPM signatures were verified against the public fingerprint
  `B21C50FA44A99720EAA72F7FE951904AD832C631`, documented by AWS. The builder
  repeats signature verification in an isolated container and retains the full
  source RPM, configuration and ordered patches.
- The Firecracker v1.17.0 configuration header names that exact Amazon version.
  It is not byte-identical to the RPM's input config: generated settings, build
  salt and hotplug settings differ. The final compiler normalization and browser
  restrictions are retained as a complete configuration delta. The official
  microvm config is not advertised as a supported mainline-kernel configuration.

The fixed signing key bytes come from the independently hash-pinned system-release
source RPM; their fingerprint is checked before use. No user keyring is imported
into the container. The kernel recipe retains its own GPG/RPM verification logs.
The official key fingerprint remains an initial trust decision, not a key learned
from the candidate kernel's signature.

References: [Firecracker release](https://github.com/firecracker-microvm/firecracker/releases/tag/v1.17.0),
[kernel policy](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/docs/kernel-policy.md),
[Amazon repository signing](https://docs.aws.amazon.com/linux/al2023/ug/repo-metadata-signing.html).

No artifact is approved for public redistribution by this workflow. Source and
notice completeness for distribution, the final owner/catalog path, native ARM64,
KVM compatibility, guest boot and runtime containment remain separate gates.
