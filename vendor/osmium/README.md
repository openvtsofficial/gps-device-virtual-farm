# Bundled Osmium Tool (Windows x64)

The desktop installer includes this command-line tool to cut downloaded
OpenStreetMap PBF extracts to the configured road region before Valhalla builds
its local graph. The app invokes `runtime/osmium.exe` itself; users do not need
to install Osmium, Conda, or another program.

## Version and provenance

`runtime/osmium.exe` is Osmium Tool 1.19.1 (libosmium 2.23.1), extracted from
the [conda-forge Windows x64 package](https://anaconda.org/conda-forge/osmium-tool/files)
`osmium-tool-1.19.1-h60971b7_0.conda` (SHA-256
`cbac55c919fdc8189fc25ea2c7dead293f587200d04e3cb4b7b5b8ecd0f835b0`).
The following exact conda-forge dependency packages supplied the DLLs copied
beside it:

| Runtime file | Package | Package SHA-256 |
| --- | --- | --- |
| `boost_program_options.dll` | `libboost-1.90.0-h9dfe17d_3.conda` | `e82a6fdfc93a7fa72b188ba2bcc0f740d564cf742c001d2b58f15f1c6e0e6437` |
| `libexpat.dll` | `libexpat-2.8.1-hac47afa_1.conda` | `1a54d874addda73b6f7164d5f3905821277a1831bcc05edd74b3085391688571` |
| `lz4.dll` | `lz4-c-1.10.0-h6a83c73_2.conda` | `6824e36be0f95ae516dc36dddd18f69cbad0e4e07906fcb10a5f26a8dc471903` |
| `libbz2.dll` | `bzip2-1.0.8-h0ad9c76_10.conda` | `04767466ee9227c9c57ab2c6503e0149177d34111c7418d2f420297acb1eb229` |
| `zlib.dll` | `libzlib-1.3.2-hfd05255_3.conda` | `0629c2cc0404d3bb29d6baa7b4ba62da80797015e86de050db81ea5a07050527` |
| `msvcp140.dll`, `vcruntime140.dll`, `vcruntime140_1.dll` | `vc14_runtime-14.44.35208-h818238b_41.conda` | `ec706fe9368b837fbd05af4851f5ebef12bef8c471a273f4805f7af788407317` |

All non-Windows DLL imports of these nine files resolve within `runtime/`.
The remaining imports are Windows system DLLs and Universal C Runtime API
sets supplied by supported Windows versions. The nine runtime files total
3,046,640 bytes. See `SHA256SUMS` for their individual checksums.

## Corresponding source and licenses

Osmium Tool is licensed under GPL-3.0-only. `COPYING` is the unmodified GPL
version 3 text from its binary package. The exact upstream source archive,
`source/osmium-tool-v1.19.1.tar.gz` (SHA-256
`e629d2f3e500ffa5df6f1b1689161ab3dea3a82f66beec2b453a74b8d782f949`),
is included here, along with the conda-forge recipe, its rendered form,
Windows build script, and build variant settings that accompanied the binary
package. The recipe used no patches. The original source is also available at
the [upstream v1.19.1 tag](https://github.com/osmcode/osmium-tool/releases/tag/v1.19.1),
and the [conda-forge feedstock](https://github.com/conda-forge/osmium-tool-feedstock)
documents the build. The source archive and recipe are shipped with the app
so availability does not depend on those links.

The license texts for the bundled Boost, bzip2, Expat, LZ4, zlib, and
Microsoft VC runtime DLLs are in `licenses/`. The Microsoft RTF is the
authoritative version; the TXT is the package's convenience conversion.
These components are distributed as separate binaries next to Osmium.

To reproduce the Osmium build on Windows x64, unpack the included source
archive, install the build dependencies listed in
`source/conda-forge-recipe.yaml` into a conda-forge build environment, and run
the steps from `source/conda-forge-build.bat`. The core steps are:

```powershell
tar -xf source/osmium-tool-v1.19.1.tar.gz
cd osmium-tool-1.19.1
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release "-DCMAKE_INSTALL_PREFIX=$env:CONDA_PREFIX\Library"
cmake --build build --target all
cmake --build build --target install
```

The included build variant file pins the Windows x64 compiler and key library
versions used by conda-forge. Its recipe lists CMake, Ninja, libosmium,
Protozero, Boost, Expat, LZ4, bzip2, zlib, and JSON headers. To run the
complete conda-forge recipe, copy `conda-forge-recipe.yaml` and
`conda-forge-build.bat` to a build directory as `recipe.yaml` and `build.bat`,
then invoke `rattler-build build --recipe recipe.yaml --variant-config
conda-forge-variant-config.yaml --channel conda-forge` there. The recipe's
source URL may be changed to the included archive path; retain its SHA-256.

## Verified command

The app should launch `runtime/osmium.exe` with an argument array equivalent
to:

```text
osmium.exe extract --bbox LEFT,BOTTOM,RIGHT,TOP --strategy complete_ways --set-bounds input.osm.pbf --output clipped.osm.pbf
```

`complete_ways` preserves all nodes of every crossing way. A verified
Geofabrik Andorra PBF clipped to `1.45,42.45,1.60,42.56` produced a valid PBF
with zero missing way nodes; Valhalla 3.9.1 built a routable graph from it.
The [Osmium extract manual](https://docs.osmcode.org/osmium/latest/osmium-extract.html)
documents the strategy and its memory use. On large source extracts, clipping
can require several gigabytes of RAM, so the application must surface a clear
resource error if the child process cannot complete.
