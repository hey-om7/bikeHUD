/*
 * agps.h - Assisted GPS for the NEO-7M (u-blox generation 7)
 * Tripper Telemetry Dashboard V5
 *
 * WHAT THIS DOES
 *   A normal NEO-7M cold start takes ~30s because the receiver has to download
 *   each satellite's ephemeris over the air at 50 bit/s. A-GPS injects that
 *   ephemeris (plus a rough position + accurate time) from the internet so the
 *   receiver only has to lock onto signals it already knows about. Under a
 *   clear sky with a healthy antenna this brings TTFF down to ~2-5s.
 *
 * WHEN IT RUNS
 *   Only when the ESP32 is connected to a WiFi network (STA). If there is no
 *   WiFi, agpsMaybeInject() does nothing and the module performs its normal
 *   (unassisted) cold start.
 *
 * PROTOCOL NOTE (important for the NEO-7M specifically)
 *   The NEO-7M is generation 7, which uses the LEGACY UBX-AID assistance
 *   messages, NOT UBX-MGA (generation 8+). We therefore request AssistNow
 *   Online with `format=aid`; the server returns a stream of UBX-AID-EPH and
 *   UBX-AID-INI frames that we forward verbatim to the receiver's UART.
 *
 * LIMITATIONS
 *   - A-GPS cannot conjure signals the antenna can't receive. Indoors it still
 *     fails; the 3s target requires open sky.
 *   - At 9600 baud the UART itself takes ~1s per KB, so we request eph only.
 *   - Time injected over a 9600-baud UART has ~tens-of-ms latency; we advertise
 *     a conservative time accuracy so the receiver trusts it appropriately.
 */
#ifndef AGPS_H
#define AGPS_H

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <time.h>
#include "config.h"

// GPS fix globals (defined in the main sketch) so we can cache the last known
// position for use as the assistance "rough position" on the next boot.
extern double gpsLat;
extern double gpsLng;
extern bool  gpsFix;

// ---- module state ----
static Preferences agpsPrefs;
static unsigned long agpsLastRunMs = 0;
static bool          agpsRanThisConnection = false;

// ============================================================================
//  Last-known-position cache (persisted in NVS)
// ============================================================================
// Storing the last good fix lets a subsequent boot hand the receiver a rough
// starting position even before any internet position lookup, which measurably
// shortens the search.

void agpsSaveLastPosition(float lat, float lng) {
  if (lat == 0.0f && lng == 0.0f) return;
  agpsPrefs.begin("agps", false);
  agpsPrefs.putFloat("lat", lat);
  agpsPrefs.putFloat("lng", lng);
  agpsPrefs.putULong("ts", (unsigned long)time(nullptr));
  agpsPrefs.end();
}

// Returns true and fills lat/lng if a cached position exists.
bool agpsLoadLastPosition(float &lat, float &lng) {
  agpsPrefs.begin("agps", true);
  lat = agpsPrefs.getFloat("lat", 0.0f);
  lng = agpsPrefs.getFloat("lng", 0.0f);
  agpsPrefs.end();
  return (lat != 0.0f || lng != 0.0f);
}

// Call periodically from the dashboard loop; throttled internally. Caches the
// live fix so it can seed the next boot.
void agpsCacheFixThrottled(uint32_t intervalMs) {
  static unsigned long last = 0;
  unsigned long now = millis();
  if (now - last < intervalMs) return;
  last = now;
  if (gpsFix && (gpsLat != 0.0f || gpsLng != 0.0f)) {
    agpsSaveLastPosition(gpsLat, gpsLng);
  }
}

// ============================================================================
//  Time sync (NTP) — used only to build a fallback AID-INI when we have no
//  position to send the server. When we DO send a position, the AssistNow
//  server returns its own AID-INI containing current time, which is preferable.
// ============================================================================
static bool agpsSyncTime(uint32_t timeoutMs) {
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  unsigned long start = millis();
  time_t now = 0;
  while (millis() - start < timeoutMs) {
    now = time(nullptr);
    if (now > 1700000000) return true;  // sometime after Nov 2023 => synced
    delay(100);
  }
  return false;
}

// ============================================================================
//  UBX helpers
// ============================================================================
// Append the two-byte Fletcher checksum u-blox uses (over class..end of payload)
static void ubxAppendChecksum(uint8_t *buf, size_t lenWithoutCk) {
  uint8_t a = 0, b = 0;
  // checksum covers everything after the two sync chars (0xB5 0x62)
  for (size_t i = 2; i < lenWithoutCk; i++) {
    a += buf[i];
    b += a;
  }
  buf[lenWithoutCk]     = a;
  buf[lenWithoutCk + 1] = b;
}

// Build and send a UBX-AID-INI (class 0x0B, id 0x01) carrying a rough position
// (lat/lon/alt) and, if haveTime, the current GPS time. This is our fallback
// path when we cannot get a server-generated AID-INI.
static void ubxSendAidIni(HardwareSerial &gps, float lat, float lng,
                          bool havePos, bool haveTime, time_t utc) {
  uint8_t p[6 + 48 + 2] = {0};
  p[0] = 0xB5; p[1] = 0x62;      // sync
  p[2] = 0x0B; p[3] = 0x01;      // class, id (AID-INI)
  p[4] = 48;   p[5] = 0x00;      // payload length = 48

  uint8_t *pl = &p[6];           // 48-byte payload

  uint32_t flags = 0;

  if (havePos) {
    // lat/lon in 1e-7 deg, alt in cm. bit5 (0x20) => position is lat/lon/alt.
    int32_t latI = (int32_t)(lat * 1e7);
    int32_t lngI = (int32_t)(lng * 1e7);
    int32_t altCm = 0;                    // unknown altitude -> 0, high posAcc
    memcpy(pl + 0,  &latI, 4);
    memcpy(pl + 4,  &lngI, 4);
    memcpy(pl + 8,  &altCm, 4);
    uint32_t posAcc = 300000;             // 300 km: cached/last-known is rough
    memcpy(pl + 12, &posAcc, 4);
    flags |= 0x01;                        // pos valid
    flags |= 0x20;                        // pos is lat/lon/alt (not ECEF)
  }

  if (haveTime) {
    // Convert UTC epoch -> GPS week + time-of-week (ms).
    // GPS epoch = 1980-01-06 00:00:00 UTC = unix 315964800. GPS is ahead of
    // UTC by the leap-second count.
    int64_t gpsSecs = (int64_t)utc - 315964800LL + GPS_UTC_LEAP_SECS;
    uint16_t wn = (uint16_t)(gpsSecs / 604800LL);
    uint32_t towMs = (uint32_t)((gpsSecs % 604800LL) * 1000LL);
    memcpy(pl + 18, &wn, 2);              // wn  (U2) at offset 18
    memcpy(pl + 20, &towMs, 4);           // tow (U4, ms) at offset 20
    uint32_t tAccMs = 2000;               // 2s: conservative for UART latency
    memcpy(pl + 28, &tAccMs, 4);          // tAccMs at offset 28
    flags |= 0x02;                        // time valid
    flags |= 0x400;                       // time is UTC-based
  }

  memcpy(pl + 44, &flags, 4);             // flags (X4) at offset 44

  ubxAppendChecksum(p, 6 + 48);
  gps.write(p, sizeof(p));
  gps.flush();
}

// ============================================================================
//  AssistNow Online download + inject
// ============================================================================
// Downloads the assistance blob and streams it to the receiver. Returns the
// number of bytes forwarded (0 on failure).
static size_t agpsDownloadAndInject(HardwareSerial &gps, bool havePos,
                                     float lat, float lng) {
  if (strlen(AGPS_TOKEN) == 0) {
    Serial.println("[AGPS] No token configured; skipping (normal cold start).");
    return 0;
  }

  // Build request URL. format=aid is mandatory for the gen-7 NEO-7M.
  // If we have a rough position we pass it and ask for datatype=eph,pos so the
  // server also returns a ready-made AID-INI (position + current time).
  String url = String("https://") + AGPS_HOST + AGPS_PATH +
               "?token=" + AGPS_TOKEN +
               "&gnss=gps&format=aid&datatype=eph";
  if (havePos) {
    url += ",pos";
    url += "&lat=" + String(lat, 6) + "&lon=" + String(lng, 6);
    url += "&pacc=300000";   // 300 km accuracy for a cached/last-known fix
  }

  WiFiClientSecure client;
  // AssistNow is HTTPS-only. We skip certificate validation to avoid shipping
  // a CA bundle; the assistance data is not secret and is checksum-validated
  // by the receiver. For stricter deployments, pin the u-blox CA instead.
  client.setInsecure();

  HTTPClient http;
  http.setTimeout(8000);
  if (!http.begin(client, url)) {
    Serial.println("[AGPS] http.begin() failed.");
    return 0;
  }

  int code = http.GET();
  if (code != HTTP_CODE_OK) {
    Serial.printf("[AGPS] HTTP GET failed: %d\n", code);
    http.end();
    return 0;
  }

  int len = http.getSize();
  Serial.printf("[AGPS] Downloading assistance data (%d bytes)...\n", len);

  WiFiClient *stream = http.getStreamPtr();
  uint8_t buf[256];
  size_t total = 0;
  unsigned long start = millis();

  // Forward straight to the UART. At 9600 baud the write() calls provide the
  // pacing; total time is dominated by UART transmit (~1s per KB).
  while (http.connected() && (len < 0 || total < (size_t)len)) {
    size_t avail = stream->available();
    if (avail) {
      int n = stream->readBytes(buf, min(avail, sizeof(buf)));
      if (n > 0) {
        gps.write(buf, n);
        total += n;
      }
    } else {
      if (millis() - start > 10000) break;   // overall safety timeout
      delay(2);
    }
  }
  gps.flush();
  http.end();

  Serial.printf("[AGPS] Injected %u bytes of assistance data in %lums.\n",
                (unsigned)total, millis() - start);
  return total;
}

// ============================================================================
//  Public entry point
// ============================================================================
// Call this every loop iteration. It only acts when:
//   - WiFi STA is connected, AND
//   - it hasn't already run for this connection (or the refresh window elapsed).
// Returns true if an injection was performed on this call.
//
// If there is no WiFi, this is a no-op and the receiver just does its normal
// cold start — exactly the "else continue with the normal approach" behaviour.
bool agpsMaybeInject(HardwareSerial &gps) {
  if (WiFi.status() != WL_CONNECTED) {
    agpsRanThisConnection = false;   // re-arm for the next time WiFi comes up
    return false;
  }

  unsigned long now = millis();
  if (agpsRanThisConnection && (now - agpsLastRunMs < AGPS_REFRESH_MS)) {
    return false;   // already assisted recently
  }

  Serial.println("[AGPS] WiFi up -> attempting Assisted-GPS injection.");

  // A rough position speeds the fix further and lets the server build AID-INI.
  float lat = 0, lng = 0;
  bool havePos = agpsLoadLastPosition(lat, lng);
  if (havePos) {
    Serial.printf("[AGPS] Using cached rough position: %.5f, %.5f\n", lat, lng);
  } else {
    Serial.println("[AGPS] No cached position; requesting ephemeris only.");
  }

  size_t injected = agpsDownloadAndInject(gps, havePos, lat, lng);

  // If the server didn't give us a position/time frame (no cached pos), send a
  // fallback AID-INI with NTP time so the receiver at least gets time-assist.
  if (injected > 0 && !havePos) {
    if (agpsSyncTime(3000)) {
      ubxSendAidIni(gps, 0, 0, false, true, time(nullptr));
      Serial.println("[AGPS] Sent fallback AID-INI (time only).");
    }
  }

  agpsRanThisConnection = true;
  agpsLastRunMs = now;
  return injected > 0;
}

#endif // AGPS_H
