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

Built-in (no install needed): WiFi, WebServer, DNSServer, Preferences, Wire, SPI

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
├── sensors.h                 # IMU & GPS drivers
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
