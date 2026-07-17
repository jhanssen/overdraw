# Protocol XML

Every protocol the compositor speaks, vendored. `tools/gen-protocol` reads
only this directory — never `/usr/share/wayland{,-protocols}` — so the
generated interfaces (and with them the handler types the TypeScript sources
must satisfy, and the versions the globals advertise) are identical on every
machine, whatever the distro ships.

Reading them from the system made the build a function of the host's package
set: a distro that appends a request to an interface adds a member to the
generated handler type and fails the build until it is implemented; a distro
one release behind drops it and fails the build for the opposite reason.

## Provenance

| Source | Version | Files |
| --- | --- | --- |
| wayland | 1.25.0 | `wayland.xml` |
| wayland-protocols | 1.49 | everything else, except the rows below |
| wayland-protocols | 1.47 | `tearing-control-v1.xml` (interface version 1, identical in 1.49) |
| wlroots | — | `wlr-*.xml`, `kde-server-decoration.xml` |
| Mesa | — | `wayland-drm.xml` |

`wlr-*`, KDE server-decoration and `wl_drm` are not in wayland-protocols
upstream; they have always lived here.

## Refreshing

Copy the newer XML in, then run `npm run gen-protocols` and build. Any request
the new version adds shows up as a missing member on the generated
`WlXHandler` type, so the compiler names exactly what is unimplemented. Two
ways forward:

- implement the new requests, and let the interface advertise its new version;
- or pin the interface to its previous version in `VERSION_PINS`
  (`tools/gen-protocol/gen-protocol.js`), which drops the newer messages from
  the generated interface and caps the advertised version, so no client can
  reach them.

A pin is an unimplemented feature, not a formality: record it in
`docs/status.md` under the advertised-protocol gaps.
