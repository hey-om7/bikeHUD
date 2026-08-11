/**
 * REST API routes for the frontend
 */

import { Router } from 'express';

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

export function createApiRouter(deviceManager, navEngine) {
  const router = Router();

  // ===== Places Search (Google) =====
  // GET /api/search?q=query&lat=18.55&lng=73.94
  router.get('/search', async (req, res) => {
    const { q, lat, lng } = req.query;
    if (!q || typeof q !== 'string' || q.trim().length < 2) {
      return res.json([]);
    }

    if (!GOOGLE_MAPS_API_KEY) {
      // No key — go straight to Nominatim fallback below
    } else {
      // Google Places API (New) - Text Search
      try {
        const bias = (lat && lng) ? {
          locationBias: {
            circle: {
              center: { latitude: parseFloat(lat), longitude: parseFloat(lng) },
              radius: 50000.0
            }
          }
        } : {};

        const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
            'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location'
          },
          body: JSON.stringify({
            textQuery: q.trim(),
            regionCode: 'IN',
            ...bias
          })
        });

        const data = await response.json();

        if (data.places && data.places.length > 0) {
          const results = data.places.slice(0, 5).map(place => ({
            name: place.displayName?.text || 'Unknown',
            address: place.formattedAddress || '',
            lat: place.location?.latitude,
            lng: place.location?.longitude,
          })).filter(r => r.lat != null && r.lng != null);
          if (results.length > 0) return res.json(results);
        } else if (data.error) {
          console.error(`[API] Google Places (New) error: ${data.error.status} - ${data.error.message}`);
        }
        // Fall through to Nominatim if no results
      } catch (e) {
        console.error('[API] Google Places request failed, falling back to Nominatim:', e.message);
      }
    }

    // Fallback: Nominatim (India-only, nearest first)
    try {
      const encoded = encodeURIComponent(q.trim());
      const nominatimRes = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encoded}&limit=8&addressdetails=1&countrycodes=in&viewbox=68.0,6.0,97.5,37.0&bounded=1`,
        { headers: { 'Accept': 'application/json', 'User-Agent': 'TripPilot/1.0' } }
      );
      const nominatimResults = await nominatimRes.json();
      const refLat = parseFloat(lat) || 18.5534;
      const refLng = parseFloat(lng) || 73.9468;
      nominatimResults.sort((a, b) => {
        const distA = Math.hypot(parseFloat(a.lat) - refLat, parseFloat(a.lon) - refLng);
        const distB = Math.hypot(parseFloat(b.lat) - refLat, parseFloat(b.lon) - refLng);
        return distA - distB;
      });
      return res.json(nominatimResults.slice(0, 5).map(r => ({
        name: r.display_name.split(',')[0],
        address: r.display_name,
        lat: parseFloat(r.lat),
        lng: parseFloat(r.lon),
      })));
    } catch (e2) {
      return res.json([]);
    }
  });

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
