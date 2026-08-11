# Tripper ESP32-S3 Firmware - Arduino Setup Guide

## Hardware

- **Board:** Waveshare ESP32-S3-Touch-LCD-2 (ST7789 240x320)
- **Display:** 2-inch IPS LCD (ST7789 driver, SPI)
- **IMU:** QMI8658 (I2C)
- **GPS:** NEO-7M (UART)

---

## Arduino IDE Setup

### 1. Install Arduino IDE

Download from https://www.arduino.cc/en/software (v2.x recommended)

### 2. Add ESP32 Board Package

1. Open **File → Preferences**
2. In **Additional Board Manager URLs**, add:
   ```
   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   ```
3. Click **OK**
4. Open **Tools → Board → Boards Manager**
5. Search for **esp32** and install **"esp32 by Espressif Systems"** (v2.0.x or v3.x)

### 3. Select Board Settings

Go to **Tools** menu and set:

| Setting | Value |
|---------|-------|
| **Board** | ESP32S3 Dev Module |
| **USB CDC On Boot** | Enabled |
| **CPU Frequency** | 240MHz (WiFi) |
| **Core Debug Level** | None |
| **USB DFU On Boot** | Disabled |
| **Erase All Flash** | Disabled |
| **Events Run On** | Core 1 |
| **Flash Mode** | QIO 80MHz |
| **Flash Size** | 16MB (128Mb) |
| **JTAG Adapter** | Disabled |
| **Arduino Runs On** | Core 1 |
| **USB Firmware MSC On Boot** | Disabled |
| **Partition Scheme** | 16M Flash (3MB APP/9.9MB FATFS) |
| **PSRAM** | OPI PSRAM |
| **Upload Mode** | UART0 / Hardware CDC |
| **Upload Speed** | 921600 |
| **USB Mode** | Hardware CDC and JTAG |
| **Port** | (select your device's port) |

> **Note:** If your board has 8MB flash instead of 16MB, select `8MB` flash size and a matching partition scheme.

### 4. Install Required Libraries

Open **Sketch → Include Library → Manage Libraries** and install:

| Library | Version | Purpose |
|---------|---------|---------|
| **Arduino_GFX_Library** | ≥ 1.4.0 | Display driver (ST7789) |
| **WebSockets** | ≥ 2.4.0 | WebSocket client (by Markus Sattler) |
| **ArduinoJson** | ≥ 7.0.0 | JSON parsing for server messages |

> The following are built-in with ESP32 board package (no separate install needed):
> - WiFi
> - WebServer
> - DNSServer
> - Preferences
> - Wire
> - SPI

### 5. Library Installation (Alternative - ZIP)

If a library isn't found in the manager:

1. Download the `.zip` from GitHub
2. **Sketch → Include Library → Add .ZIP Library**

Library GitHub links:
- Arduino_GFX: https://github.com/moononournation/Arduino_GFX
- WebSockets: https://github.com/Links2004/arduinoWebSockets
- ArduinoJson: https://github.com/bblanchon/ArduinoJson

---

## Project Files

```
2inchS3display/
├── 2inchS3display.ino      # Main sketch (entry point)
├── config.h                 # Pin definitions & constants
├── sensors.h                # IMU & GPS drivers
├── wifi_provision.h         # WiFi AP provisioning & credential storage
├── web_portal.h             # Captive portal HTML
├── ui_screens.h             # Splash, provisioning, connecting screens
├── dashboard.h              # Main dashboard rendering
├── splash_image.h           # Splash screen bitmap
├── bike_image.h             # Motorcycle bitmap
├── server_connection.h      # WebSocket client to navigation server (NEW)
└── nav_display.h            # Turn-by-turn navigation display (NEW)
```

---

## Server Connection Configuration

Before flashing, update the server IP in `server_connection.h`:

```cpp
#define SERVER_HOST       "192.168.43.1"  // Your phone hotspot IP or server IP
#define SERVER_PORT       3001
```

**Finding your server IP:**
- If running server on the same phone that provides the hotspot: usually `192.168.43.1`
- If running on a laptop connected to the hotspot: check with `ifconfig` / `ipconfig`
- Update `SERVER_HOST` to match

---

## Flashing

1. Connect the ESP32-S3 board via USB-C
2. Select the correct **Port** in Tools menu
3. Click **Upload** (→ button)
4. Wait for compilation and upload to complete
5. Open **Serial Monitor** at 115200 baud to see debug output

### First Boot

On first boot (or after erasing flash):
1. Device shows splash screen with loading bar (10 seconds)
2. Enters WiFi provisioning mode (AP: `Tripper-Setup` / Password: `tripper123`)
3. Connect your phone to this AP
4. Open browser → `192.168.4.1`
5. Enter your mobile hotspot SSID and password
6. Device stores credentials and enters dashboard

### Subsequent Boots

1. Splash screen shows for 10 seconds with a progress bar
2. During this window, the reset AP is active (see below)
3. After 10s → attempts stored WiFi → enters dashboard
4. If WiFi fails, dashboard still loads (retries every 5s in background)
5. Once WiFi connects, server connection starts automatically in background
6. Navigation starts only when commanded from the mobile app

### Factory Reset (Change WiFi Credentials)

If you need to change the stored WiFi credentials:

1. Power on / restart the ESP32
2. While the **splash screen + loading bar** is showing (first 10 seconds), connect any phone/laptop to the AP:
   - **SSID:** `Tripper-Setup`
   - **Password:** `tripper123`
3. The moment a device pairs, the screen shows **"RESETTING..."**
4. All stored credentials are erased and the device restarts
5. On next boot it will enter provisioning mode where you can set new WiFi credentials

> **Note:** You only have the 10-second splash window to trigger the reset. After that, the AP shuts down and normal operation begins.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Upload fails | Hold BOOT button while pressing RST, then upload |
| Display blank after flash | Check LCD_BL pin, verify SPI pins in config.h |
| WiFi won't connect | Erase flash (Tools → Erase All Flash → Enabled), re-upload, reconfigure |
| Server won't connect | Verify SERVER_HOST IP, ensure server is running on port 3001 |
| Compilation error: WebSockets | Install "WebSockets by Markus Sattler" (not other websocket libs) |
| Compilation error: ArduinoJson | Ensure v7+ is installed (v6 has different API) |

---

## Memory Notes

- The splash image and bike image consume ~154KB of flash (stored in PROGMEM)
- Navigation chunks are processed one at a time (never loaded all at once)
- PSRAM is available for additional buffering if needed
- The WebSocket client uses ~2-4KB RAM during operation
