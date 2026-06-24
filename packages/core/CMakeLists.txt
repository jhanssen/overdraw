cmake_minimum_required(VERSION 3.24)
project(overdraw LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

# Sets Dawn_DIR (downloads/extracts the prebuilt wire bundle on first configure).
add_subdirectory(3rdparty/dawn)

# spdlog (FetchContent, compiled static lib). Provides spdlog::spdlog target.
add_subdirectory(3rdparty/spdlog)

find_package(Dawn REQUIRED)
find_package(PkgConfig REQUIRED)
find_package(Threads REQUIRED)
pkg_check_modules(WAYLAND_CLIENT REQUIRED wayland-client)
pkg_check_modules(WAYLAND_SERVER REQUIRED wayland-server)
pkg_check_modules(GBM REQUIRED gbm)
pkg_check_modules(LIBDRM REQUIRED libdrm)
pkg_check_modules(XKBCOMMON REQUIRED xkbcommon)
# Xwayland XWM (xcb). composite: redirect root subwindows so toplevels present
# as wl_surfaces.
pkg_check_modules(XCB REQUIRED xcb)
pkg_check_modules(XCB_COMPOSITE REQUIRED xcb-composite)
# xfixes: selection-owner change notifications (the X11 clipboard / primary
# selection bridge depends on it).
pkg_check_modules(XCB_XFIXES REQUIRED xcb-xfixes)

# Phase-2 (DRM/KMS/libinput) deps. ON by default on Linux; the build still
# produces a working phase-1 nested compositor when OFF (no behavior change).
# When ON, the core's LibinputBackend + Seat are compiled in; the KMS output
# backend will land in a later slice.
option(OVERDRAW_KMS "Build phase-2 DRM/KMS/libinput/libseat support" ON)
if(OVERDRAW_KMS)
    pkg_check_modules(LIBINPUT REQUIRED libinput)
    pkg_check_modules(LIBSEAT  REQUIRED libseat)
    pkg_check_modules(LIBUDEV  REQUIRED libudev)
endif()

# Dawn is built -fno-rtti; match it to avoid typeinfo mismatches.
add_compile_options($<$<COMPILE_LANGUAGE:CXX>:-fno-rtti>)

# Shared IPC headers (side-channel protocol + transport).
set(IPC_INCLUDE ${CMAKE_SOURCE_DIR}/native/ipc)
set(NATIVE_INCLUDE ${CMAKE_SOURCE_DIR}/native)

# Checked-in xdg-shell client glue (generated once via wayland-scanner).
set(XDG_SHELL_DIR ${CMAKE_SOURCE_DIR}/native/wayland/generated)

# ---- GPU process (native, no JS) ----
set(OVERDRAW_GPU_PROCESS_SOURCES
    gpu-process/src/main.cpp
    gpu-process/src/host_window.cpp
    gpu-process/src/output_host_window.cpp
    gpu-process/src/allocator.cpp
    gpu-process/src/dmabuf_scanout_slot.cpp
    gpu-process/src/wayland_scanout_ring.cpp
    gpu-process/src/event_loop_epoll.cpp
    ${XDG_SHELL_DIR}/xdg-shell-protocol.c
    ${XDG_SHELL_DIR}/linux-dmabuf-v1-protocol.c)
if(OVERDRAW_KMS)
    list(APPEND OVERDRAW_GPU_PROCESS_SOURCES
        gpu-process/src/drm_utils.cpp
        gpu-process/src/kms_scanout_ring.cpp
        gpu-process/src/kms_output.cpp
        gpu-process/src/udev_monitor.cpp)
endif()
add_executable(overdraw-gpu-process ${OVERDRAW_GPU_PROCESS_SOURCES})
target_include_directories(overdraw-gpu-process PRIVATE
    ${IPC_INCLUDE} ${XDG_SHELL_DIR} ${WAYLAND_CLIENT_INCLUDE_DIRS}
    ${GBM_INCLUDE_DIRS} ${LIBDRM_INCLUDE_DIRS})
target_link_libraries(overdraw-gpu-process PRIVATE
    overdraw_log dawn::webgpu_dawn ${WAYLAND_CLIENT_LIBRARIES}
    ${GBM_LIBRARIES} ${LIBDRM_LIBRARIES} pthread dl rt)
if(OVERDRAW_KMS)
    target_compile_definitions(overdraw-gpu-process PRIVATE OVERDRAW_KMS=1)
    target_include_directories(overdraw-gpu-process PRIVATE
        ${LIBUDEV_INCLUDE_DIRS})
    target_link_libraries(overdraw-gpu-process PRIVATE
        ${LIBUDEV_LIBRARIES})
endif()
# -rdynamic so backtrace_symbols_fd can resolve function names in the crash handler.
target_link_options(overdraw-gpu-process PRIVATE -rdynamic)

# Locate Node addon headers (node_api.h, and uv.h which the core uses for the
# libuv-integrated Wayland server). Prefer the running node's bundled headers;
# fall back to the node-gyp cache for this version.
execute_process(
    COMMAND node -p "require('path').join(process.execPath,'..','..','include','node')"
    OUTPUT_VARIABLE NODE_INCLUDE_DIR OUTPUT_STRIP_TRAILING_WHITESPACE
    RESULT_VARIABLE NODE_INCLUDE_RESULT)
if(NOT EXISTS "${NODE_INCLUDE_DIR}/node_api.h")
    execute_process(
        COMMAND node -p "process.version.slice(1)"
        OUTPUT_VARIABLE NODE_VERSION OUTPUT_STRIP_TRAILING_WHITESPACE)
    set(NODE_INCLUDE_DIR "$ENV{HOME}/.cache/node-gyp/${NODE_VERSION}/include/node")
endif()
if(NOT EXISTS "${NODE_INCLUDE_DIR}/node_api.h")
    message(FATAL_ERROR "node_api.h not found (looked in ${NODE_INCLUDE_DIR})")
endif()
message(STATUS "Node addon headers: ${NODE_INCLUDE_DIR}")

# ---- Shared core library (native side of the Node-hosted core) ----
# Reusable Dawn wire transport (WireLink + transport/side_channel headers). No
# Wayland/Node deps, so BOTH the core addon and the plugin Worker addon can link
# it without pulling in wayland-server etc.
# Logging static lib. No Dawn / Wayland / Node dep: just spdlog + the
# log-record IPC frame format. Linked by every binary that produces or
# consumes log records (host addon, plugin addon, GPU process).
add_library(overdraw_log STATIC
    native/log/log.cpp
    native/log/ipc_sink.cpp
    native/log/ipc_source.cpp)
target_include_directories(overdraw_log PUBLIC
    ${IPC_INCLUDE} ${NATIVE_INCLUDE})
target_link_libraries(overdraw_log PUBLIC spdlog::spdlog pthread)
set_target_properties(overdraw_log PROPERTIES POSITION_INDEPENDENT_CODE ON)

add_library(overdraw_wire STATIC
    native/core/wire_link.cpp)
target_include_directories(overdraw_wire PUBLIC
    ${IPC_INCLUDE} ${NATIVE_INCLUDE})
target_link_libraries(overdraw_wire PUBLIC overdraw_log dawn::webgpu_dawn_wire pthread)
set_target_properties(overdraw_wire PROPERTIES POSITION_INDEPENDENT_CODE ON)

# Compiled once and linked by the addon (and any future native consumer), so
# core logic is not duplicated.
set(OVERDRAW_CORE_SOURCES
    native/core/gpu_process.cpp
    native/core/compositor.cpp
    native/core/input_wayland.cpp
    native/core/shm.cpp
    native/wayland/server.cpp
    native/wayland/interface_registry.cpp)
if(OVERDRAW_KMS)
    list(APPEND OVERDRAW_CORE_SOURCES
        native/core/seat.cpp
        native/core/input_libinput.cpp)
endif()
add_library(overdraw_core STATIC ${OVERDRAW_CORE_SOURCES})
target_include_directories(overdraw_core PUBLIC
    ${IPC_INCLUDE} ${NATIVE_INCLUDE} ${NODE_INCLUDE_DIR} ${WAYLAND_SERVER_INCLUDE_DIRS})
target_link_libraries(overdraw_core PUBLIC
    overdraw_wire dawn::webgpu_dawn_wire ${WAYLAND_SERVER_LIBRARIES} pthread dl rt)
if(OVERDRAW_KMS)
    target_include_directories(overdraw_core PUBLIC
        ${LIBINPUT_INCLUDE_DIRS} ${LIBSEAT_INCLUDE_DIRS} ${LIBUDEV_INCLUDE_DIRS}
        ${LIBDRM_INCLUDE_DIRS})
    target_link_libraries(overdraw_core PUBLIC
        ${LIBINPUT_LIBRARIES} ${LIBSEAT_LIBRARIES} ${LIBUDEV_LIBRARIES}
        ${LIBDRM_LIBRARIES})
    target_compile_definitions(overdraw_core PUBLIC OVERDRAW_KMS=1)
endif()
set_target_properties(overdraw_core PROPERTIES POSITION_INDEPENDENT_CODE ON)

# ---- Plugin Worker N-API addon (loaded inside plugin Worker isolates) ----
add_library(overdraw_plugin_native MODULE
    native/plugin-napi/addon.cpp
    native/plugin-napi/worker_wire.cpp)
set_target_properties(overdraw_plugin_native PROPERTIES PREFIX "" SUFFIX ".node")
target_compile_definitions(overdraw_plugin_native PRIVATE
    NODE_GYP_MODULE_NAME=overdraw_plugin_native BUILDING_NODE_EXTENSION)
target_include_directories(overdraw_plugin_native PRIVATE
    ${IPC_INCLUDE} ${NATIVE_INCLUDE} ${NODE_INCLUDE_DIR})
target_link_libraries(overdraw_plugin_native PRIVATE
    overdraw_wire dawn::webgpu_dawn_wire pthread dl rt)

# ---- Xwayland support (X11/xcb isolated from the Wayland + core targets) ----
# server.cpp: spawn/reap (no xcb). xwm.cpp: the X11 window manager over xcb.
add_library(overdraw_xwayland STATIC
    native/xwayland/server.cpp
    native/xwayland/xwm.cpp)
target_include_directories(overdraw_xwayland PUBLIC
    ${NATIVE_INCLUDE} ${XCB_INCLUDE_DIRS} ${XCB_COMPOSITE_INCLUDE_DIRS}
    ${XCB_XFIXES_INCLUDE_DIRS})
target_link_libraries(overdraw_xwayland PUBLIC
    ${XCB_LIBRARIES} ${XCB_COMPOSITE_LIBRARIES} ${XCB_XFIXES_LIBRARIES})
set_target_properties(overdraw_xwayland PROPERTIES POSITION_INDEPENDENT_CODE ON)

# ---- Core N-API addon (Node-hosted core) ----
add_library(overdraw_native MODULE
    native/napi/addon.cpp
    native/wayland/trampoline.cpp
    native/wayland/wayland_fd.cpp
    native/wayland/keymap.cpp
    native/cursor/xcursor.cpp
    native/xwayland/napi_xwayland.cpp)
set_target_properties(overdraw_native PROPERTIES
    PREFIX "" SUFFIX ".node")
target_compile_definitions(overdraw_native PRIVATE
    NODE_GYP_MODULE_NAME=overdraw_native BUILDING_NODE_EXTENSION)
target_include_directories(overdraw_native PRIVATE
    ${IPC_INCLUDE} ${NATIVE_INCLUDE} ${NODE_INCLUDE_DIR} ${XKBCOMMON_INCLUDE_DIRS}
    ${LIBDRM_INCLUDE_DIRS})
target_link_libraries(overdraw_native PRIVATE
    overdraw_core overdraw_xwayland dawn::webgpu_dawn_wire ${XKBCOMMON_LIBRARIES}
    ${LIBDRM_LIBRARIES} pthread dl rt)
# -rdynamic so backtrace_symbols_fd can resolve symbols in the crash handler.
target_link_options(overdraw_native PRIVATE -rdynamic)
# N-API symbols (napi_*) are resolved from the host node process at load time;
# a MODULE/shared object leaves them undefined at link by default.

# ---- Test client (minimal Wayland client for trampoline testing) ----
add_executable(wl-test-client test/wl-test-client.c)
target_include_directories(wl-test-client PRIVATE ${WAYLAND_CLIENT_INCLUDE_DIRS})
target_link_libraries(wl-test-client PRIVATE ${WAYLAND_CLIENT_LIBRARIES})

# Destructor-request test client: validates the trampoline destroys the
# libwayland resource on a destructor request BEFORE the client disconnects.
add_executable(wl-destructor-client test/wl-destructor-client.c)
target_include_directories(wl-destructor-client PRIVATE ${WAYLAND_CLIENT_INCLUDE_DIRS})
target_link_libraries(wl-destructor-client PRIVATE ${WAYLAND_CLIENT_LIBRARIES})

# Protocol-error test client: validates wl_resource_post_error reaches the
# client with the right error code + interface and disconnects it.
add_executable(wl-error-client test/wl-error-client.c)
target_include_directories(wl-error-client PRIVATE ${WAYLAND_CLIENT_INCLUDE_DIRS})
target_link_libraries(wl-error-client PRIVATE ${WAYLAND_CLIENT_LIBRARIES})

# X11 test client (xcb): creates + maps a window so the XWM test can observe an
# X11 window associate and enter the WM.
add_executable(x11-test-client test/x11-test-client.c)
target_include_directories(x11-test-client PRIVATE ${XCB_INCLUDE_DIRS})
target_link_libraries(x11-test-client PRIVATE ${XCB_LIBRARIES})

# X11 selection test client: takes / pastes a CLIPBOARD or PRIMARY value
# over the X11 wire. Used by test/xwayland-selection.gpu.mjs to exercise
# both directions of the selection bridge.
add_executable(x11-selection-client test/x11-selection-client.c)
target_include_directories(x11-selection-client PRIVATE ${XCB_INCLUDE_DIRS})
target_link_libraries(x11-selection-client PRIVATE ${XCB_LIBRARIES})

# ---- xdg-shell test client (toplevel-creation / configure handshake) ----
add_executable(xdg-test-client
    test/xdg-test-client.c
    native/wayland/generated/xdg-shell-protocol.c)
target_include_directories(xdg-test-client PRIVATE
    ${WAYLAND_CLIENT_INCLUDE_DIRS}
    ${CMAKE_SOURCE_DIR}/native/wayland/generated)
target_link_libraries(xdg-test-client PRIVATE ${WAYLAND_CLIENT_LIBRARIES})

# ---- fd test client (wl_shm.create_pool fd passing) ----
add_executable(fd-test-client test/fd-test-client.c)
target_include_directories(fd-test-client PRIVATE ${WAYLAND_CLIENT_INCLUDE_DIRS})
target_link_libraries(fd-test-client PRIVATE ${WAYLAND_CLIENT_LIBRARIES})

# ---- shm disconnect client (pools + buffers, drops without destroying) ----
add_executable(shm-disconnect-client test/shm-disconnect-client.c)
target_include_directories(shm-disconnect-client PRIVATE ${WAYLAND_CLIENT_INCLUDE_DIRS})
target_link_libraries(shm-disconnect-client PRIVATE ${WAYLAND_CLIENT_LIBRARIES})

# ---- shm test client (shm buffer upload + composite) ----
add_executable(shm-test-client
    test/shm-test-client.c
    native/wayland/generated/xdg-shell-protocol.c)
target_include_directories(shm-test-client PRIVATE
    ${WAYLAND_CLIENT_INCLUDE_DIRS}
    ${CMAKE_SOURCE_DIR}/native/wayland/generated)
target_link_libraries(shm-test-client PRIVATE ${WAYLAND_CLIENT_LIBRARIES})

# ---- harness client (controllable shm window for integration tests) ----
add_executable(harness-client
    test/harness-client.c
    native/wayland/generated/xdg-shell-protocol.c)
target_include_directories(harness-client PRIVATE
    ${WAYLAND_CLIENT_INCLUDE_DIRS}
    ${CMAKE_SOURCE_DIR}/native/wayland/generated)
target_link_libraries(harness-client PRIVATE ${WAYLAND_CLIENT_LIBRARIES})

# ---- subsurface test client (wl_subsurface compositing) ----
add_executable(subsurface-test-client
    test/subsurface-test-client.c
    native/wayland/generated/xdg-shell-protocol.c)
target_include_directories(subsurface-test-client PRIVATE
    ${WAYLAND_CLIENT_INCLUDE_DIRS}
    ${CMAKE_SOURCE_DIR}/native/wayland/generated)
target_link_libraries(subsurface-test-client PRIVATE ${WAYLAND_CLIENT_LIBRARIES})

# ---- clipboard test client (wl_data_device + primary selection) ----
add_executable(clipboard-test-client
    test/clipboard-test-client.c
    native/wayland/generated/xdg-shell-protocol.c
    native/wayland/generated/primary-selection-unstable-v1-protocol.c)
target_include_directories(clipboard-test-client PRIVATE
    ${WAYLAND_CLIENT_INCLUDE_DIRS}
    ${CMAKE_SOURCE_DIR}/native/wayland/generated)
target_link_libraries(clipboard-test-client PRIVATE ${WAYLAND_CLIENT_LIBRARIES})

# ---- ext-data-control test client (clipboard / primary selection without focus) ----
add_executable(ext-data-control-client
    test/ext-data-control-client.c
    native/wayland/generated/ext-data-control-v1-protocol.c)
target_include_directories(ext-data-control-client PRIVATE
    ${WAYLAND_CLIENT_INCLUDE_DIRS}
    ${CMAKE_SOURCE_DIR}/native/wayland/generated)
target_link_libraries(ext-data-control-client PRIVATE ${WAYLAND_CLIENT_LIBRARIES})

# ---- wp_presentation test client ----
add_executable(wp-presentation-client
    test/wp-presentation-client.c
    native/wayland/generated/xdg-shell-protocol.c
    native/wayland/generated/presentation-time-protocol.c)
target_include_directories(wp-presentation-client PRIVATE
    ${WAYLAND_CLIENT_INCLUDE_DIRS}
    ${CMAKE_SOURCE_DIR}/native/wayland/generated)
target_link_libraries(wp-presentation-client PRIVATE ${WAYLAND_CLIENT_LIBRARIES})

# ---- DnD test client (drag-and-drop) ----
add_executable(dnd-test-client
    test/dnd-test-client.c
    native/wayland/generated/xdg-shell-protocol.c)
target_include_directories(dnd-test-client PRIVATE
    ${WAYLAND_CLIENT_INCLUDE_DIRS}
    ${CMAKE_SOURCE_DIR}/native/wayland/generated)
target_link_libraries(dnd-test-client PRIVATE ${WAYLAND_CLIENT_LIBRARIES})

# ---- popup test client (xdg_popup / xdg_positioner) ----
add_executable(popup-test-client
    test/popup-test-client.c
    native/wayland/generated/xdg-shell-protocol.c)
target_include_directories(popup-test-client PRIVATE
    ${WAYLAND_CLIENT_INCLUDE_DIRS}
    ${CMAKE_SOURCE_DIR}/native/wayland/generated)
target_link_libraries(popup-test-client PRIVATE ${WAYLAND_CLIENT_LIBRARIES})

# ---- cursor test client (wl_pointer.set_cursor) ----
add_executable(cursor-test-client
    test/cursor-test-client.c
    native/wayland/generated/xdg-shell-protocol.c)
target_include_directories(cursor-test-client PRIVATE
    ${WAYLAND_CLIENT_INCLUDE_DIRS}
    ${CMAKE_SOURCE_DIR}/native/wayland/generated)
target_link_libraries(cursor-test-client PRIVATE ${WAYLAND_CLIENT_LIBRARIES})

# ---- cursor-shape test client (wp_cursor_shape_v1.set_shape) ----
add_executable(cursor-shape-test-client
    test/cursor-shape-test-client.c
    test/tablet-stub.c
    native/wayland/generated/xdg-shell-protocol.c
    native/wayland/generated/cursor-shape-v1-protocol.c)
target_include_directories(cursor-shape-test-client PRIVATE
    ${WAYLAND_CLIENT_INCLUDE_DIRS}
    ${CMAKE_SOURCE_DIR}/native/wayland/generated)
target_link_libraries(cursor-shape-test-client PRIVATE ${WAYLAND_CLIENT_LIBRARIES})

# ---- layer-shell test client (zwlr_layer_surface_v1 panel + keyboard) ----
add_executable(layer-shell-test-client
    test/layer-shell-test-client.c
    native/wayland/generated/xdg-shell-protocol.c
    native/wayland/generated/wlr-layer-shell-unstable-v1-protocol.c)
target_include_directories(layer-shell-test-client PRIVATE
    ${WAYLAND_CLIENT_INCLUDE_DIRS}
    ${CMAKE_SOURCE_DIR}/native/wayland/generated)
target_link_libraries(layer-shell-test-client PRIVATE ${WAYLAND_CLIENT_LIBRARIES})

# ---- SCM_RIGHTS transport unit test (fd passing over the side channel) ----
add_executable(scm-rights-test test/scm-rights-test.cpp)
target_include_directories(scm-rights-test PRIVATE ${IPC_INCLUDE})
target_link_libraries(scm-rights-test PRIVATE dawn::webgpu_dawn_wire)

# ---- CtrlSender wedge-resistance test (steady-state ctrl is non-blocking) ----
add_executable(ctrl-sender-test test/ctrl-sender-test.cpp)
target_include_directories(ctrl-sender-test PRIVATE ${IPC_INCLUDE})
target_link_libraries(ctrl-sender-test PRIVATE dawn::webgpu_dawn_wire)

# ---- WireBarrier native unit test (cross-channel ordering primitive) ----
# Header-only class; the test exercises the deferred-action FIFO + cancel +
# drainAll. No Dawn dep; the include path is just the shared ipc/ dir.
add_executable(wire-barrier-test test/wire-barrier-test.cpp)
target_include_directories(wire-barrier-test PRIVATE ${IPC_INCLUDE})

# ---- FdSerializer batch-overflow regression test ----
# Drives many GetCmdSpace calls whose cumulative bytes exceed kCapacity
# (16 MiB) and verifies the bytes round-trip through the socket. Catches the
# silent-drop regression where GetCmdSpace returns nullptr on batch overflow
# instead of flushing-and-retrying (Dawn's contract treats nullptr as fatal).
add_executable(wire-serializer-overflow-test test/wire-serializer-overflow-test.cpp)
target_include_directories(wire-serializer-overflow-test PRIVATE ${IPC_INCLUDE})
target_link_libraries(wire-serializer-overflow-test PRIVATE dawn::webgpu_dawn_wire Threads::Threads)

# ---- Logging native unit test (areas, --log-level parser, ipc sink/source) ----
add_executable(log-test test/log-test.cpp)
target_link_libraries(log-test PRIVATE overdraw_log)

# ---- Udev hotplug classifier unit test (pure functions; no daemon required)
# KMS-only because the .cpp pulls in <libudev.h>. The classifier itself doesn't
# use libudev, but the file compiles against the header so we still link the lib.
if(OVERDRAW_KMS)
    add_executable(udev-classifier-test
        test/udev-classifier-test.cpp
        gpu-process/src/udev_monitor.cpp)
    target_include_directories(udev-classifier-test PRIVATE
        gpu-process/src ${LIBUDEV_INCLUDE_DIRS})
    target_link_libraries(udev-classifier-test PRIVATE ${LIBUDEV_LIBRARIES})
endif()

# ---- dmabuf test client (linux-dmabuf-v1 import + composite) ----
add_executable(dmabuf-test-client
    test/dmabuf-test-client.c
    native/wayland/generated/xdg-shell-protocol.c
    native/wayland/generated/linux-dmabuf-v1-protocol.c)
target_include_directories(dmabuf-test-client PRIVATE
    ${WAYLAND_CLIENT_INCLUDE_DIRS}
    ${GBM_INCLUDE_DIRS}
    ${CMAKE_SOURCE_DIR}/native/wayland/generated)
target_link_libraries(dmabuf-test-client PRIVATE ${WAYLAND_CLIENT_LIBRARIES} ${GBM_LIBRARIES})

add_executable(dmabuf-cycle-client
    test/dmabuf-cycle-client.c
    native/wayland/generated/xdg-shell-protocol.c
    native/wayland/generated/linux-dmabuf-v1-protocol.c)
target_include_directories(dmabuf-cycle-client PRIVATE
    ${WAYLAND_CLIENT_INCLUDE_DIRS}
    ${GBM_INCLUDE_DIRS}
    ${CMAKE_SOURCE_DIR}/native/wayland/generated)
target_link_libraries(dmabuf-cycle-client PRIVATE ${WAYLAND_CLIENT_LIBRARIES} ${GBM_LIBRARIES})

add_executable(dmabuf-recommit-client
    test/dmabuf-recommit-client.c
    native/wayland/generated/xdg-shell-protocol.c
    native/wayland/generated/linux-dmabuf-v1-protocol.c)
target_include_directories(dmabuf-recommit-client PRIVATE
    ${WAYLAND_CLIENT_INCLUDE_DIRS}
    ${GBM_INCLUDE_DIRS}
    ${CMAKE_SOURCE_DIR}/native/wayland/generated)
target_link_libraries(dmabuf-recommit-client PRIVATE ${WAYLAND_CLIENT_LIBRARIES} ${GBM_LIBRARIES})

add_executable(dmabuf-async-client
    test/dmabuf-async-client.c
    native/wayland/generated/xdg-shell-protocol.c
    native/wayland/generated/linux-dmabuf-v1-protocol.c)
target_include_directories(dmabuf-async-client PRIVATE
    ${WAYLAND_CLIENT_INCLUDE_DIRS}
    ${GBM_INCLUDE_DIRS}
    ${CMAKE_SOURCE_DIR}/native/wayland/generated)
target_link_libraries(dmabuf-async-client PRIVATE ${WAYLAND_CLIENT_LIBRARIES} ${GBM_LIBRARIES})
