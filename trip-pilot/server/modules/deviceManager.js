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
    this.wsToDevice.set(ws, deviceId);
  }

  handleDisconnect(ws) {
    const deviceId = this.wsToDevice.get(ws);
    if (deviceId) {
      const device = this.devices.get(deviceId);
      if (device) {
        device.online = false;
        device.ws = null;
      }
      this.wsToDevice.delete(ws);
    }
  }

  updateGPS(deviceId, lat, lng, valid) {
    const device = this.devices.get(deviceId);
    if (device) {
      device.lat = lat;
      device.lng = lng;
      device.gpsValid = valid;
      device.lastSeen = Date.now();
    }
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
      startedAt: s.startedAt
    };
  }

  completeNavigation(deviceId) {
    const device = this.devices.get(deviceId);
    if (device) {
      // Preserve breadcrumbs for backtracking before clearing the session
      if (device.navSession && device.navSession.breadcrumbs && device.navSession.breadcrumbs.length > 0) {
        device.lastBreadcrumbs = device.navSession.breadcrumbs;
        device.lastNavMeta = {
          summary: device.navSession.summary,
          destLat: device.navSession.destLat,
          destLng: device.navSession.destLng,
          startedAt: device.navSession.startedAt,
          isBacktrack: device.navSession.isBacktrack || false
        };
      }
      device.navSession = null;
    }
  }

  stopNavigation(deviceId) {
    const device = this.devices.get(deviceId);
    if (device) {
      // Preserve breadcrumbs for backtracking before clearing the session
      if (device.navSession && device.navSession.breadcrumbs && device.navSession.breadcrumbs.length > 0) {
        device.lastBreadcrumbs = device.navSession.breadcrumbs;
        device.lastNavMeta = {
          summary: device.navSession.summary,
          destLat: device.navSession.destLat,
          destLng: device.navSession.destLng,
          startedAt: device.navSession.startedAt,
          isBacktrack: device.navSession.isBacktrack || false
        };
      }
      device.navSession = null;
      if (device.ws && device.ws.readyState === device.ws.OPEN) {
        device.ws.send(JSON.stringify({ type: 'STOP_NAVIGATION' }));
      }
    }
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
}
