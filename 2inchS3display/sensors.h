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
extern float gpsAltitude;
extern float gpsHeading;
extern int   gpsSatellites;
extern bool  gpsFix;
extern bool  imuConnected;

// ===== QMI8658 Driver =====
void qmi8658_write(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(QMI8658_ADDR);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
}

uint8_t qmi8658_read(uint8_t reg) {
  Wire.beginTransmission(QMI8658_ADDR);
  Wire.write(reg);
  Wire.endTransmission(false);
  Wire.requestFrom(QMI8658_ADDR, (uint8_t)1);
  return Wire.read();
}

void qmi8658_read_multi(uint8_t reg, uint8_t *buf, uint8_t len) {
  Wire.beginTransmission(QMI8658_ADDR);
  Wire.write(reg);
  Wire.endTransmission(false);
  Wire.requestFrom(QMI8658_ADDR, len);
  for (uint8_t i = 0; i < len; i++) buf[i] = Wire.read();
}

bool qmi8658_init() {
  uint8_t id = qmi8658_read(QMI8658_WHO_AM_I);
  if (id != QMI8658_CHIP_ID && id != 0x05) return false;
  qmi8658_write(QMI8658_CTRL1, 0x60);
  delay(10);
  qmi8658_write(QMI8658_CTRL2, 0x25);
  qmi8658_write(QMI8658_CTRL3, 0x65);
  qmi8658_write(QMI8658_CTRL5, 0x00);
  qmi8658_write(QMI8658_CTRL7, 0x03);
  delay(50);
  return true;
}

void qmi8658_read_accel(float *ax, float *ay, float *az) {
  uint8_t buf[6];
  qmi8658_read_multi(QMI8658_AX_L, buf, 6);
  *ax = (int16_t)(buf[1] << 8 | buf[0]) / 4096.0f;
  *ay = (int16_t)(buf[3] << 8 | buf[2]) / 4096.0f;
  *az = (int16_t)(buf[5] << 8 | buf[4]) / 4096.0f;
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
