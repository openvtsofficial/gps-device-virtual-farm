# Bundled Valhalla Windows runtime

The files in `runtime/` were extracted from the official `pyvalhalla` 3.9.1
Windows x64 wheel, published by the Valhalla project on 2026-10-06:

- Source: <https://pypi.org/project/pyvalhalla/3.9.1/>
- Wheel: `pyvalhalla-3.9.1-cp312-abi3-win_amd64.whl`
- Wheel SHA-256: `542ea3e11da281c63f2043fa69a2f426c5b309cb1e3b0032028f7034847d1c13`
- Upstream source: <https://github.com/valhalla/valhalla>
- Valhalla license: MIT; retain `runtime/pyvalhalla-3.9.1.dist-info/licenses/COPYING`

The plain-name Microsoft Visual C++ runtime DLLs beside the three native EXEs
come from this machine's licensed Visual Studio Community 18 redistribution
folder, `VC/Redist/MSVC/14.51.36231/x64/Microsoft.VC145.CRT`. They are included
app-locally so a clean Windows machine does not need to install a separate VC++
Redistributable package. Their redistribution is subject to the Visual Studio
license terms and [Microsoft's redistribution guidance](https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files?view=msvc-170).

The native `.exe` files under `runtime/valhalla/bin` run directly; the user
does not need Python, Docker, Java, or a system Valhalla installation. A child
process must prepend `runtime/pyvalhalla.libs` to its `PATH` so Windows can find
the wheel's DLLs. The app keeps the OSM extract and generated graph under its
per-user data directory. `src/road/valhalla-config-template.json` was generated
once from this wheel's upstream configuration script and has path placeholders
which the app must replace before building or querying a graph.

Native commands validated on Windows x64 with a Geofabrik Andorra extract:

```text
valhalla_build_admins.exe -c <config.json> <extract.osm.pbf>
valhalla_build_tiles.exe -c <config.json> <extract.osm.pbf>
valhalla_service.exe <config.json> route <request.json>
valhalla_service.exe <config.json> trace_attributes <request.json>
```

The `valhalla_service.exe <config.json> 1` HTTP mode also responded on
`127.0.0.1:8002` in this wheel. This prototype does not establish performance
or graph-build resource requirements for a large region. The wheel vendors
third-party native DLLs; review their individual notices when distributing the
installer. OSM extracts and any redistributed graphs have separate ODbL and
attribution requirements: <https://www.openstreetmap.org/copyright>.
