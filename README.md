# overdraw

A Wayland compositor with a thin C++ core, a JS protocol/policy/compositing
layer (Node + N-API addon), and a separate native GPU process running Dawn
(WebGPU). Plugins are JS modules run either as worker threads or in-thread for
bundled defaults; they use an internal SDK, not Wayland.

- **Design:** `docs/architecture.md`
- **Implementation plan:** `docs/build-order.md`
- **What is actually built and proven so far:** `docs/status.md`
- **Agent / contributor operational notes:** `CLAUDE.md`

For a sense of scope: the compositor accepts real Wayland clients
(`foot`, `kitty`, Vulkan/WebGPU WSI clients), tiles them via a bundled
master-stack layout plugin, handles input/focus/clipboard/DnD/subsurfaces/
popups end-to-end, and exposes a plugin SDK for layout/focus/decoration/
overlay/animation/scene-compose/workspaces/hotkeys. Read `docs/status.md`
for the precise list of what's wired and what isn't.

## Prerequisites

- Linux with a running Wayland session (overdraw runs nested as a client of it).
- Node 24+ (native type-stripping is used; no transpile step for `.ts` config files).
- CMake 3.24+ and Ninja.
- A C++20 compiler (GCC 15 / matching the Dawn build).
- pkg-config and development files for: `wayland-client`, `wayland-server`,
  `gbm`, `libdrm`, `xkbcommon`.
- Network access on first configure: CMake downloads a prebuilt Dawn wire
  release tarball from `github.com/jhanssen/dawn` (pinned in
  `packages/core/3rdparty/dawn/CMakeLists.txt`). The tarball includes both
  the Dawn wire libraries (linked by the native build) and `dawn.node`
  (the WebGPU JS bindings the JS compositor loads at runtime).

The xdg-shell and linux-dmabuf-v1 client glue is pre-generated and checked in
(`packages/core/native/wayland/generated/`), so `wayland-scanner` is **not**
required to build.

## Build

```sh
npm install
npm run build
```

`npm run build` runs both halves:

- `build:js` — generates Wayland protocol bindings from XML, compiles
  TypeScript across the workspace.
- `build:native` — configures CMake on first run (downloads the Dawn wire
  release), then builds:
  - `overdraw-gpu-process` (native, owns the host Wayland output window and
    Dawn native instance)
  - `overdraw_native.node` (core N-API addon)
  - `overdraw_plugin_native.node` (plugin Worker N-API addon)
  - C/C++ test clients used by the integration tests

Artifacts land in `packages/core/build/` and `packages/core/dist/`.

You can also run the halves independently: `npm run build:js`,
`npm run build:native`.

## Run

```sh
npm run compositor
```

This launches the JS-hosted core (`packages/core/dist/main.js`), which
fork+execs the bundled GPU process. The core prints the Wayland display name
it created; point a client at it:

```sh
WAYLAND_DISPLAY=<printed-name> foot
```

To run with a user config:

```sh
node packages/core/dist/main.js --config examples/hotkeys/config.mjs
```

Without `--config`, the launcher probes `$XDG_CONFIG_HOME/overdraw/config.*`
then `~/.config/overdraw/config.*` (`.ts/.cts/.mts/.js/.cjs/.mjs`).

The GPU-process binary path defaults to `packages/core/build/
overdraw-gpu-process`; override with `OVERDRAW_GPU_PROCESS=<path>`.

## CLI

`overdrawctl` is a thin JSON-RPC client over the compositor's control socket
(`$XDG_RUNTIME_DIR/overdraw-<display>.sock`):

```sh
node packages/core/dist/cli/overdrawctl.js list                    # list actions
node packages/core/dist/cli/overdrawctl.js invoke compositor.quit
node packages/core/dist/cli/overdrawctl.js subscribe 'input.*'
```

## Tests

```sh
npm test                 # pure-unit, GPU-free
npm run test:gpu         # integration; requires GPU + host Wayland session
```

GPU tests auto-skip when `WAYLAND_DISPLAY` is unset.

## Examples

- `examples/decorations/` — bundled-decoration plugin (animated-gradient
  titlebar over a real client window)
- `examples/hotkeys/` — config exercising chords, modes, workspace
  switching, user-defined actions, and deferred refs

## Layout

```
docs/                       architecture (design), build-order (plan),
                            status (ground truth)
examples/                   runnable example configs and plugins
packages/
  core/                     the compositor itself (npm name: overdraw)
    src/                    JS/TS protocol layer, WM, compositing,
                              plugin runtime, IPC, animation evaluator,
                              input chain, ...
    native/                 N-API addon, libuv-integrated Wayland server,
                              Dawn wire client (core side), trampoline
    gpu-process/            native Dawn + wire server; owns the host
                              output window, GBM allocator, scanout
    3rdparty/dawn/          CMake glue: downloads the pinned Dawn wire
                              release tarball
    bin/overdrawctl         IPC CLI entry point
    test/                   C/C++ Wayland test clients
    tools/gen-protocol/     XML -> .js/.d.ts protocol generator
    CMakeLists.txt          builds the GPU process + both N-API addons
  layout-types/             type contract: bundled layout plugin
  focus-types/              type contract: bundled focus plugin
  workspace-types/          type contract: bundled workspace plugin
  hotkey-types/             type contract: bundled hotkey plugin
  animation-types/          type contract: animation evaluator
  sdk-anim/                 plugin-side animation spec builders
  plugin-layout-default/    bundled: master-stack tiling layout
  plugin-focus-default/     bundled: follow-pointer / click-to-focus
  plugin-workspace-default/ bundled: dynamic workspaces
  plugin-hotkey-default/    bundled: user-configurable keyboard bindings
  plugin-core-actions/      bundled: core actions (compositor.quit, ...)
  plugin-config-actions/    bundled: registers user-config actions
test/                       integration tests (*.test.js pure-unit;
                              *.gpu.mjs GPU-required)
```

## Updating the Dawn dependency

The Dawn build is a custom wire-enabled fork. To change it, edit the version
in `packages/core/3rdparty/dawn/CMakeLists.txt` to point at a release on
`github.com/jhanssen/dawn`. Releases are produced from that repo's
`scripts/build-wire-release.sh`. After bumping, also update the matching
`dawn.node` dependency in the workspace if the binary ABI changed.
