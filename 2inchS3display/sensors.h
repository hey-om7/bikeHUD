/*
 * sensors.h - QMI8658 IMU + NEO-7M GPS drivers
 * Tripper Telemetry Dashboard V5
 */
#ifndef SENSORS_H
#define SENSORS_H

#include <Wire.h>
#include <time.h>
#include "config.h"

// ===== Telemetry State (extern, defined in main) =====
extern float pitchIncline;
extern float rollTilt;
extern float gpsAltitude;
extern float gpsHeading;
extern double gpsLat;        // decimal degrees (real GPS fix)
extern double gpsLng;        // decimal degrees (real GPS fix)
extern float gpsSpeed;      // ground speed, km/h (from RMC)
extern int   gpsSatellites;    // satellites USED in the fix (from GGA)
extern int   gpsSatsInView;    // satellites IN VIEW (from GSV) - signal strength
extern bool  gpsFix;
extern bool  imuConnected;

// ===== QMI8658 Driver =====
// Runtime I2C address (will be set during init)
static uint8_t qmi8658_addr = QMI8658_ADDR;

void qmi8658_write(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(qmi8658_addr);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
}

uint8_t qmi8658_read(uint8_t reg) {
  Wire.beginTransmission(qmi8658_addr);
  Wire.write(reg);
  Wire.endTransmission(false);
  Wire.requestFrom(qmi8658_addr, (uint8_t)1);
  return Wire.read();
}

void qmi8658_read_multi(uint8_t reg, uint8_t *buf, uint8_t len) {
  Wire.beginTransmission(qmi8658_addr);
  Wire.write(reg);
  Wire.endTransmission(false);
  Wire.requestFrom(qmi8658_addr, len);
  for (uint8_t i = 0; i < len; i++) buf[i] = Wire.read();
}

void qmi8658_read_accel(float *ax, float *ay, float *az) {
  uint8_t buf[6];
  qmi8658_read_multi(QMI8658_AX_L, buf, 6);
  *ax = (int16_t)(buf[1] << 8 | buf[0]) / 4096.0f;
  *ay = (int16_t)(buf[3] << 8 | buf[2]) / 4096.0f;
  *az = (int16_t)(buf[5] << 8 | buf[4]) / 4096.0f;
}

void qmi8658_read_gyro(float *gx, float *gy, float *gz) {
  uint8_t buf[6];
  qmi8658_read_multi(QMI8658_GX_L, buf, 6);
  // CTRL3 = 0x65: 512Hz ODR, ±512 dps → sensitivity = 64 LSB/dps
  *gx = (int16_t)(buf[1] << 8 | buf[0]) / 64.0f;
  *gy = (int16_t)(buf[3] << 8 | buf[2]) / 64.0f;
  *gz = (int16_t)(buf[5] << 8 | buf[4]) / 64.0f;
}

bool qmi8658_init() {
  // Try both possible QMI8658 addresses
  uint8_t addrs[] = {0x6B, 0x6A};
  uint8_t id = 0;
  bool found = false;

  for (int i = 0; i < 2; i++) {
    qmi8658_addr = addrs[i];
    id = qmi8658_read(QMI8658_WHO_AM_I);
    if (id == 0x05 || id == 0x06) {
      found = true;
      break;
    }
    Serial.printf("[IMU] No response at 0x%02X (got 0x%02X)\n", addrs[i], id);
  }

  if (!found) {
    // I2C scan to help debug
    Serial.println("[IMU] QMI8658 not found. Scanning I2C bus...");
    for (uint8_t addr = 1; addr < 127; addr++) {
      Wire.beginTransmission(addr);
      if (Wire.endTransmission() == 0) {
        Serial.printf("[IMU]   Found device at 0x%02X\n", addr);
      }
    }
    Serial.println("[IMU] Scan complete. Check I2C SDA/SCL pin config.");
    return false;
  }

  Serial.printf("[IMU] QMI8658 detected at 0x%02X, chip ID: 0x%02X\n", qmi8658_addr, id);

  // Soft reset
  qmi8658_write(QMI8658_CTRL1, 0x60);
  delay(20);

  // Accel: 512Hz ODR, ±8g
  qmi8658_write(QMI8658_CTRL2, 0x25);
  // Gyro: 512Hz ODR, ±512 dps
  qmi8658_write(QMI8658_CTRL3, 0x65);
  // No sensor processing
  qmi8658_write(QMI8658_CTRL5, 0x00);
  // Enable both accel + gyro
  qmi8658_write(QMI8658_CTRL7, 0x03);
  delay(50);

  // Prime the filter with an initial accel reading so angle isn't 0
  float ax, ay, az;
  qmi8658_read_accel(&ax, &ay, &az);
  pitchIncline = atan2f(ay, sqrtf(ax * ax + az * az)) * RAD2DEG;
  rollTilt = atan2f(-ax, az) * RAD2DEG;
  Serial.printf("[IMU] Initial pitch=%.1f, roll=%.1f\n", pitchIncline, rollTilt);

  return true;
}

// ===== Complementary Filter for Pitch & Roll =====
// Fuses accelerometer (stable but noisy) with gyroscope (smooth but drifts)
// Alpha = 0.96 favours gyro for fast response, accel corrects drift over time
#define COMP_FILTER_ALPHA 0.96f

void imu_update(float dt) {
  // Clamp dt to prevent filter blowup on timing anomalies
  if (dt <= 0.0f || dt > 0.1f) dt = 0.02f;

  float ax, ay, az, gx, gy, gz;
  qmi8658_read_accel(&ax, &ay, &az);
  qmi8658_read_gyro(&gx, &gy, &gz);

  // Accel-based angles (reference, no drift but noisy under vibration)
  float accelPitch = atan2f(ay, sqrtf(ax * ax + az * az)) * RAD2DEG;
  float accelRoll  = atan2f(-ax, az) * RAD2DEG;

  // Complementary filter: gyro for short-term, accel for long-term correction
  pitchIncline = COMP_FILTER_ALPHA * (pitchIncline + gy * dt) + (1.0f - COMP_FILTER_ALPHA) * accelPitch;
  rollTilt     = COMP_FILTER_ALPHA * (rollTilt + gx * dt) + (1.0f - COMP_FILTER_ALPHA) * accelRoll;
}

// ===== NMEA GPS Processing =====
const char* getCardinalDirection(float course) {
  if (course >= 337.5 || course < 22.5) return "N";
  if (course >= 22.5 && course < 67.5) return "NE";
  if (course >= 67.5 && course < 112.5) return "E";
  if (course >= 112.5 && course < 157.5) return "SE";
  if (course >= 157.5 && course < 202.5) return "S";
  if (course >= 202.5 && course < 247.5) return "SW";
  if (course >= 247.5 && course < 292.5) return "W";
  if (course >= 292.5 && course < 337.5) return "NW";
  return "-";
}

// Convert an NMEA "ddmm.mmmm" / "dddmm.mmmm" coordinate token + hemisphere
// character into signed decimal degrees. Returns NAN on a malformed/empty token.
static double nmeaToDecimal(const String &token, char hemi) {
  if (token.length() < 3) return NAN;
  int dotIdx = token.indexOf('.');
  if (dotIdx < 3) return NAN;  // need at least dd + mm before the decimal
  // Degrees are all digits before the last two whole-minute digits.
  int degDigits = dotIdx - 2;
  double deg = token.substring(0, degDigits).toDouble();
  double minutes = token.substring(degDigits).toDouble();
  double dec = deg + minutes / 60.0;
  if (hemi == 'S' || hemi == 'W') dec = -dec;
  return dec;
}

// ===== GPS UTC date/time (parsed from RMC) =====
// The RMC sentence carries both UTC time (field 1: hhmmss.sss) and date
// (field 9: ddmmyy). We keep the most recent valid values so features that need
// a wall-clock timestamp (e.g. the Trip Saver's filenames) work even with no
// WiFi/NTP. Values are UTC.
static int  gpsUtcYear = 0, gpsUtcMonth = 0, gpsUtcDay = 0;
static int  gpsUtcHour = 0, gpsUtcMin = 0, gpsUtcSec = 0;
static bool gpsDateValid = false;
static bool gpsTimeValid = false;

// Convert a proleptic-Gregorian civil date to days since 1970-01-01 (Howard
// Hinnant's algorithm). Valid for any reasonable year; avoids relying on the
// platform's timegm(), which is not always available in the Arduino core.
static long gpsDaysFromCivil(int y, unsigned m, unsigned d) {
  y -= (m <= 2);
  long era = (y >= 0 ? y : y - 399) / 400;
  unsigned yoe = (unsigned)(y - era * 400);
  unsigned doy = (153u * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097L + (long)doe - 719468L;
}

// Returns true and fills `epochOut` with the current UTC epoch (seconds) if a
// full valid GPS date+time has been received; false otherwise.
bool gpsGetUtcEpoch(time_t &epochOut) {
  if (!gpsDateValid || !gpsTimeValid) return false;
  long days = gpsDaysFromCivil(gpsUtcYear, (unsigned)gpsUtcMonth, (unsigned)gpsUtcDay);
  epochOut = (time_t)(days * 86400L + gpsUtcHour * 3600L + gpsUtcMin * 60L + gpsUtcSec);
  return true;
}

void parseNMEA(String line) {
  if (line.startsWith("$GPGGA") || line.startsWith("$GNGGA")) {
    // GGA fields: 2=lat, 3=N/S, 4=lng, 5=E/W, 6=fix, 7=sats, 9=altitude
    int tokenIdx = 0, start = 0, end = line.indexOf(',');
    String latTok = "", lngTok = "";
    char latHemi = 0, lngHemi = 0;
    while (end != -1) {
      String token = line.substring(start, end);
      if (tokenIdx == 2) latTok = token;
      else if (tokenIdx == 3 && token.length() > 0) latHemi = token[0];
      else if (tokenIdx == 4) lngTok = token;
      else if (tokenIdx == 5 && token.length() > 0) lngHemi = token[0];
      else if (tokenIdx == 6) gpsFix = (token.toInt() > 0);
      else if (tokenIdx == 7) gpsSatellites = token.toInt();
      else if (tokenIdx == 9 && token.length() > 0) gpsAltitude = token.toFloat();
      tokenIdx++; start = end + 1; end = line.indexOf(',', start);
    }
    if (gpsFix && latTok.length() > 0 && lngTok.length() > 0) {
      double lat = nmeaToDecimal(latTok, latHemi);
      double lng = nmeaToDecimal(lngTok, lngHemi);
      if (!isnan(lat) && !isnan(lng)) { gpsLat = lat; gpsLng = lng; }
    }
  } else if (line.startsWith("$GPRMC") || line.startsWith("$GNRMC")) {
    // RMC fields: 2=status, 3=lat, 4=N/S, 5=lng, 6=E/W, 7=speed(kn), 8=course
    int tokenIdx = 0, start = 0, end = line.indexOf(',');
    float tempHeading = -1.0;
    String latTok = "", lngTok = "";
    char latHemi = 0, lngHemi = 0, status = 0;
    String timeTok = "", dateTok = "";
    while (end != -1) {
      String token = line.substring(start, end);
      if (tokenIdx == 1) timeTok = token;                            // hhmmss(.sss) UTC
      else if (tokenIdx == 2 && token.length() > 0) status = token[0];  // 'A'=valid, 'V'=void
      else if (tokenIdx == 3) latTok = token;
      else if (tokenIdx == 4 && token.length() > 0) latHemi = token[0];
      else if (tokenIdx == 5) lngTok = token;
      else if (tokenIdx == 6 && token.length() > 0) lngHemi = token[0];
      else if (tokenIdx == 7 && token.length() > 0) gpsSpeed = token.toFloat() * 1.852f;  // knots -> km/h
      else if (tokenIdx == 8 && token.length() > 0) tempHeading = token.toFloat();
      else if (tokenIdx == 9) dateTok = token;                       // ddmmyy UTC
      tokenIdx++; start = end + 1; end = line.indexOf(',', start);
    }
    if (status == 'A') {
      gpsFix = true;
      if (latTok.length() > 0 && lngTok.length() > 0) {
        double lat = nmeaToDecimal(latTok, latHemi);
        double lng = nmeaToDecimal(lngTok, lngHemi);
        if (!isnan(lat) && !isnan(lng)) { gpsLat = lat; gpsLng = lng; }
      }
      // Extract UTC time (hhmmss) — the fractional seconds are ignored.
      if (timeTok.length() >= 6) {
        gpsUtcHour = timeTok.substring(0, 2).toInt();
        gpsUtcMin  = timeTok.substring(2, 4).toInt();
        gpsUtcSec  = timeTok.substring(4, 6).toInt();
        gpsTimeValid = true;
      }
      // Extract UTC date (ddmmyy → full year 2000+yy).
      if (dateTok.length() >= 6) {
        gpsUtcDay   = dateTok.substring(0, 2).toInt();
        gpsUtcMonth = dateTok.substring(2, 4).toInt();
        gpsUtcYear  = 2000 + dateTok.substring(4, 6).toInt();
        if (gpsUtcDay >= 1 && gpsUtcMonth >= 1 && gpsUtcMonth <= 12) gpsDateValid = true;
      }
    }
    // Course over ground is only meaningful when actually moving.
    if (tempHeading >= 0.0 && gpsSpeed > 3.0f) gpsHeading = tempHeading;
  } else if (line.indexOf("GSV") == 3 && line.startsWith("$")) {
    // GSV = satellites in view. Each sentence carries up to 4 satellites with
    // their signal-to-noise ratio (SNR). We only count satellites with SNR >= 20
    // dB-Hz as "usable signal" — weak signals (bouncing through walls indoors)
    // are ignored. This prevents showing 4 dots when indoors with no real fix.
    //
    // Format: $GxGSV,totalMsgs,msgNum,totalSats,[prn,elev,azimuth,snr]*4
    //
    // We accumulate on the first message of a set and finalize on the last.
    static int gsvGoodSats = 0;
    static int gsvTotalMsgs = 0;

    int tokenIdx = 0, start = 0, end = line.indexOf(',');
    int totalMsgs = 0, msgNum = 0;
    int snrCount = 0;  // good-SNR satellites in THIS sentence

    while (end != -1) {
      String token = line.substring(start, end);
      if (tokenIdx == 1) totalMsgs = token.toInt();
      else if (tokenIdx == 2) msgNum = token.toInt();
      // Satellite data starts at field 4: groups of 4 (PRN, elev, azim, SNR)
      // SNR is at positions 7, 11, 15, 19 (0-indexed)
      else if (tokenIdx >= 7 && ((tokenIdx - 7) % 4 == 0) && token.length() > 0) {
        int snr = token.toInt();
        if (snr >= 20) snrCount++;
      }
      tokenIdx++; start = end + 1; end = line.indexOf(',', start);
    }
    // Also check the last token (after the final comma, before the checksum '*')
    String lastToken = line.substring(start);
    int starIdx = lastToken.indexOf('*');
    if (starIdx > 0) lastToken = lastToken.substring(0, starIdx);
    if (tokenIdx >= 7 && ((tokenIdx - 7) % 4 == 0) && lastToken.length() > 0) {
      int snr = lastToken.toInt();
      if (snr >= 20) snrCount++;
    }

    // Reset accumulator on the first message of a new set
    if (msgNum == 1) {
      gsvGoodSats = 0;
      gsvTotalMsgs = totalMsgs;
    }
    gsvGoodSats += snrCount;

    // Finalize on the last message of the set
    if (msgNum >= gsvTotalMsgs && gsvTotalMsgs > 0) {
      gpsSatsInView = gsvGoodSats;
    }
  }
}

// ===== Non-blocking GPS Pump =====
// Drains whatever bytes are currently in the UART RX buffer, assembling full
// NMEA lines and parsing each one. Never blocks: it only consumes bytes that
// have already arrived. Call this EVERY loop iteration in EVERY app state so
// the RX buffer never overflows and the fix stays current the instant the
// dashboard appears.
void gpsPump(HardwareSerial &gps) {
  static String line = "";
  while (gps.available()) {
    char c = (char)gps.read();
    if (c == '\n') {
      line.trim();
      if (line.length() > 0) parseNMEA(line);
      line = "";
    } else if (c != '\r') {
      if (line.length() < 120) line += c;   // guard against runaway lines
      else line = "";                        // corrupt/overlong -> resync
    }
  }
}

// ===== GPS Boot Diagnostic =====
// Verifies the NEO-7M is wired correctly and talking on the UART. Reads for
// `durationMs`, echoes the raw NMEA sentences, and reports whether data is
// flowing and whether a satellite fix is already present. Call once in setup().
void gpsBootDiagnostic(HardwareSerial &gps, uint32_t durationMs) {
  Serial.printf("[GPS] Boot check on UART (RX=%d, TX=%d) for %lums...\n",
                GPS_RX_PIN, GPS_TX_PIN, (unsigned long)durationMs);

  unsigned long start = millis();
  unsigned long byteCount = 0;
  int sentenceCount = 0;
  String line = "";

  while (millis() - start < durationMs) {
    while (gps.available()) {
      char c = (char)gps.read();
      byteCount++;
      if (c == '\n') {
        line.trim();
        if (line.length() > 0) {
          Serial.printf("[GPS] << %s\n", line.c_str());
          parseNMEA(line);       // update globals if a fix is already present
          sentenceCount++;
        }
        line = "";
      } else if (c != '\r') {
        if (line.length() < 120) line += c;  // guard against runaway lines
      }
    }
  }

  if (byteCount == 0) {
    Serial.println("[GPS] ERROR: no data received on the UART.");
    Serial.println("[GPS]   Check wiring:");
    Serial.printf ("[GPS]     GPS TXD -> ESP GPIO %d (RX)\n", GPS_RX_PIN);
    Serial.printf ("[GPS]     GPS RXD -> ESP GPIO %d (TX)\n", GPS_TX_PIN);
    Serial.println("[GPS]     GPS VCC -> 3.3V,  GPS GND -> GND");
    Serial.println("[GPS]   If TX/RX are swapped you get zero bytes.");
  } else {
    Serial.printf("[GPS] OK: module is talking (%lu bytes, %d NMEA sentences).\n",
                  byteCount, sentenceCount);
    if (gpsFix && (gpsLat != 0.0f || gpsLng != 0.0f)) {
      Serial.printf("[GPS] Fix acquired at boot: lat=%.6f, lng=%.6f, sats=%d, alt=%.0fm\n",
                    gpsLat, gpsLng, gpsSatellites, gpsAltitude);
    } else {
      Serial.println("[GPS] Module OK but no satellite fix yet.");
      Serial.println("[GPS]   Needs a clear view of the sky; cold start ~30-45s.");
    }
  }
}

// ===== GPS Status Print (throttled) =====
// Call from the main loop; prints the current fix at most once per intervalMs.
void gpsPrintStatus(uint32_t intervalMs) {
  static unsigned long lastPrint = 0;
  static bool lastFix = false;
  unsigned long now = millis();

  // Print immediately the moment a fix is first acquired, then throttle.
  bool fixJustAcquired = (gpsFix && !lastFix);
  lastFix = gpsFix;

  if (!fixJustAcquired && (now - lastPrint < intervalMs)) return;
  lastPrint = now;

  if (gpsFix && (gpsLat != 0.0f || gpsLng != 0.0f)) {
    Serial.printf("[GPS] lat=%.6f, lng=%.6f | sats=%d | speed=%.1fkm/h | hdg=%.0f | alt=%.0fm%s\n",
                  gpsLat, gpsLng, gpsSatellites, gpsSpeed, gpsHeading, gpsAltitude,
                  fixJustAcquired ? "  <-- FIX ACQUIRED" : "");
  } else {
    Serial.printf("[GPS] no fix (used=%d, strong signal=%d) - waiting for satellites...\n",
                  gpsSatellites, gpsSatsInView);
  }
}

#endif // SENSORS_H
