/*
 * sensors.h - QMI8658 IMU + NEO-7M GPS drivers
 * Tripper Telemetry Dashboard V5
 */
#ifndef SENSORS_H
#define SENSORS_H

#include <Wire.h>
#include "config.h"

// ===== Telemetry State (extern, defined in main) =====
extern float pitchIncline;
extern float rollTilt;
extern float gpsAltitude;
extern float gpsHeading;
extern int   gpsSatellites;
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

void parseNMEA(String line) {
  if (line.startsWith("$GPGGA") || line.startsWith("$GNGGA")) {
    int tokenIdx = 0, start = 0, end = line.indexOf(',');
    while (end != -1) {
      String token = line.substring(start, end);
      if (tokenIdx == 6) gpsFix = (token.toInt() > 0);
      else if (tokenIdx == 7) gpsSatellites = token.toInt();
      else if (tokenIdx == 9 && token.length() > 0) gpsAltitude = token.toFloat();
      tokenIdx++; start = end + 1; end = line.indexOf(',', start);
    }
  } else if (line.startsWith("$GPRMC") || line.startsWith("$GNRMC")) {
    int tokenIdx = 0, start = 0, end = line.indexOf(',');
    float tempHeading = -1.0;
    while (end != -1) {
      String token = line.substring(start, end);
      if (tokenIdx == 8 && token.length() > 0) tempHeading = token.toFloat();
      tokenIdx++; start = end + 1; end = line.indexOf(',', start);
    }
    if (tempHeading >= 0.0) gpsHeading = tempHeading;
  }
}

#endif // SENSORS_H
