# spdlog: compiled mode (one static lib target spdlog::spdlog) via FetchContent.
# Pinned to v1.17.0. Built with -fno-rtti to match Dawn / the rest of the tree
# (root CMakeLists.txt sets -fno-rtti on all C++ TUs).
include(FetchContent)

set(SPDLOG_BUILD_SHARED OFF CACHE BOOL "" FORCE)
set(SPDLOG_BUILD_EXAMPLE OFF CACHE BOOL "" FORCE)
set(SPDLOG_BUILD_EXAMPLE_HO OFF CACHE BOOL "" FORCE)
set(SPDLOG_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(SPDLOG_BUILD_TESTS_HO OFF CACHE BOOL "" FORCE)
set(SPDLOG_BUILD_BENCH OFF CACHE BOOL "" FORCE)
set(SPDLOG_INSTALL OFF CACHE BOOL "" FORCE)
set(SPDLOG_FMT_EXTERNAL OFF CACHE BOOL "" FORCE)
# Compile-time floor: TRACE (0) in debug, INFO (2) in release. SPDLOG_LOGGER_*
# macros (and our LOG_* wrappers) below the floor compile to nothing.
# Numeric values match spdlog/common.h: TRACE=0 DEBUG=1 INFO=2 WARN=3 ERR=4
# CRITICAL=5 OFF=6.
if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    set(_OD_SPDLOG_LEVEL 0)
else()
    set(_OD_SPDLOG_LEVEL 2)
endif()

FetchContent_Declare(
    spdlog
    URL      https://github.com/gabime/spdlog/archive/refs/tags/v1.17.0.tar.gz
    URL_HASH SHA256=d8862955c6d74e5846b3f580b1605d2428b11d97a410d86e2fb13e857cd3a744
)
FetchContent_MakeAvailable(spdlog)

# Propagate the active level to every TU that includes spdlog headers. PUBLIC
# so consumers of the spdlog::spdlog target inherit it.
target_compile_definitions(spdlog PUBLIC SPDLOG_ACTIVE_LEVEL=${_OD_SPDLOG_LEVEL})

# Linked into .node shared modules. -fPIC required.
set_target_properties(spdlog PROPERTIES POSITION_INDEPENDENT_CODE ON)
