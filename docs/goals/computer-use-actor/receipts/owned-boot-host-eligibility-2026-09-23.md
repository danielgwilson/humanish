# Owned browser boot: host prerequisites

Status: actual read-only prerequisites passed on one disposable development host.
No VM was created by this probe.

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


## Actual measurement

[Manual run 35885367017](https://github.com/danielgwilson/humanish/actions/runs/35885367017)
executed reviewed source `1c6d7d625615f1bcd9c4480cf57e24f617dbf072` from canonical
`main`. Both the 23 hermetic fixtures and actual measurement job passed.
Independent receipt review checked the source/workflow hashes, exact ordered
queries, closed descriptor, observed successful child exit and explicit limits.

| Observed fact | Result |
| --- | --- |
| Runner image | Ubuntu 24.04, `20260907.300.1`, Linux amd64 |
| Kernel | `6.17.0-1022-azure` |
| systemd / Python | `255.4-1ubuntu8.17` / `3.12.3` |
| Host profile | All 12 fixed prerequisite checks passed |
| KVM | API 12; all 14 required system-descriptor capabilities supported |
| Resource snapshot | 4 affinity CPUs, 15,789,010,944 available memory bytes, 92,372,246,528 available backing bytes |
| Completion | Device descriptor closed; probe and command exited successfully |

`ADJUST_CLOCK` returned the supported bitmask value 14; the remaining required
queries returned 1. This confirms why support is tested as a positive integer,
rather than equality to one. The root probe measured 15 ms internally; that is
readback duration, not VM or browser startup latency.

The retained receipt SHA256 is
`53e44b492a535a52f03f64a3f4d69817dabec003322cafc8abde33c450a11c64`.
The executed probe/wrapper SHA256 is
`04311dce508bd0304d1d68cfb91cc860954d9358bab02e663e94f1ad00bbed7d`;
the workflow SHA256 is
`429ac4c00e96adc6f1e78184f0b070c6dfa19268cd13ce79eafea638d54c1145`.

This kernel family is outside the pinned upstream list, and the receipt retains
`kernel_tuple_development_unqualified`. The result establishes prerequisites for
a subsequent controlled development test. It does not establish upstream host
support, jailed access, VM boot or production isolation. No VM, service, host
permission change or image import occurred. The available-resource snapshot is
not allocated capacity or a local participant-count promise.
