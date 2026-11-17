/**
 * Device Manager - tracks connected ESP32 devices and navigation sessions
 */

export class DeviceManager {
  constructor() {
    // Map<deviceId, { ws, lat, lng, gpsValid, online, lastSeen, navSession }>
    this.devices = new Map();
    // Map<ws, deviceId> for reverse lookup on disconnect
    this.wsToDevice = new Map();
  }

  registerDevice(ws, { deviceId, lat, lng, gpsValid }) {
    const existing = this.devices.get(deviceId);
    // Whether the identify/register payload carries a real position. A no-fix
    // ESP sends (0,0); don't let that wipe a previously known/browser-pushed
    // location (same guard as updateGPS).
    const hasCoords = (typeof lat === 'number' && typeof lng === 'number' &&
                       (lat !== 0 || lng !== 0));

    if (existing) {
      // Reconnect / re-identify: swap in the new socket and refresh liveness,
      // but PRESERVE any in-flight navigation session and last known position.
      // Rebuilding the object here (the old behaviour) dropped navSession and
      // reset coords on every reconnect.
      if (existing.ws && existing.ws !== ws) {
        this.wsToDevice.delete(existing.ws); // retire the stale socket mapping
      }
      existing.ws = ws;
      existing.online = true;
      existing.lastSeen = Date.now();
      existing.gpsValid = gpsValid || false;
      if (hasCoords) { existing.lat = lat; existing.lng = lng; }
    } else {
      this.devices.set(deviceId, {
        ws,
        // Preserve 0/valid numbers as-is; only fall back when truly missing.
        // (Using `lat || default` wrongly turned a 0.0 pre-fix value into Pune.)
        lat: (typeof lat === 'number') ? lat : 18.5534,
        lng: (typeof lng === 'number') ? lng : 73.9468,
        gpsValid: gpsValid || false,
        online: true,
        lastSeen: Date.now(),
        navSession: null
      });
    }
    this.wsToDevice.set(ws, deviceId);
  }

  handleDisconnect(ws) {
    const deviceId = this.wsToDevice.get(ws);
    this.wsToDevice.delete(ws);
    if (!deviceId) return;
    const device = this.devices.get(deviceId);
    // Only mark the device offline if THIS socket is still its active socket.
    // Guards against a delayed close event from a previous connection knocking
    // a freshly reconnected device offline (the ESP shows "connected" but the
    // server wrongly reported "offline").
    if (device && device.ws === ws) {
      device.online = false;
      device.ws = null;
    }
  }

  updateGPS(deviceId, lat, lng, valid) {
    const device = this.devices.get(deviceId);
    if (device) {
      device.gpsValid = valid;
      device.lastSeen = Date.now();
      // Only overwrite coordinates with a real position. A no-fix ESP now pushes
      // periodic updates (valid:false) so we learn when the fix is lost, but its
      // coords may be a (0,0) placeholder — ignore those so we don't wipe out a
      // browser-pushed fallback location that server-side routing depends on.
      const hasCoords = (typeof lat === 'number' && typeof lng === 'number' &&
                         (lat !== 0 || lng !== 0));
      if (hasCoords) {
        device.lat = lat;
        device.lng = lng;
        device.gpsAt = Date.now();
      }
    }
  }

  // Ask the device for a fresh fix and wait (bounded) for it to arrive.
  // Routing used to read device.lat/lng immediately after sending GPS_REQUEST,
  // i.e. BEFORE the reply, so the route started from wherever the device was
  // up to one idle push (5 s) or one browser fallback ago. Resolves either way.
  async requestFreshGPS(deviceId, timeoutMs = 2000) {
    const device = this.devices.get(deviceId);
    if (!device) return false;
    const before = device.gpsAt || 0;
    this.requestGPS(deviceId);
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if ((device.gpsAt || 0) > before) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  getDevice(deviceId) {
    return this.devices.get(deviceId);
  }

  getDeviceSocket(deviceId) {
    const device = this.devices.get(deviceId);
    return device ? device.ws : null;
  }

  getDeviceStatus(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) return null;
    return {
      deviceId,
      online: device.online,
      lat: device.lat,
      lng: device.lng,
      gpsValid: device.gpsValid,
      lastSeen: device.lastSeen,
      navigating: device.navSession !== null
    };
  }

  getAllDevices() {
    const result = [];
    for (const [deviceId, device] of this.devices) {
      result.push({
        deviceId,
        online: device.online,
        lat: device.lat,
        lng: device.lng,
        gpsValid: device.gpsValid,
        lastSeen: device.lastSeen,
        navigating: device.navSession !== null
      });
    }
    return result;
  }

  // Start navigation session.
  // `frames` is the pre-baked frame sequence (preview + dev/offline fallback).
  // `routeContext` = { route, cum } enables closed-loop, position-matched
  // frame rendering driven by real device GPS updates.
  // `meta` = { summary, destLat, destLng } persists info for frontend recovery.
  startNavigation(deviceId, frames, routeContext = null, meta = null) {
    const device = this.devices.get(deviceId);
    if (!device || !device.online) return false;

    device.navSession = {
      chunks: frames,
      route: routeContext ? routeContext.route : null,
      cum: routeContext ? routeContext.cum : null,
      prevHeading: null,      // last smoothed heading (for temporal EMA)
      lastDistAlong: 0,       // last map-matched distance (monotonic guard)
      liveSeq: 0,             // monotonic index for pushed live frames
      startedAt: Date.now(),
      currentChunk: 0,
      // Persisted for frontend state recovery on reconnect/reload
      summary: meta ? meta.summary : null,
      destLat: meta ? meta.destLat : null,
      destLng: meta ? meta.destLng : null,
      // Breadcrumb trail: records actual GPS positions during navigation
      breadcrumbs: [],
      isBacktrack: meta ? (meta.isBacktrack || false) : false
    };

    // Send START_NAVIGATION command to device
    if (device.ws && device.ws.readyState === device.ws.OPEN) {
      device.ws.send(JSON.stringify({ type: 'START_NAVIGATION' }));
      return true;
    }
    return false;
  }

  getNavSession(deviceId) {
    const device = this.devices.get(deviceId);
    return device ? device.navSession : null;
  }

  // Return navigation metadata for frontend state recovery.
  // Returns null if not navigating.
  getNavInfo(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device || !device.navSession) return null;
    const s = device.navSession;
    return {
      navigating: true,
      summary: s.summary || null,
      destLat: s.destLat ?? null,
      destLng: s.destLng ?? null,
      startedAt: s.startedAt,
      rerouting: !!s.rerouting,
      reroutes: s.reroutes || 0,
      reroutedAt: s.reroutedAt || null
    };
  }

  completeNavigation(deviceId) {
    const device = this.devices.get(deviceId);
    if (device) {
      const session = device.navSession;
      // Preserve breadcrumbs for backtracking before clearing the session
      if (session && session.breadcrumbs && session.breadcrumbs.length > 0) {
        device.lastBreadcrumbs = session.breadcrumbs;
        device.lastNavMeta = {
          summary: session.summary,
          destLat: session.destLat,
          destLng: session.destLng,
          startedAt: session.startedAt,
          isBacktrack: session.isBacktrack || false
        };
      }
      device.navSession = null;
      return session; // return for ride recording
    }
    return null;
  }

  stopNavigation(deviceId) {
    const device = this.devices.get(deviceId);
    if (device) {
      const session = device.navSession;
      // Preserve breadcrumbs for backtracking before clearing the session
      if (session && session.breadcrumbs && session.breadcrumbs.length > 0) {
        device.lastBreadcrumbs = session.breadcrumbs;
        device.lastNavMeta = {
          summary: session.summary,
          destLat: session.destLat,
          destLng: session.destLng,
          startedAt: session.startedAt,
          isBacktrack: session.isBacktrack || false
        };
      }
      device.navSession = null;
      if (device.ws && device.ws.readyState === device.ws.OPEN) {
        device.ws.send(JSON.stringify({ type: 'STOP_NAVIGATION' }));
      }
      return session; // return for ride recording
    }
    return null;
  }

  // Request GPS from device
  requestGPS(deviceId) {
    const device = this.devices.get(deviceId);
    if (device && device.ws && device.ws.readyState === device.ws.OPEN) {
      device.ws.send(JSON.stringify({ type: 'GPS_REQUEST' }));
    }
  }

  // ===== Breadcrumb Trail =====

  // Record a GPS breadcrumb during navigation.
  // Deduplicates: skips if within 5m of the last recorded point.
  addBreadcrumb(deviceId, lat, lng, source = 'esp') {
    const device = this.devices.get(deviceId);
    if (!device || !device.navSession) return;

    const crumbs = device.navSession.breadcrumbs;
    if (crumbs.length > 0) {
      const last = crumbs[crumbs.length - 1];
      const dist = this._haversineM(last.lat, last.lng, lat, lng);
      if (dist < 5) return; // within 5m, skip
    }

    crumbs.push({ lat, lng, source, t: Date.now() });
  }

  // Get breadcrumbs from the active navigation session
  getBreadcrumbs(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device || !device.navSession) return null;
    return device.navSession.breadcrumbs;
  }

  // Get breadcrumbs preserved from the last completed/stopped navigation
  getLastBreadcrumbs(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) return null;
    return {
      breadcrumbs: device.lastBreadcrumbs || null,
      meta: device.lastNavMeta || null
    };
  }

  // Clear preserved breadcrumbs (after starting backtrack or explicitly)
  clearLastBreadcrumbs(deviceId) {
    const device = this.devices.get(deviceId);
    if (device) {
      device.lastBreadcrumbs = null;
      device.lastNavMeta = null;
    }
  }

  // Simple haversine distance in meters
  _haversineM(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ===== Standalone Backtrack Session =====
  // Independent of navigation — user explicitly starts/stops recording their path.

  startBacktrackRecording(deviceId, lat, lng) {
    const device = this.devices.get(deviceId);
    if (!device) return false;
    device.backtrackSession = {
      recording: true,
      startedAt: Date.now(),
      trail: [{ lat, lng, t: Date.now() }]
    };
    return true;
  }

  addBacktrackPoint(deviceId, lat, lng) {
    const device = this.devices.get(deviceId);
    if (!device || !device.backtrackSession || !device.backtrackSession.recording) return false;

    const trail = device.backtrackSession.trail;
    if (trail.length > 0) {
      const last = trail[trail.length - 1];
      const dist = this._haversineM(last.lat, last.lng, lat, lng);
      if (dist < 5) return false; // within 5m, skip
    }
    trail.push({ lat, lng, t: Date.now() });
    return true;
  }

  getBacktrackSession(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) return null;
    return device.backtrackSession || null;
  }

  stopBacktrackRecording(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device || !device.backtrackSession) return null;
    device.backtrackSession.recording = false;
    return device.backtrackSession;
  }

  clearBacktrackSession(deviceId) {
    const device = this.devices.get(deviceId);
    if (device) {
      device.backtrackSession = null;
    }
  }
}
