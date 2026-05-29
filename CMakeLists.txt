cmake_minimum_required(VERSION 3.24)
project(overdraw LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

# Sets Dawn_DIR (downloads/extracts the prebuilt wire bundle on first configure).
add_subdirectory(3rdparty/dawn)

find_package(Dawn REQUIRED)

# Minimal target proving the Dawn wire bundle downloads, configures, and links.
add_executable(overdraw-dawn-probe tools/dawn_probe.cpp)
target_link_libraries(overdraw-dawn-probe PRIVATE
    dawn::webgpu_dawn
    dawn::webgpu_dawn_wire
)
