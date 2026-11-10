cmake_minimum_required(VERSION 3.22.1)

# AGP invokes this project only to configure the Android NDK for Flutter's
# plugin packaging. There are no app-owned native sources or targets.
if(ANDROID_ABI STREQUAL "arm64-v8a")
    set(SODUWORK_ANDROID_TARGET "aarch64-linux-android")
elseif(ANDROID_ABI STREQUAL "armeabi-v7a")
    set(SODUWORK_ANDROID_TARGET "armv7a-linux-androideabi")
elseif(ANDROID_ABI STREQUAL "x86")
    set(SODUWORK_ANDROID_TARGET "i686-linux-android")
elseif(ANDROID_ABI STREQUAL "x86_64")
    set(SODUWORK_ANDROID_TARGET "x86_64-linux-android")
endif()
if(SODUWORK_ANDROID_TARGET)
    set(SODUWORK_ANDROID_TARGET_TRIPLE "${SODUWORK_ANDROID_TARGET}${CMAKE_SYSTEM_VERSION}")
    set(CMAKE_C_COMPILER_TARGET "${SODUWORK_ANDROID_TARGET_TRIPLE}" CACHE STRING "" FORCE)
    set(CMAKE_CXX_COMPILER_TARGET "${SODUWORK_ANDROID_TARGET_TRIPLE}" CACHE STRING "" FORCE)
    set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} --target=${SODUWORK_ANDROID_TARGET_TRIPLE}")
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} --target=${SODUWORK_ANDROID_TARGET_TRIPLE}")
endif()

# No source target is configured, so do not run a compiler/linker probe. NDK r28
# exposes Android linker flags that the host-only CMake probe cannot consume.
set(CMAKE_C_COMPILER_WORKS TRUE CACHE INTERNAL "" FORCE)
set(CMAKE_CXX_COMPILER_WORKS TRUE CACHE INTERNAL "" FORCE)
set(CMAKE_C_COMPILER_ID Clang CACHE INTERNAL "" FORCE)
set(CMAKE_CXX_COMPILER_ID Clang CACHE INTERNAL "" FORCE)
set(CMAKE_C_COMPILER_ID_RUN TRUE CACHE INTERNAL "" FORCE)
set(CMAKE_CXX_COMPILER_ID_RUN TRUE CACHE INTERNAL "" FORCE)
project(soduwork_android_toolchain C CXX)
