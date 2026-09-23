# Owned browser boot: host prerequisites

Status: fixture checks implemented; actual host measurement pending the reviewed
manual workflow on `main`. No VM has been created by this probe.

The [probe](../../../../scripts/owned-boot-host-profile.py) measures one fixed
Linux amd64 development profile on a disposable GitHub-hosted Ubuntu 24.04
runner. It reads OS, kernel, systemd, cgroup, current privilege and resource
facts; opens only `/dev/kvm`; checks KVM API version 12 and the fourteen default
amd64 capabilities required by pinned Firecracker 1.17.0; then closes the
descriptor. There is no permission repair, module loading, package installation,
service operation, VM creation or host fallback.

The capability list comes from
[Firecracker's pinned amd64 defaults](https://github.com/firecracker-microvm/firecracker/blob/95f868c8e345b1cc8faccd1a3c910b4989dc3f58/src/vmm/src/arch/x86_64/kvm.rs#L30).
Only `KVM_GET_API_VERSION` (`0xAE00`) and `KVM_CHECK_EXTENSION` (`0xAE03`) are
allowed. Capability ID zero is included; supported values greater than one
are accepted. `KVM_CREATE_VM`, configuration ioctls and optional VM-specific
queries are excluded.

The receipt separates host profile checks, KVM system-descriptor query results,
and proposed one-guest preparation headroom: two affinity CPUs, 4 GiB available
memory and 8 GiB available on the `/var/lib` backing filesystem. These are
development admission floors, not allocated capacity or throughput evidence.
Kernel families outside upstream's listed 5.10, 6.1 and 6.18 remain explicitly
unqualified development tuples. Even a listed family does not qualify this
host's complete hardware, distribution or security configuration.

PRs and pushes run synthetic fixtures only:

```sh
python3 -B -m unittest discover -s scripts/tests -p owned_boot_host_profile_test.py -v
```

The [manual workflow](../../../../.github/workflows/owned-boot-host-profile.yml)
allows actual inspection only from reviewed `main` in the canonical repository,
on the fixed hosted runner. Its unprivileged wrapper captures exact Git source
bytes at the event SHA and supplies them to isolated root Python on stdin with
a scrubbed environment. Root does not import checkout modules or execute a
mutable source path. The receipt records source/workflow hashes and the public
CI run identity. No credentials, environment dump or raw stderr is retained.

The inner measurement schema is `humanish.owned-boot-host-profile.v1`; the outer
command/provenance schema is `humanish.owned-boot-host-profile-ci.v1`. Missing,
denied or contradictory readbacks produce a blocked result. A timeout does not
invent root-child exit or descriptor-close evidence. The workflow retains the
finite receipt even when prerequisites are absent.

This measurement does not establish jailed-user KVM access, complete Firecracker
initialization, VM launch, guest boot, containment, cleanup, artifact transport,
or a managed local Humanish study. A positive receipt grants no launch authority.
