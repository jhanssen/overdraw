# overdraw

A Wayland compositor with a thin C++ core, a JS protocol/policy layer, and a
separate native GPU process running Dawn (WebGPU). Plugins are JS modules run
as worker threads; they use an internal SDK, not Wayland.

- **Design:** `docs/architecture.md`
- **What is actually built and proven so far:** `docs/status.md`

The project is early. At present it builds two native executables that, run
together, present a cleared frame to a host Wayland window as a wire client /
GPU-process pair. There is no Wayland server, compositing, plugin, or JS layer
yet — see `docs/status.md`.

## Prerequisites

- Linux with a running Wayland session (overdraw runs nested as a client of it).
- CMake 3.24+ and Ninja.
- A C++20 compiler (GCC 15 / matching the Dawn build).
- `wayland-client` development files (1.24 known good).
- Network access on first configure: CMake downloads a prebuilt Dawn wire
  release tarball from `github.com/jhanssen/dawn` (pinned in
  `3rdparty/dawn/CMakeLists.txt`).

The xdg-shell client glue is pre-generated and checked in
(`native/wayland/generated/`), so `wayland-scanner` is **not** required to build.

## Build

```sh
cmake -S . -B build -G Ninja
cmake --build build
```

First configure downloads and extracts the pinned Dawn wire release; later
configures reuse it.

## Run

The core spawns the GPU process; pass the GPU-process binary path as the first
argument (or set `OVERDRAW_GPU_PROCESS`):

```sh
./build/overdraw-core ./build/overdraw-gpu-process
```

Expected: a host window opens and shows a solid red frame. The current slice
runs a bounded number of frames and then exits cleanly (the GPU process exits
with code 0). Console output ends with `RESULT: PASS`.

## Layout

```
3rdparty/dawn/   CMake glue that downloads the pinned Dawn wire release
core/            wire-client core (pure C++ for now; presents over the wire)
gpu-process/     native Dawn + wire server; owns the host output window
native/ipc/      side-channel protocol + transport shared by both processes
native/wayland/  checked-in generated Wayland client protocol glue
docs/            architecture.md (design), status.md (what exists)
```

## Updating the Dawn dependency

The Dawn build is a custom wire-enabled fork. To change it, edit the version /
commit in `3rdparty/dawn/CMakeLists.txt` to point at a release on
`github.com/jhanssen/dawn`. Releases are produced from that repo's
`scripts/build-wire-release.sh`.
