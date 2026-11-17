/*
 * trip_saver.h - Automatic ride logger (GPX -> microSD)
 * Tripper Telemetry Dashboard V5
 *
 * WHAT THIS DOES
 *   Records every ride automatically, with no "start trip" button. The moment
 *   real GPS movement is detected it opens a new GPX file on the onboard TF
 *   card and starts logging the route as a series of track points. When the
 *   bike stops moving for TRIP_INACTIVITY_TIMEOUT_MS the ride is finalised
 *   (buffer flushed, summary written, file closed) and the saver returns to
 *   idle, ready for the next ride.
 *
 * HOW IT PROTECTS THE CARD (wear) AND YOUR DATA (power cuts)
 *   - Points are collected in a small RAM buffer, not written one-by-one.
 *   - The buffer is batch-APPENDED to the file about every 30 s
 *     (TRIP_FLUSH_INTERVAL_MS) or when it fills, so the card sees a handful of
 *     writes per ride instead of one per GPS fix.
 *   - Points that are too close together (< TRIP_MIN_MOVE_METERS) or too
 *     frequent (< TRIP_MIN_POINT_INTERVAL_MS) are dropped, simplifying the
 *     track and cutting writes further.
 *   - Writes are append-only and the file handle is flushed+closed after every
 *     batch, so an unexpected power cut loses at most the last unflushed batch.
 *   - The active file's name + running metadata live in NVS. On the next boot
 *     tripSaverInit() detects an interrupted ride and FINALISES it (appends the
 *     GPX closing tags + a recovered summary) instead of leaving a corrupt file
 *     or losing the whole trip.
 *
 * NON-BLOCKING
 *   Everything runs from tripSaverLoop(), called every iteration of the main
 *   loop. A flush writes a few dozen short lines (a few ms) at most. It reuses
 *   the existing GPS globals + the RMC UTC clock from sensors.h and never
 *   touches the display SPI bus (it uses a dedicated HSPI bus for the card).
 *
 * FAIL-SAFE
 *   If the card cannot be mounted (missing card, wrong TRIP_SD_* pins, etc.)
 *   the saver disables itself and every entry point becomes a no-op. The
 *   dashboard, GPS, navigation and server continue to work normally.
 */
#ifndef TRIP_SAVER_H
#define TRIP_SAVER_H

#include <Arduino.h>
#include <SPI.h>
#include <FS.h>
#include <SD.h>
#include <Preferences.h>
#include <math.h>
#include <time.h>
#include "config.h"

// ---- GPS state (defined in the main sketch / sensors.h) ----
extern double gpsLat;
extern double gpsLng;
extern float gpsAltitude;
extern float gpsSpeed;   // km/h
extern bool  gpsFix;

// gpsGetUtcEpoch() is provided by sensors.h (included before this header).
bool gpsGetUtcEpoch(time_t &epochOut);

#if TRIP_SAVER_ENABLED

// ============================================================================
//  Module state
// ============================================================================
static SPIClass  tsSPI(HSPI);      // dedicated bus so we never touch the LCD bus
static bool      tsSdOk = false;   // card mounted and usable
static Preferences tsPrefs;        // NVS namespace for crash-recovery metadata

enum TsState { TS_IDLE, TS_RECORDING };
static TsState tsState = TS_IDLE;

// One buffered GPS vector point.
struct TsPoint {
  double lat;
  double lng;
  float  ele;    // metres
  float  spd;    // km/h
  time_t t;      // UTC epoch seconds
};

static TsPoint  tsBuf[TRIP_MAX_BUFFER_POINTS];
static int      tsBufCount = 0;

static String        tsActiveFile;         // e.g. "/TRIPS/2026-01-01_10-00-00.gpx"
static time_t        tsStartEpoch    = 0;
static time_t        tsLastPointEpoch = 0;
static double        tsLastRecLat    = 0;   // last point actually recorded
static double        tsLastRecLng    = 0;
static double        tsTotalDistM    = 0;   // accumulated distance, metres
static uint32_t      tsPointCount    = 0;   // total points recorded this ride
static unsigned long tsLastFlushMs   = 0;
static unsigned long tsLastMovementMs = 0;  // millis() of last "moving" sample
static unsigned long tsLastPointMs   = 0;   // millis() of last recorded point

// ============================================================================
//  Small helpers
// ============================================================================

// Great-circle distance between two lat/lng points, in metres (haversine).
static double tsHaversineM(double lat1, double lng1, double lat2, double lng2) {
  const double R = 6371000.0;  // Earth radius, m
  double dLat = (lat2 - lat1) * DEG2RAD;
  double dLng = (lng2 - lng1) * DEG2RAD;
  double a = sin(dLat / 2) * sin(dLat / 2) +
             cos(lat1 * DEG2RAD) * cos(lat2 * DEG2RAD) *
             sin(dLng / 2) * sin(dLng / 2);
  return R * 2.0 * atan2(sqrt(a), sqrt(1.0 - a));
}

// Format a UTC epoch as ISO-8601 (…Z) into `out` (needs >= 21 bytes).
static void tsIso8601(time_t epoch, char *out, size_t n) {
  struct tm tmv;
  gmtime_r(&epoch, &tmv);
  strftime(out, n, "%Y-%m-%dT%H:%M:%SZ", &tmv);
}

// Build the "/TRIPS/YYYY-MM-DD_HH-MM-SS.gpx" path for a start epoch (UTC).
static String tsFilenameFor(time_t epoch) {
  struct tm tmv;
  gmtime_r(&epoch, &tmv);
  char name[48];
  strftime(name, sizeof(name), TRIP_DIR "/%Y-%m-%d_%H-%M-%S.gpx", &tmv);
  return String(name);
}

// ============================================================================
//  File writers
// ============================================================================

// Write the GPX header + <trk>/<trkseg> opening tags to a freshly created file.
// Returns true on success.
static bool tsWriteHeader(const String &path, time_t startEpoch) {
  File f = SD.open(path.c_str(), FILE_WRITE);   // create / truncate
  if (!f) {
    Serial.printf("[TRIP] ERROR: cannot create %s\n", path.c_str());
    return false;
  }
  char startIso[24];
  tsIso8601(startEpoch, startIso, sizeof(startIso));
  f.print(F("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"));
  f.print(F("<gpx version=\"1.1\" creator=\"Tripper\" "
            "xmlns=\"http://www.topografix.com/GPX/1/1\">\n"));
  f.print(F("  <metadata>\n    <name>Tripper ride</name>\n    <time>"));
  f.print(startIso);
  f.print(F("</time>\n  </metadata>\n"));
  f.print(F("  <trk>\n    <name>"));
  f.print(startIso);
  f.print(F("</name>\n    <trkseg>\n"));
  f.flush();
  f.close();
  return true;
}

// Append every buffered point to the file, then empty the buffer. Each flush
// re-opens in append mode and closes again so the data is committed to the card
// (crash-safe). Returns true on success.
static bool tsFlushBuffer() {
  if (tsBufCount == 0) return true;
  if (!tsSdOk || tsActiveFile.length() == 0) { tsBufCount = 0; return false; }

  File f = SD.open(tsActiveFile.c_str(), FILE_APPEND);
  if (!f) {
    Serial.printf("[TRIP] ERROR: cannot append to %s\n", tsActiveFile.c_str());
    return false;
  }
  char iso[24];
  for (int i = 0; i < tsBufCount; i++) {
    const TsPoint &p = tsBuf[i];
    tsIso8601(p.t, iso, sizeof(iso));
    f.printf("      <trkpt lat=\"%.6f\" lon=\"%.6f\">", p.lat, p.lng);
    f.printf("<ele>%.1f</ele><time>%s</time>", p.ele, iso);
    f.printf("<extensions><speed>%.2f</speed></extensions></trkpt>\n",
             p.spd / 3.6f);  // GPX speed is m/s
  }
  f.flush();
  f.close();

  Serial.printf("[TRIP] Flushed %d point(s) to %s (%.2f km total)\n",
                tsBufCount, tsActiveFile.c_str(), tsTotalDistM / 1000.0);
  tsBufCount = 0;

  // Persist running metadata so a power cut can be recovered on next boot.
  tsPrefs.begin("tripsaver", false);
  tsPrefs.putULong("lastPt", (unsigned long)tsLastPointEpoch);
  tsPrefs.putDouble("dist", tsTotalDistM);
  tsPrefs.putULong("npts", tsPointCount);
  tsPrefs.end();
  return true;
}

// Append the GPX closing tags (+ a human-readable summary comment) to `path`.
// Used both for a normal finalise and for boot-time recovery of an interrupted
// ride, hence the explicit parameters rather than the live module state.
static void tsWriteFooter(const String &path, time_t startEpoch, time_t endEpoch,
                          double distM, uint32_t npts, bool recovered) {
  File f = SD.open(path.c_str(), FILE_APPEND);
  if (!f) {
    Serial.printf("[TRIP] ERROR: cannot finalise %s\n", path.c_str());
    return;
  }
  long durationS = (endEpoch > startEpoch) ? (long)(endEpoch - startEpoch) : 0;
  char sIso[24], eIso[24];
  tsIso8601(startEpoch, sIso, sizeof(sIso));
  tsIso8601(endEpoch,   eIso, sizeof(eIso));
  f.print(F("    </trkseg>\n  </trk>\n"));
  f.printf("  <!-- summary: start=%s end=%s duration=%lds "
           "distance=%.3fkm points=%lu%s -->\n",
           sIso, eIso, durationS, distM / 1000.0, (unsigned long)npts,
           recovered ? " (recovered)" : "");
  f.print(F("</gpx>\n"));
  f.flush();
  f.close();
}

// ============================================================================
//  Recovery
// ============================================================================
// If a ride was in progress when power was lost, NVS still holds its filename.
// Finalise that file so it is valid GPX and nothing is lost, then clear NVS.
static void tsRecoverInterruptedTrip() {
  tsPrefs.begin("tripsaver", true);   // read-only
  String path = tsPrefs.getString("active", "");
  time_t start = (time_t)tsPrefs.getULong("start", 0);
  time_t lastPt = (time_t)tsPrefs.getULong("lastPt", 0);
  double dist = tsPrefs.getDouble("dist", 0);
  uint32_t npts = (uint32_t)tsPrefs.getULong("npts", 0);
  tsPrefs.end();

  if (path.length() == 0) return;   // nothing to recover

  if (SD.exists(path.c_str())) {
    Serial.printf("[TRIP] Recovering interrupted ride: %s\n", path.c_str());
    time_t endEpoch = (lastPt > start) ? lastPt : start;
    tsWriteFooter(path, start, endEpoch, dist, npts, true);
  } else {
    Serial.printf("[TRIP] Recovery marker for missing file %s; clearing.\n",
                  path.c_str());
  }

  // Clear the marker either way so we don't try again next boot.
  tsPrefs.begin("tripsaver", false);
  tsPrefs.remove("active");
  tsPrefs.remove("start");
  tsPrefs.remove("lastPt");
  tsPrefs.remove("dist");
  tsPrefs.remove("npts");
  tsPrefs.end();
}

// ============================================================================
//  Trip lifecycle
// ============================================================================
static void tsRecordPoint(time_t epoch);   // fwd decl (defined below)

static void tsStartTrip(time_t startEpoch) {
  tsActiveFile = tsFilenameFor(startEpoch);
  if (!tsWriteHeader(tsActiveFile, startEpoch)) {
    tsActiveFile = "";
    return;   // stay idle; try again on the next movement
  }

  tsState          = TS_RECORDING;
  tsStartEpoch     = startEpoch;
  tsLastPointEpoch = startEpoch;
  tsTotalDistM     = 0;
  tsPointCount     = 0;
  tsBufCount       = 0;
  tsLastRecLat     = gpsLat;
  tsLastRecLng     = gpsLng;
  tsLastFlushMs    = millis();
  tsLastMovementMs = millis();
  tsLastPointMs    = millis();

  // Write the crash-recovery marker up front.
  tsPrefs.begin("tripsaver", false);
  tsPrefs.putString("active", tsActiveFile);
  tsPrefs.putULong("start", (unsigned long)startEpoch);
  tsPrefs.putULong("lastPt", (unsigned long)startEpoch);
  tsPrefs.putDouble("dist", 0.0);
  tsPrefs.putULong("npts", 0);
  tsPrefs.end();

  // Log the origin as the first track point.
  tsRecordPoint(startEpoch);

  Serial.printf("[TRIP] Ride started -> %s\n", tsActiveFile.c_str());
}

static void tsFinaliseTrip(const char *reason) {
  if (tsState != TS_RECORDING) return;
  tsFlushBuffer();
  time_t endEpoch = (tsLastPointEpoch > tsStartEpoch) ? tsLastPointEpoch : tsStartEpoch;
  tsWriteFooter(tsActiveFile, tsStartEpoch, endEpoch, tsTotalDistM, tsPointCount, false);

  // Clear the recovery marker: the file is now complete.
  tsPrefs.begin("tripsaver", false);
  tsPrefs.remove("active");
  tsPrefs.remove("start");
  tsPrefs.remove("lastPt");
  tsPrefs.remove("dist");
  tsPrefs.remove("npts");
  tsPrefs.end();

  Serial.printf("[TRIP] Ride finalised (%s): %s | %.2f km | %lu pts\n",
                reason, tsActiveFile.c_str(), tsTotalDistM / 1000.0,
                (unsigned long)tsPointCount);
  tsState = TS_IDLE;
  tsActiveFile = "";
}

// Buffer the current fix as a track point (called only while recording).
static void tsRecordPoint(time_t epoch) {
  if (tsBufCount >= TRIP_MAX_BUFFER_POINTS) tsFlushBuffer();
  TsPoint &p = tsBuf[tsBufCount++];
  p.lat = gpsLat;
  p.lng = gpsLng;
  p.ele = gpsAltitude;
  p.spd = gpsSpeed;
  p.t   = epoch;

  tsLastRecLat     = gpsLat;
  tsLastRecLng     = gpsLng;
  tsLastPointEpoch = epoch;
  tsPointCount++;
}

// ============================================================================
//  Public API
// ============================================================================

// Mount the card and recover any interrupted ride. Call once from setup /
// goToDashboard(). Safe to call even without a card (feature just disables).
void tripSaverInit() {
  tsSPI.begin(TRIP_SD_SCLK_PIN, TRIP_SD_MISO_PIN, TRIP_SD_MOSI_PIN, TRIP_SD_CS_PIN);
  if (!SD.begin(TRIP_SD_CS_PIN, tsSPI, TRIP_SD_FREQ_HZ)) {
    Serial.println("[TRIP] microSD mount FAILED - Trip Saver disabled.");
    Serial.println("[TRIP]   Check a card is inserted (FAT32) and that the");
    Serial.println("[TRIP]   TRIP_SD_* pins in config.h match your board.");
    tsSdOk = false;
    return;
  }
  tsSdOk = true;

  if (!SD.exists(TRIP_DIR)) {
    if (SD.mkdir(TRIP_DIR)) Serial.println("[TRIP] Created " TRIP_DIR " directory.");
    else                    Serial.println("[TRIP] WARNING: could not create " TRIP_DIR);
  }

  Serial.println("[TRIP] microSD ready - Trip Saver armed.");
  tsRecoverInterruptedTrip();
  tsState = TS_IDLE;
}

// Drive the state machine. Call every loop iteration. Non-blocking.
void tripSaverLoop() {
  if (!tsSdOk) return;

  unsigned long nowMs = millis();

  // Need a real fix with a valid UTC clock to do anything meaningful.
  time_t epoch;
  bool haveTime = gpsGetUtcEpoch(epoch);
  bool moving   = gpsFix && (gpsSpeed >= TRIP_MOVE_SPEED_KMH);

  if (tsState == TS_IDLE) {
    // Auto-start: begin a ride as soon as we're moving with a timestamped fix.
    if (moving && haveTime) {
      tsStartTrip(epoch);
    }
    return;
  }

  // ---- TS_RECORDING ----
  if (moving) tsLastMovementMs = nowMs;

  if (gpsFix && haveTime) {
    // Distance from the last RECORDED point (jitter / simplification filter).
    double d = tsHaversineM(tsLastRecLat, tsLastRecLng, gpsLat, gpsLng);
    if (d > TRIP_MAX_JUMP_METERS) {
      // Implausible jump: treat as a glitch, resync the reference without
      // adding it to the distance total or writing a point.
      tsLastRecLat = gpsLat;
      tsLastRecLng = gpsLng;
    } else {
      bool farEnough  = (d >= TRIP_MIN_MOVE_METERS);
      bool timeEnough = (nowMs - tsLastPointMs >= TRIP_MIN_POINT_INTERVAL_MS);
      if (farEnough && timeEnough) {
        tsTotalDistM += d;
        tsRecordPoint(epoch);
        tsLastPointMs = nowMs;
      }
    }
  }

  // Batch flush on the configured interval.
  if (nowMs - tsLastFlushMs >= TRIP_FLUSH_INTERVAL_MS) {
    tsFlushBuffer();
    tsLastFlushMs = nowMs;
  }

  // Auto-stop: no movement for the inactivity window -> finalise the ride.
  if (nowMs - tsLastMovementMs >= TRIP_INACTIVITY_TIMEOUT_MS) {
    tsFinaliseTrip("inactivity");
  }
}

// True if a ride is actively being recorded (handy for a UI indicator).
bool tripSaverIsRecording() { return tsSdOk && tsState == TS_RECORDING; }

#else  // TRIP_SAVER_ENABLED == 0  -> compile the feature out entirely

void tripSaverInit() {}
void tripSaverLoop() {}
bool tripSaverIsRecording() { return false; }

#endif // TRIP_SAVER_ENABLED

#endif // TRIP_SAVER_H
