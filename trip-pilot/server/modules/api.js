/**
 * REST API routes for the frontend
 */

import { Router } from 'express';

export function createApiRouter(deviceManager, navEngine) {
  const router = Router();

  // ===== Device Status =====
  // GET /api/devices - list all connected devices
  router.get('/devices', (req, res) => {
    res.json(deviceManager.getAllDevices());
  });

  // GET /api/device/:id - get specific device status
  router.get('/device/:id', (req, res) => {
    const status = deviceManager.getDeviceStatus(req.params.id);
    if (!status) {
      return res.status(404).json({ error: 'Device not found' });
    }
    res.json(status);
  });

  // GET /api/device/:id/gps - get device GPS (triggers request to device)
  router.get('/device/:id/gps', (req, res) => {
    const device = deviceManager.getDevice(req.params.id);
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }
    // Request fresh GPS from device
    deviceManager.requestGPS(req.params.id);
    // Return current known position
    res.json({
      lat: device.lat,
      lng: device.lng,
      gpsValid: device.gpsValid,
      lastSeen: device.lastSeen
    });
  });

  // ===== Navigation =====
  // POST /api/navigate - start navigation
  // Body: { deviceId, destLat, destLng }
  router.post('/navigate', async (req, res) => {
    const { deviceId, destLat, destLng } = req.body;

    if (!deviceId || destLat === undefined || destLng === undefined) {
      return res.status(400).json({ error: 'Missing deviceId, destLat, or destLng' });
    }

    const device = deviceManager.getDevice(deviceId);
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }
    if (!device.online) {
      return res.status(409).json({ error: 'Device is offline' });
    }

    try {
      // Generate route from device's current position to destination
      const route = await navEngine.generateRoute(
        device.lat, device.lng,
        destLat, destLng
      );

      // Start navigation on the device
      const started = deviceManager.startNavigation(deviceId, route.chunks);
      if (!started) {
        return res.status(500).json({ error: 'Failed to send navigation command to device' });
      }

      res.json({
        success: true,
        summary: route.summary,
        totalChunks: route.chunks.length
      });
    } catch (e) {
      console.error('[API] Navigation error:', e);
      res.status(500).json({ error: 'Failed to generate route' });
    }
  });

  // POST /api/navigate/stop - stop navigation
  router.post('/navigate/stop', (req, res) => {
    const { deviceId } = req.body;
    if (!deviceId) {
      return res.status(400).json({ error: 'Missing deviceId' });
    }
    deviceManager.stopNavigation(deviceId);
    res.json({ success: true });
  });

  return router;
}
