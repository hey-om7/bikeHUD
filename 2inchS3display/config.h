/*
 * config.h - Pin definitions, constants, and color palette
 * Tripper Telemetry Dashboard V5
 */
#ifndef CONFIG_H
#define CONFIG_H

#include <Arduino.h>

// ===== Display Pin Definitions =====
#define LCD_SCLK  39
#define LCD_MOSI  38
#define LCD_MISO  40
#define LCD_DC    42
#define LCD_CS    45
#define LCD_RST   -1
#define LCD_BL     1

// ===== I2C Pins (QMI8658 IMU + CST816D Touch - shared bus) =====
#define I2C_SDA    48
#define I2C_SCL    47

// ===== GPS UART Pins (NEO-7M) =====
#define GPS_RX_PIN 13
#define GPS_TX_PIN 15

// ===== QMI8658 IMU Registers =====
#define QMI8658_ADDR      0x6B
#define QMI8658_WHO_AM_I  0x00
#define QMI8658_CTRL1     0x02
#define QMI8658_CTRL2     0x03
#define QMI8658_CTRL3     0x04
#define QMI8658_CTRL5     0x06
#define QMI8658_CTRL7     0x08
#define QMI8658_AX_L      0x35
#define QMI8658_GX_L      0x3B
#define QMI8658_CHIP_ID   0x05

// ===== WiFi Provisioning =====
#define AP_SSID           "Tripper-Setup"
#define AP_PASS           "tripper123"
#define AP_PORTAL_IP      "192.168.4.1"

// ===== A-GPS (AssistNow Online) =====
// The NEO-7M is a u-blox generation-7 receiver, so it uses the LEGACY UBX-AID
// assistance protocol (NOT UBX-MGA, which is gen-8+). We therefore request
// AssistNow Online with format=aid.
//
// A free AssistNow token is required. Create one at https://thingstream.io
// (Location Services -> AssistNow) and paste it below. Leave empty to disable
// A-GPS entirely (the module then falls back to a normal cold start).
#define AGPS_TOKEN        "a2ba48d9-317b-4e7b-9044-7baf221c17fd"   // <-- paste your AssistNow token here

// AssistNow Online host + path. datatype=eph keeps the payload small so it
// transfers quickly over the 9600-baud UART (each extra datatype costs ~1s of
// UART time at 9600). Add alm/aux only if you raise the GPS baud rate.
#define AGPS_HOST         "online-live1.services.u-blox.com"
#define AGPS_PATH         "/GetOnlineData.ashx"

// How often (ms) a fresh download is allowed. Broadcast ephemeris is valid for
// ~2-4h; re-downloading more often than this is wasteful.
#define AGPS_REFRESH_MS   (90UL * 60UL * 1000UL)   // 90 minutes

// GPS time is ahead of UTC by the current number of leap seconds. As of 2017
// this is 18 and there have been no leap seconds since. Update if that changes.
#define GPS_UTC_LEAP_SECS 18

// ===== Muted Gray Color Palette (RGB565) =====
#define COL_BG_DARK       0x9CD3  // #9A9C9A - darker gray background (top)
#define COL_BG_MID        0x8C71  // #8C8E8C - slightly darker (bottom)
#define COL_BG_LIGHT      0x8410  // #848484 - darkest accent
#define COL_PANEL         0xD69A  // #D4D4D0 - muted grayish tile panels
#define COL_PANEL_LIGHT   0xCE59  // #CCCCC8 - slightly darker panel area
#define COL_BORDER        0xA514  // #A4A4A0 - subtle borders
#define COL_BORDER_DIM    0xB596  // #B4B4B0 - very subtle border

// Text colors
#define COL_WHITE         0xFFFF
#define COL_GRAY_LIGHT    0x6B4D  // #6B6B6B
#define COL_GRAY_MID      0x528A  // #525252
#define COL_GRAY_DIM      0x8410  // #808080
#define COL_BLACK         0x0000
#define COL_TEXT_DARK     0x1082  // #101010
#define COL_TEXT_MID      0x3186  // #303030

// Accent colors
#define COL_GREEN         0x2F06  // #2BE030
#define COL_GREEN_DIM     0x1B62  // #1A6E12
#define COL_BLUE          0x2D7F  // #2DAFFF
#define COL_BLUE_DIM      0x1A4E  // #1A4A70
#define COL_ORANGE        0xFC60  // #FF8C00
#define COL_ORANGE_DIM    0x8320  // #834500
#define COL_RED           0xD800  // #D80000
#define COL_AMBER         0xFDA0  // #FFB400

// Gauge specific
#define COL_NEEDLE_RED    0xF800
#define COL_NEEDLE_WHITE  0x3186
#define COL_TICK_BRIGHT   0x3186
#define COL_TICK_DIM      0x7BCF
#define COL_RING_METAL    0x528A
#define COL_GAUGE_BG      0xCE59

// ===== Layout Constants =====
#define SCREEN_W          320
#define SCREEN_H          240

// Status bar
#define SBAR_Y            2
#define SBAR_H            22
#define SBAR_CAPSULE_H    20
#define SBAR_CAPSULE_R    4

// Compass panel (upper-left)
#define COMP_X            2
#define COMP_Y            25
#define COMP_W            126
#define COMP_H            104
#define COMP_CX           65
#define COMP_CY           77
#define COMP_R            40

// Incline + Motorcycle panel (lower-left)
#define INCL_X            2
#define INCL_Y            131
#define INCL_W            126
#define INCL_H            107
#define INCL_CX           65
#define INCL_CY           188
#define INCL_R            38

// Center information area
#define CTR_X             130
#define CTR_Y             25
#define CTR_W             166
#define CTR_H             213

// Elevation strip (extreme right edge)
#define ELEV_X            298
#define ELEV_Y            2
#define ELEV_W            20
#define ELEV_H            236

#define DEG2RAD 0.0174532925f
#define RAD2DEG 57.29577951f
#define MAX_ALTITUDE      2500.0f

// ===========================================================================
//  Trip Saver (automatic ride logging to microSD)
// ===========================================================================
// Records the ride as a GPX track to the onboard TF/microSD card. Tracking
// starts automatically the moment real GPS movement is detected (no manual
// "start trip"), points are buffered in RAM and batch-appended to the card
// roughly every TRIP_FLUSH_INTERVAL_MS to minimise flash wear, and the trip is
// finalised automatically after TRIP_INACTIVITY_TIMEOUT_MS of no movement.
//
// Set TRIP_SAVER_ENABLED to 0 to compile the feature out entirely.
#define TRIP_SAVER_ENABLED        1

// ---- microSD SPI pins ------------------------------------------------------
// !!! IMPORTANT — VERIFY THESE AGAINST YOUR BOARD BEFORE FLASHING !!!
// The ESP32-S3-Touch-LCD-2 mounts its TF card over SPI (Waveshare demo
// "03_sd_card_test": SPI.begin(sck, miso, mosi, cs); SD.begin(cs);). The exact
// GPIOs are defined behind macros in that demo's pin_config.h — open it (or the
// board schematic) and copy the real numbers here. The Trip Saver uses a
// DEDICATED SPI bus (HSPI) so it never touches the ST7789 display bus.
//
// If these pins are wrong the card simply fails to mount and the Trip Saver
// disables itself silently — the display, GPS, navigation and server keep
// working normally. Nothing else in the firmware depends on the SD card.
#define TRIP_SD_SCLK_PIN          14   // <-- VERIFY (SD CLK / SCK)
#define TRIP_SD_MOSI_PIN          17   // <-- VERIFY (SD CMD / DI / MOSI)
#define TRIP_SD_MISO_PIN          16   // <-- VERIFY (SD DAT0 / DO / MISO)
#define TRIP_SD_CS_PIN            21   // <-- VERIFY (SD DAT3 / CS)
#define TRIP_SD_FREQ_HZ           20000000UL  // 20 MHz SPI clock for the card

// ---- Storage layout --------------------------------------------------------
#define TRIP_DIR                  "/TRIPS"     // one .gpx file per ride lives here

// ---- Timing / batching -----------------------------------------------------
// How often the RAM buffer is flushed (appended) to the card. Larger = less
// wear but more data lost on an un-recovered power cut (recovery still saves
// everything already flushed).
#define TRIP_FLUSH_INTERVAL_MS    30000UL      // batch-write ~every 30 s
// Force a flush if the RAM buffer fills before the interval elapses.
#define TRIP_MAX_BUFFER_POINTS    64
// Minimum wall-clock spacing between two recorded points (rate limit).
#define TRIP_MIN_POINT_INTERVAL_MS 1000UL      // at most ~1 point/second

// ---- Movement / simplification thresholds ---------------------------------
// Ground speed (km/h) at or above which the bike is considered "moving". Used
// both to auto-start a trip and to keep the inactivity timer alive.
#define TRIP_MOVE_SPEED_KMH       3.0f
// A new point is only recorded once the bike has moved at least this many
// metres from the previously recorded point (drops jitter / stationary drift
// and simplifies the track). Set to 0 to record every sample.
#define TRIP_MIN_MOVE_METERS      6.0f
// Ignore absurd GPS jumps (metres between consecutive samples) as glitches so
// they don't inflate the distance total or the track.
#define TRIP_MAX_JUMP_METERS      500.0f
// After this long with no movement the ride is auto-finalised (buffer flushed,
// file closed, summary written) and the saver returns to idle.
#define TRIP_INACTIVITY_TIMEOUT_MS (120000UL)  // 2 minutes

#endif // CONFIG_H
