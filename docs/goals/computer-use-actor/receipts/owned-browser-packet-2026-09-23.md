# Owned offline browser packet: source checkpoint

This checkpoint introduces the finite PRELUDE and OB01 implementation for
[#825](https://github.com/danielgwilson/humanish/issues/825). It records no VM boot,
privileged execution, installed broker, or managed-local product qualification.

The existing artifact gate supplies the reviewed literal kernel, VMM, jailer,
Node, package, root and state identities. Those artifact identities authorize
only staging in this experiment; they are not evidence that the jailed guest can
boot on a particular host.

The source includes a retained parent for VMM process absence, a separately
retained parent for the forking root owner, finite broker-backed supervision,
exact file/socket/device cleanup, and a manual-main-only CI conductor. Local
fixtures exercise refusal and ownership boundaries without root, devices,
services or a VM. The first actual job still needs independent source review,
actual receipts and visual inspection of all three screenshots.

Seven fault cells remain explicitly `not_implemented`, and `aggregate` remains
false. See the [packet contract](../../../../runtime/owned-browser-qualification/README.md)
for the precise coverage, bounds and remaining gates.
