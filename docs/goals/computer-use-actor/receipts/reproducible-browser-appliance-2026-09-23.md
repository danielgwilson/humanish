# Browser appliance reproducibility experiment

Status: bounded source changes and real small-filesystem proof implemented.
Full local and independent CI disk comparisons and the browser proof on the
cache-cleaned base remain pending acceptance. No VM or runtime release is claimed.

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
