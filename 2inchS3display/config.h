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
#define GPS_RX_PIN 44
#define GPS_TX_PIN 43

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

#endif // CONFIG_H
