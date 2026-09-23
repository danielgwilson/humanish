# Browser appliance reproducibility experiment

Status: two complete local constructions and a fresh CI construction have
identical whole root/state disk bytes. The kernel outputs and runtime package
also match across hosts. Actual browser and build-failure checks passed.
No VM or runtime release is claimed.

The [disk recipe](../../../../runtime/browser-disk/README.md) admits the actual
recorded packager Node 22.14.0, uses filesystem epoch 1735689600, fixed nonzero
hash seeds, no-follow staging timestamp normalization, and complete file/owner/
mode/hardlink checks. The general package helper and Node 24 product support
remain unchanged. Real build dates and original input hashes remain provenance.

The maintained base removes generated caches while preserving fonts, notices,
configuration and the runtime loader cache. Tool package lists, relevant tool
executable/library/configuration hashes, full before/after filesystem inventories,
and actual image/archive identities remain in each private construction receipt.

The ordinary-container proof uses the real pinned e2fsprogs 1.47.2 tools. It varies
source inode times and file creation order, including a non-ASCII filename,
setuid mode, explicit ownership, hardlinks and symlinks. Two normalized 128 MiB
disks produced the same whole-file SHA256:

`9128238cbc96a029d496186424ef98553157974f1dc9f0e812fb6358f8e65427`

The two fake-time-only negative cells retained different imported modification
times and produced different disk bytes. The proof also checks each named inode's
four timestamps, filesystem checks, complete semantic readback, real block/inode
exhaustion, cooperative build interruption, unrelated-canary continuity and exact
owned-container absence. Small fixture equality establishes only these cells.

Run the retained proof recipe without mounts or devices:

```sh
python3 -B -m unittest discover -s runtime/browser-disk/tests -p 'test_*.py' -v
python3 runtime/browser-disk/proof.py --tools-image sha256:EXACT_TOOL_IMAGE_DIGEST --output .humanish/disk-proof
```

Whole disk hashes decide subsequent reproducibility acceptance. Comparison keeps
`sameDeclaredInputs` separate from `sameBuildProfileAndSemanticContents`; rebuilt
archive/container metadata may differ and is explicitly reported. A mismatch
returns nonzero. Matching bytes do not approve a catalog, establish boot or
containment, authorize redistribution, or prove a working managed local study.

## Complete local constructions

Two full assemblies with actual Node 22.14.0 packaging produced these identical
whole-file SHA256 values:

| Artifact | Bytes | SHA256 |
| --- | ---: | --- |
| Root filesystem | 2,147,483,648 | `7d7ee4dc3cbb167f81cd958ff9cb27616262d10407f0753fec9a4ddaa9cdb4ec` |
| Fresh state template | 536,870,912 | `ebaf1c48e2341bae5de32f7e29c9ab7ae67004861d69479bb251cbc9b04e8a24` |

Both readbacks verify 14,222 root entries and 2 state entries, including complete
content, ownership, mode, hardlink and named-inode timestamp checks. The runtime
revision is `guest-api1-2ec510cd6f269432d26597e6d0210d329630973f83a260189bd378fb5c28fafd`;
its package manifest SHA256 is
`f9ae77be920b6ce4c309e7e15066c99fc5a323e0765e728207f31aefef173bff`.
The original input archive and actual source/build metadata remain retained.

The cache-cleaned base passed the actual 26-case browser/controller proof and
three packaged Python relay-import checks, under the existing read-only root,
1536 MiB/no-swap, 256-task, no-network profile with Chromium's sandbox enabled.
This is ordinary-container behavior, not guest PID1, KVM or AF_VSOCK evidence.
The browser proof receipt SHA256 is
`a7078433a234721c04cbcfbe55a03a71b0de5d08651083aecdafe37d2975f16b`.
All owned containers were confirmed absent. The source/small-proof review and
68 disk contract tests passed. Independent full artifact review rehashed both
root/state pairs, validated the source/package bindings, reparsed every inode
row and reviewed the browser evidence.


## Fresh cross-host construction

[Appliance run 35887828929](https://github.com/danielgwilson/humanish/actions/runs/35887828929)
passed for source head `987d8ccbcb7900cd574549355330d91130f8abd7`.
The checkout log records tested merge
`6038685f128527d686be7058d633f4cb82265c91` into
`1c6d7d625615f1bcd9c4480cf57e24f617dbf072`.
[PR #824](https://github.com/danielgwilson/humanish/pull/824) merged the reviewed
source as `2be1193b2bd6924d4717aa24e9b48169688055ce`.

The CI builder hashed the complete root/state disks: both match the table above.
All five kernel outputs match the accepted local construction, including the
27,736,920-byte ELF with SHA256
`caf3803a0c8c3cacdc2beedbd49f4806d4697934ddb328cf4df42ff2533ef138`.
The 882-leaf runtime package manifest is byte-identical to the local package.

Independent review checked 67 source/build bindings, rehashed 76 exported
receipt/log files and reparsed all 14,224 inode-readback rows. The existing
browser proof consumer accepted the actual container logs: all 26 cases and
three relay imports agree with the receipt. Real capacity failures, cooperative
interruption without output promotion, unchanged running canary identity and
all four owned-container cleanup observations passed.

The outer base archive, Docker base image and tools image identities differ
between hosts and remain in the retained receipts. They are not claimed to be
reproducible. CI exported receipts and logs, not appliance binaries. Cross-host
binary hashes come from the source-bound CI build; review independently
rehashed the exported receipts/logs and the locally retained full artifacts.
It did not rehash unavailable downloaded CI binaries.

This result resolves whole-disk reproducibility for this exact development
recipe. It does not establish VM boot, guest PID1, actual AF_VSOCK, lifecycle
fault handling, ARM64, production isolation, a managed local study or permission
to distribute images. Cooperative build interruption does not prove SIGKILL or
VM cleanup. No npm release accompanies this receipt.
