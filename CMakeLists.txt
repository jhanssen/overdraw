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

find_package(Dawn REQUIRED)
find_package(PkgConfig REQUIRED)
pkg_check_modules(WAYLAND_CLIENT REQUIRED wayland-client)
pkg_check_modules(GBM REQUIRED gbm)
pkg_check_modules(LIBDRM REQUIRED libdrm)

# Dawn is built -fno-rtti; match it to avoid typeinfo mismatches.
add_compile_options($<$<COMPILE_LANGUAGE:CXX>:-fno-rtti>)

# Shared IPC headers (side-channel protocol + transport).
set(IPC_INCLUDE ${CMAKE_SOURCE_DIR}/native/ipc)

# Checked-in xdg-shell client glue (generated once via wayland-scanner).
set(XDG_SHELL_DIR ${CMAKE_SOURCE_DIR}/native/wayland/generated)

# ---- GPU process (native, no JS) ----
add_executable(overdraw-gpu-process
    gpu-process/src/main.cpp
    gpu-process/src/host_window.cpp
    gpu-process/src/allocator.cpp
    ${XDG_SHELL_DIR}/xdg-shell-protocol.c)
target_include_directories(overdraw-gpu-process PRIVATE
    ${IPC_INCLUDE} ${XDG_SHELL_DIR} ${WAYLAND_CLIENT_INCLUDE_DIRS}
    ${GBM_INCLUDE_DIRS} ${LIBDRM_INCLUDE_DIRS})
target_link_libraries(overdraw-gpu-process PRIVATE
    dawn::webgpu_dawn ${WAYLAND_CLIENT_LIBRARIES}
    ${GBM_LIBRARIES} ${LIBDRM_LIBRARIES} pthread dl rt)
# -rdynamic so backtrace_symbols_fd can resolve function names in the crash handler.
target_link_options(overdraw-gpu-process PRIVATE -rdynamic)

# ---- Core (pure C++ stage; kept as a regression baseline during the Node pivot) ----
add_executable(overdraw-core
    core/src/main.cpp)
target_include_directories(overdraw-core PRIVATE ${IPC_INCLUDE})
target_link_libraries(overdraw-core PRIVATE
    dawn::webgpu_dawn_wire pthread dl rt)

# ---- Core N-API addon (Node-hosted core) ----
# Locate Node addon headers (node_api.h). Prefer the running node's bundled
# headers; fall back to the node-gyp cache for this version.
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

add_library(overdraw_native MODULE
    native/napi/addon.cpp)
set_target_properties(overdraw_native PROPERTIES
    PREFIX "" SUFFIX ".node")
target_compile_definitions(overdraw_native PRIVATE
    NODE_GYP_MODULE_NAME=overdraw_native BUILDING_NODE_EXTENSION)
target_include_directories(overdraw_native PRIVATE
    ${IPC_INCLUDE} ${NODE_INCLUDE_DIR})
target_link_libraries(overdraw_native PRIVATE
    dawn::webgpu_dawn_wire pthread dl rt)
# N-API symbols (napi_*) are resolved from the host node process at load time;
# a MODULE/shared object leaves them undefined at link by default.
