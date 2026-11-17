# Tripper ESP32-S3 Firmware

Motorcycle HUD firmware for the Waveshare ESP32-S3-Touch-LCD-2. Displays real-time telemetry (GPS, IMU, altitude, air quality) on a 2-inch IPS display and provides turn-by-turn navigation driven by the Trip Pilot server.

## Hardware

| Component | Model | Interface |
|-----------|-------|-----------|
| Board | Waveshare ESP32-S3-Touch-LCD-2 | — |
| Display | 2" IPS LCD (320×240) | SPI (ST7789) |
| IMU | QMI8658 | I2C |
| GPS | NEO-7M | UART |

## Boot Flow

```
Power On → Splash (3 seconds, factory-reset window)
    │
    ├── Has WiFi credentials + Device paired?
    │       → Dashboard (normal operation)
    │
    ├── No WiFi credentials?
    │       → WiFi Setup Screen
    │         (Shows AP name, password, URL, step-by-step instructions)
    │         → User connects phone, enters hotspot creds via portal
    │         → WiFi connects
    │         → Pairing Screen (QR code + 8-digit code)
    │         → User pairs in app
    │         → Dashboard
    │
    └── Has WiFi but not paired?
            → Pairing Screen (QR code + 8-digit code)
            → User pairs in app
            → Dashboard
```

## Device Identity & Pairing

- **Device ID**: Auto-generated from the ESP32's MAC address as `TRIP-XXXXXXXX`
- **Pairing Code**: 8-digit numeric code assigned by the server
- **QR Code**: Encodes `tripper://pair/<8-digit-code>` for scanning in the app
- **NVS Storage**: Pairing state and WiFi credentials stored in non-volatile flash

### Pairing Protocol (WebSocket)

1. ESP connects to server via WebSocket at `ws://<SERVER_HOST>:<PORT>/device`
2. Sends `DEVICE_REGISTER` with its unique device ID
3. Server responds with `PAIRING_CODE` (8-digit code)
4. ESP displays QR + code on screen
5. User enters code in the Trip Pilot app
6. Server sends `DEVICE_PAIRED` → ESP saves state, proceeds to dashboard

### Unpair (Remote Factory Reset)

When the user unpairs from the app:
- **Device online**: Server sends `DEVICE_UNPAIRED` → ESP clears WiFi + pairing state → restarts
- **Device offline**: Next time it connects and sends `DEVICE_IDENTIFY`, server checks DB, finds `paired=false`, sends `DEVICE_UNPAIRED` → same reset

### Manual Factory Reset

During the 3-second splash screen, a hidden AP (`Tripper-Setup`) is active. Connect any device to it and the ESP will erase all stored credentials and restart fresh.

## Configuration

Edit `server_connection.h` before flashing:

```cpp
#define SERVER_HOST       "192.168.100.100"  // Your server IP
#define SERVER_PORT       3001               // Server port
#define SERVER_WS_PATH    "/device"          // WebSocket path
```

Edit `config.h` for WiFi AP credentials (used during setup):

```cpp
#define AP_SSID           "Tripper-Setup"
#define AP_PASS           "tripper123"
```

## Arduino IDE Setup

### Board Package

1. **File → Preferences → Additional Board Manager URLs**:
   ```
   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   ```
2. **Tools → Board → Boards Manager** → Install "esp32 by Espressif Systems" (v2.0.x)

### Board Settings

| Setting | Value |
|---------|-------|
| Board | ESP32S3 Dev Module |
| USB CDC On Boot | Enabled |
| CPU Frequency | 240MHz (WiFi) |
| Flash Mode | QIO 80MHz |
| Flash Size | 16MB (128Mb) |
| Partition Scheme | 16M Flash (3MB APP/9.9MB FATFS) |
| PSRAM | OPI PSRAM |
| Upload Mode | UART0 / Hardware CDC |
| Upload Speed | 921600 |
| USB Mode | Hardware CDC and JTAG |

### Required Libraries

Install via **Sketch → Include Library → Manage Libraries**:

| Library | Version | Purpose |
|---------|---------|---------|
| Arduino_GFX_Library | ≥ 1.4.0 | Display driver (ST7789) |
| WebSockets | ≥ 2.4.0 | WebSocket client (by Markus Sattler) |
| ArduinoJson | ≥ 7.0.0 | JSON parsing |
| QRCode | ≥ 0.0.1 | QR code generation (by Richard Moore) |

> **Note**: The QRCode library conflicts with ESP-IDF's built-in `qrcode.h`. The project includes `qrcode_ricmoo.h` and `qrcode_ricmoo.cpp` (renamed copies) to avoid this conflict. Do NOT delete these files.

Built-in (no install needed): WiFi, WebServer, DNSServer, Preferences, Wire, SPI, FS, SD

## Project Files

```
2inchS3display/
├── 2inchS3display.ino       # Main sketch (state machine: splash → wifi → pair → dashboard)
├── config.h                  # Pin definitions, colors, layout constants
├── device_pairing.h          # Device ID generation, QR display, pairing screens
├── server_connection.h       # WebSocket client, nav chunk handling, unpair detection
├── wifi_provision.h          # WiFi AP+STA concurrent mode, credential storage
├── web_portal.h              # Captive portal HTML for WiFi config
├── ui_screens.h              # WiFi setup, connecting, connected screens
├── dashboard.h               # Main telemetry dashboard rendering
├── nav_display.h             # Turn-by-turn navigation display
├── sensors.h                 # IMU & GPS drivers (+ GPS UTC date/time from RMC)
├── trip_saver.h              # Automatic ride logger (GPX → microSD)
├── air_quality.h             # Air quality API integration
├── qrcode_ricmoo.h           # QR code library (renamed to avoid ESP-IDF conflict)
├── qrcode_ricmoo.cpp         # QR code library implementation
├── splash_image.h            # Splash screen bitmap (PROGMEM)
├── dashboard_bg.h            # Dashboard background bitmap (PROGMEM)
├── nav_arrow.h               # 3D navigation arrow bitmap
├── signal_on.h               # Server connected icon (transparent)
├── signal_off.h              # Server disconnected icon (transparent)
├── Inter_Black_16pt.h        # Font: Inter Black 16pt
├── Inter_Black12pt.h         # Font: Inter Black 12pt
├── Inter_Black8pt.h          # Font: Inter Black 8pt
└── convert_icon_transparent.py # Tool: Convert PNG to transparent RGB565 header
```

## Dashboard Features

- **GPS**: Speed, distance, heading, altitude, satellite count
- **IMU**: Pitch/roll from complementary filter (QMI8658)
- **Air Quality**: AQI, UV index (fetched from API every 10 min)
- **Temperature**: ESP32 internal sensor
- **Server Status**: Signal icon (on/off) based on WebSocket connection
- **GPS Strength**: 4 orange dots (top-right corner) based on satellite count
- **Navigation**: Smooth interpolated path rendering when route is active

## Automatic Trip Saver (GPX logging to microSD)

The firmware records every ride automatically to the onboard microSD/TF card as
a standard **GPX 1.1** track — no "start trip" button. Tracking begins the
moment real GPS movement is detected and finalises automatically when the bike
has been stopped long enough. It runs entirely in the background from the main
loop and never blocks the display, GPS, navigation, or server communication.

### How it works

- **Auto start**: when there is a GPS fix, a valid UTC time (from the GPS RMC
  sentence), and ground speed ≥ `TRIP_MOVE_SPEED_KMH`, a new file is opened and
  the starting position is logged.
- **RAM buffering + batch writes**: points are collected in a small RAM buffer
  and *batch-appended* to the card about every `TRIP_FLUSH_INTERVAL_MS` (default
  30 s), or sooner if the buffer fills. This keeps card wear to a handful of
  writes per ride instead of one write per GPS fix.
- **Simplification / filtering**: a new point is only recorded once the bike has
  moved at least `TRIP_MIN_MOVE_METERS` from the last recorded point and at most
  once per `TRIP_MIN_POINT_INTERVAL_MS`. Implausible GPS jumps larger than
  `TRIP_MAX_JUMP_METERS` are rejected so they don't corrupt the distance total.
- **Auto stop**: after `TRIP_INACTIVITY_TIMEOUT_MS` (default 2 min) with no
  movement, the remaining buffer is flushed, a summary is written, and the file
  is closed.

### Files & format

- One file per ride under `/TRIPS/`, named from the ride start time (UTC):
  `/TRIPS/YYYY-MM-DD_HH-MM-SS.gpx`.
- Each file is valid GPX with `<metadata><time>` (start), a `<trk>/<trkseg>` of
  `<trkpt>` points carrying latitude, longitude, `<ele>` (altitude), `<time>`
  (ISO-8601 UTC), and a `<speed>` extension (m/s).
- On finalise a trailing XML comment records the summary:
  `start`, `end`, `duration` (s), `distance` (km), and `points`. Start/end times,
  duration, and distance are therefore all recoverable from the file.

### Power-cut & reset safety

- Writes are **append-only** and the file is flushed and closed after every
  batch, so a sudden power loss discards at most the last un-flushed batch
  (≤ `TRIP_FLUSH_INTERVAL_MS` of data) — never the whole ride.
- The active filename and running totals are mirrored in NVS. On the next boot
  `tripSaverInit()` detects an interrupted ride and **finalises** it (appends the
  GPX closing tags and a recovered summary) instead of leaving a corrupt or
  unterminated file.
- If the card is missing or the SD pins are wrong, the feature disables itself
  silently and the rest of the firmware is unaffected.

### ⚠️ Verify the SD card pins before flashing

This board mounts its TF card over SPI, but the exact GPIOs are not published in
plain form on the Waveshare wiki (the demo hides them behind macros in its
`pin_config.h`). The defaults in `config.h` are **placeholders** and must be
confirmed against the Waveshare `03_sd_card_test` demo or the board schematic:

```cpp
#define TRIP_SD_SCLK_PIN  14   // <-- VERIFY (SD CLK / SCK)
#define TRIP_SD_MOSI_PIN  17   // <-- VERIFY (SD CMD / DI / MOSI)
#define TRIP_SD_MISO_PIN  16   // <-- VERIFY (SD DAT0 / DO / MISO)
#define TRIP_SD_CS_PIN    21   // <-- VERIFY (SD DAT3 / CS)
```

The Trip Saver uses a **dedicated HSPI bus**, so it never shares the ST7789
display's SPI bus. If your board wires the card onto the display's data pins,
set these to those pins accordingly.

### Configuration (all in `config.h`)

| Define | Default | Purpose |
|--------|---------|---------|
| `TRIP_SAVER_ENABLED` | `1` | Set to `0` to compile the feature out |
| `TRIP_DIR` | `"/TRIPS"` | Directory for ride files |
| `TRIP_FLUSH_INTERVAL_MS` | `30000` | Batch-write interval |
| `TRIP_MAX_BUFFER_POINTS` | `64` | RAM buffer size (forces a flush when full) |
| `TRIP_MIN_POINT_INTERVAL_MS` | `1000` | Minimum spacing between recorded points |
| `TRIP_MOVE_SPEED_KMH` | `3.0` | Speed considered "moving" (start/keep-alive) |
| `TRIP_MIN_MOVE_METERS` | `6.0` | Minimum movement to record a new point |
| `TRIP_MAX_JUMP_METERS` | `500.0` | Reject GPS glitches larger than this |
| `TRIP_INACTIVITY_TIMEOUT_MS` | `120000` | Idle time before a ride auto-finalises |
| `TRIP_SD_*_PIN`, `TRIP_SD_FREQ_HZ` | see above | microSD SPI pins & clock |

## Icon Conversion Tool

To convert a PNG with transparency to a display-compatible header file:

```bash
python3 convert_icon_transparent.py
# Enter filename when prompted, e.g.: signal_on.png
# Output: signal_on_2.h
```

The converter uses an alpha threshold (default 128) to produce clean color-key transparency (`0x0000` = transparent). The display's `drawIconOverBackground()` function composites these over the dashboard background.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Upload fails | Hold BOOT button while pressing RST, then upload |
| Display blank | Check LCD_BL pin (GPIO 1), verify SPI pins in config.h |
| WiFi won't connect | Factory reset (connect to AP during splash), reconfigure |
| Server won't connect | Verify SERVER_HOST IP in server_connection.h |
| QR code compile error | Ensure `qrcode_ricmoo.h` and `.cpp` are in the sketch folder |
| "DEVICE_UNPAIRED" loop | Device was unpaired in app; re-pair via the app |
| Black box around icons | Re-run convert_icon_transparent.py with alpha_threshold=128 |

## Memory Usage

- Splash + dashboard background images: ~300KB flash (PROGMEM)
- Navigation off-screen canvas: ~150KB PSRAM (allocated only during nav mode)
- WebSocket client: ~2-4KB RAM
- QR code generation: ~800 bytes stack (temporary)
