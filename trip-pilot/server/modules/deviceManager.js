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
      lat: lat || 18.5534,
      lng: lng || 73.9468,
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
  startNavigation(deviceId, frames, routeContext = null) {
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
      currentChunk: 0
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

  completeNavigation(deviceId) {
    const device = this.devices.get(deviceId);
    if (device) {
      device.navSession = null;
    }
  }

  stopNavigation(deviceId) {
    const device = this.devices.get(deviceId);
    if (device) {
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
}
