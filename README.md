# GPS Device Farm

GPS Device Farm is a minimal Electron desktop application that creates realistic virtual **GT06 GPS trackers** for authorized load testing. Every virtual tracker owns an independent TCP socket, sends a GT06 login packet, waits for the server acknowledgement, then sends heartbeat and location packets like a physical device.

The simulator is designed for tests ranging from a few devices to **20,000 concurrent devices**, subject to the operating system and target server limits described below.

## What is included

- Clean Electron desktop interface with native-style window controls
- Destination host/IP and GT06 TCP port settings
- Sequential IMEIs beginning at `358988888800001`
- Exactly 25% moving devices (rounded up) and 75% parked devices
- Moving location packet every 10 seconds
- Parked location packet every 5 minutes
- Heartbeat packet every 60 seconds
- Persistent TCP connections, login ACK handling and reconnect backoff
- TCP keepalive, `TCP_NODELAY`, connect timeout and login retry handling
- Coherent synthetic loop routes; positions continue from the previous point
- Opt-in real-road playback from validated, checksummed local route packs
- Parked devices at least 50 metres apart on verified city roads, including after checkpoint resume
- Deterministic route allocation, coverage preflight and durable road-position checkpoints
- Fixed positions for parked devices
- Live connection, packet, bandwidth and error metrics
- Collapsible/maximizable terminal panel with bounded UI logs
- Rotating JSON-lines log file
- IMEI export in CSV or JSON format
- JSON settings persistence; no database server is required
- Windows Chromium caches stored separately from settings and route data
- Isolated worker thread so network load cannot freeze the interface
- Automated unit and local TCP integration tests

## Quick start for development

Requirements: Node.js 20 or newer and npm.

```bash
npm install
npm start
```

Run the complete verification suite:

```bash
npm run verify
```

## Real-road mode (opt-in)

The default synthetic mode remains available. Real-road mode uses a separate preparation step to obtain car directions, validates and stores an immutable local route pack, then moves each IMEI along that cached geometry. The worker makes no routing HTTP requests while transmitting GT06 packets. Route assignments and last queued positions are checkpointed every 15 seconds and on clean stop. A crash can replay up to the last durable checkpoint; a GT06 location ACK is needed to know the precise last server-delivered position.

Open **Settings** to choose **Real roads**, define one region from the base coordinate and radius or provide a JSON array of weighted regions, then save. Press **Download and prepare roads** on the main screen. The app finds a covering Geofabrik extract or a set of smaller adjacent extracts, downloads and verifies their OSM data, clips and merges them with bundled Osmium, builds a local Valhalla graph, and saves verified route packs. The first download for a new area requires internet and disk space; later preparation reuses local map data. There is no Docker, Python, Java or separate routing service to install or start. The default diversity gate requires enough distinct closed tours to keep the requested moving population in motion. Unchecking it permits reduced variety and trips that eventually park. Changing a selected pack or scenario seed starts a new road assignment.

Preparation targets about 2,000 verified city and regional routes and saves them in reusable immutable packs. A first build can stop when at least 500 saved routes meet the configured fleet's road-capacity and diversity checks; the user can transmit from that partial library and add more routes later. The 2,000-route count is an expansion goal, not a transmission prerequisite. The screen shows the preparation stage, saved-route progress, attempt budget, and an estimated time once enough work has been measured. The estimate changes with local road coverage. When one set of candidate trips is exhausted, the app generates a new deterministic set; it remembers the planning round and rejected requests across restarts for the same region and road graph. Accepted routes are saved at least every 100 routes or about 30 seconds of accepted work, and on cancellation. Temporary local-router failures receive up to two retries within the attempt budget; deterministic rejections are skipped. After 500 attempts without a new verified route, the app moves to a fresh planning round; it stops only after three consecutive rounds make no progress. Repeating the same search does not restart it. City routes must include measured local-street distance; the 2,000-route goal depends on the OSM graph and active geometry capacity.

The bundled engine is included in the Windows x64 installer. The app limits each source PBF to 8 GiB; large or unmapped regions without a smaller verified cover can still be unavailable. An oversized-source error identifies the selected download and its size. Public demo preparation is disabled in the normal app flow. Details are in [docs/ROAD-MODE.md](docs/ROAD-MODE.md). Map data and derived routes: © OpenStreetMap contributors.

## Building Installers

### Windows Installer

The most reliable way to produce the Windows installer is to run this on Windows:

```powershell
npm install
npm run verify
npm run dist:win
```

The installer is created in `release/` as:
- `GPS-Device-Farm-Setup-1.1.4.exe` - NSIS installer

To create an unpacked portable Windows build instead:

```powershell
npm run pack:win
```

For a supplied portable ZIP, extract the entire folder first and then open `GPS Device Farm.exe`. Do not move the `.exe` away from its accompanying DLL and `resources` files.

**Note:** Development builds are not certificate-signed. Windows SmartScreen may show "Publisher: Unknown". A commercial code-signing certificate should be configured before public distribution.

### macOS Archive

To build the macOS installer (DMG), run on macOS:

```bash
npm install
npm run dist:mac
```

The x64 ZIP archive is created in `release/` as `GPS-Device-Farm-Setup-1.1.4.zip`.

**Note:** For distribution outside the App Store, you need an Apple Developer ID certificate to sign the app. Without signing, users will see Gatekeeper warnings.

### Linux Installers

To build Linux installers, run on Linux or use Docker:

```bash
npm install
npm run dist:linux
```

This creates in `release/`:
- `GPS-Device-Farm-Setup-1.1.4.deb` - Debian/Ubuntu package
- `GPS-Device-Farm-Setup-1.1.4.AppImage` - Universal Linux AppImage

**Installation:**
- **DEB (Ubuntu/Debian):** `sudo dpkg -i GPS-Device-Farm-Setup-1.1.4.deb`
- **AppImage:** Make it executable: `chmod +x GPS-Device-Farm-Setup-1.1.4.AppImage` then run it

### Build All Platforms

To build for all platforms at once (requires appropriate OS or CI/CD):

```bash
npm run dist:all
```

This creates Windows (NSIS), macOS (DMG), and Linux (DEB + AppImage) installers.

## Using the application

1. Open **Settings** and enter the authorized GPS listener host/IP and GT06 port.
2. Choose the number of devices on the main screen.
3. Select **Export IMEIs** if those devices must be registered in the GPS platform first.
4. Register/import the exported IMEIs in the target GPS software.
5. Select **Start transmission**.
6. Watch **Online** rather than only **TCP connected**. A device becomes Online only after a valid GT06 login ACK is received.
7. Select **Stop** to close all virtual device sockets gracefully.

Only run load tests against infrastructure you own or are explicitly authorized to test.

## Simulation behavior

| Behavior | Value |
|---|---:|
| Protocol | GT06 over TCP |
| First IMEI | `358988888800001` |
| Moving population | `ceil(total × 25%)` |
| Moving location interval | 10 seconds |
| Parked location interval | 5 minutes |
| Heartbeat interval | 60 seconds |
| Login acknowledgement timeout | 5 seconds |
| Login attempts per connection | 3 |
| Reconnect delay | Exponential, jittered, 1–30 seconds |
| Default connection ramp | 250 connections/second |

The GT06 packet format follows the supplied OpenVTS sender reference: short `0x7878` frames, BCD IMEI login, CRC-16/ITU, classic `0x12` location packets and `0x13` heartbeat packets.

## Important 20,000-device operating-system limits

Twenty thousand persistent virtual devices means twenty thousand real outbound TCP sockets. Application code cannot bypass the client operating system's open-file and ephemeral-port limits.

### Windows

Run the following in an elevated terminal to inspect the current dynamic TCP range:

```powershell
netsh int ipv4 show dynamicport tcp
```

The default Windows dynamic range may be smaller than 20,000 ports. On a dedicated load-test machine, an administrator can enlarge it after reviewing local policy:

```powershell
netsh int ipv4 set dynamicport tcp start=10000 num=55535
```

Restarting a very large test immediately can also encounter sockets in `TIME_WAIT`. Allow the operating system time to release them.

### Linux

Inspect and raise the open-file limit before a large test:

```bash
ulimit -n
ulimit -n 65535
```

Also verify `net.ipv4.ip_local_port_range` provides enough client ports.

### Target server

The target GPS listener must independently support the requested number of sockets, login packets and sustained packet rate. Start with 100 devices, then ramp through 1,000, 5,000, 10,000 and 20,000 while watching listener CPU, memory, event-loop delay, Redis/database queues and socket errors.

## Data storage

SQLite is intentionally not used because this application has no relational-data requirement. Settings are stored in a small JSON file and logs are JSON Lines (`.jsonl`). This keeps installation minimal and avoids database locks during high-load simulation.

On Windows, application data is stored under the Electron user-data directory, normally:

```text
%APPDATA%\GPS Device Farm\
```

## Architecture

```text
Electron renderer (UI)
        │ secure IPC
Electron main process ── JSON settings + rotating JSONL logs
        │ worker messages
Simulation worker
        ├── one shared min-heap scheduler
        ├── N independent GT06 state machines
        └── N persistent TCP sockets
```

No per-device interval is created. A single scheduler services only devices whose next action is due, which keeps timer and CPU overhead predictable at large device counts.

## Troubleshooting

- **TCP Connected increases but Online remains zero:** the listener is not acknowledging the GT06 login, the IMEIs are not registered, or the selected port is not GT06.
- **`ECONNREFUSED`:** the host/port is unreachable or the listener is not running.
- **Connections stop around a fixed number:** inspect client ephemeral ports, open-file limits and listener socket limits.
- **High UI log volume:** keep log detail at Summary for large tests. Detailed per-device output is intentionally sampled.
- **Position not visible:** confirm the target decoder accepts classic GT06 `0x12` location frames and that the exported IMEIs were registered.
