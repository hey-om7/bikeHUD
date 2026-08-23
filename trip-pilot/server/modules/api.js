/**
 * REST API routes for the frontend
 */

import { Router } from 'express';
import { buildFrames } from './frameRenderer.js';
import { cumulativeDistances } from './navigationEngine.js';

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

  // GET /api/getGPSCoordinates/:id - fetch current GPS coordinates from device
  // This is the canonical way to get the device's current location for navigation.
  router.get('/getGPSCoordinates/:id', (req, res) => {
    const device = deviceManager.getDevice(req.params.id);
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }
    // Request fresh GPS fix from hardware
    deviceManager.requestGPS(req.params.id);
    res.json({
      lat: device.lat,
      lng: device.lng,
      gpsValid: device.gpsValid,
      timestamp: device.lastSeen
    });
  });

  // POST /api/device/:id/location - accept browser-sourced GPS location
  // Used as fallback when the ESP's GPS has no fix. The frontend pushes
  // the phone/laptop location so navigation can still work.
  router.post('/device/:id/location', (req, res) => {
    const { lat, lng, source } = req.body;
    if (lat === undefined || lng === undefined) {
      return res.status(400).json({ error: 'Missing lat or lng' });
    }
    const deviceId = req.params.id;
    const device = deviceManager.getDevice(deviceId);
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }
    // Only update if the device's own GPS doesn't have a valid fix
    if (!device.gpsValid) {
      deviceManager.updateGPS(deviceId, parseFloat(lat), parseFloat(lng), false);
      console.log(`[API] Browser GPS pushed for ${deviceId}: (${lat}, ${lng}) source=${source || 'browser'}`);
    }
    res.json({ success: true, used: !device.gpsValid });
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

    // Request fresh GPS from device before routing
    deviceManager.requestGPS(deviceId);

    try {
      // Use device's current GPS coordinates (getGPSCoordinates) as source
      const sourceLat = device.lat;
      const sourceLng = device.lng;
      console.log(`[NAV] Starting navigation from GPS (${sourceLat}, ${sourceLng}) to (${destLat}, ${destLng})`);

      const route = await navEngine.generateRoute(
        sourceLat, sourceLng,
        destLat, destLng
      );
      const frames = buildFrames(route);
      const cum = cumulativeDistances(route.geometry || []);

      // Start navigation on the device. Pass the route context so the server
      // can render position-matched frames as real GPS updates arrive.
      const started = deviceManager.startNavigation(deviceId, frames, { route, cum }, {
        summary: route.summary,
        destLat,
        destLng
      });
      if (!started) {
        return res.status(500).json({ error: 'Failed to send navigation command to device' });
      }

      res.json({
        success: true,
        summary: route.summary,
        totalChunks: frames.length,
        source: { lat: sourceLat, lng: sourceLng }
      });
    } catch (e) {
      console.error('[API] Navigation error:', e);
      res.status(500).json({ error: 'Failed to generate route' });
    }
  });

  // POST /api/navigate/preview - generate all rendered chunks for the ESP preview
  // Returns the full set of pre-rendered NAV_CHUNK payloads so the browser
  // preview can display the exact frames the ESP would see.
  router.post('/navigate/preview', async (req, res) => {
    const { deviceId, destLat, destLng } = req.body;

    if (!deviceId || destLat === undefined || destLng === undefined) {
      return res.status(400).json({ error: 'Missing deviceId, destLat, or destLng' });
    }

    const device = deviceManager.getDevice(deviceId);
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    try {
      const route = await navEngine.generateRoute(
        device.lat, device.lng,
        destLat, destLng
      );
      const renderedChunks = buildFrames(route);

      res.json({
        success: true,
        summary: route.summary,
        chunks: renderedChunks
      });
    } catch (e) {
      console.error('[API] Preview generation error:', e);
      res.status(500).json({ error: 'Failed to generate route preview' });
    }
  });

  // POST /api/navigate/geo - return raw geographic data (route + roads) for verification
  // This gives the same geometry the frame renderer uses, but as lat/lng coords
  // so the web view can render a top-down vector map to verify correctness.
  router.post('/navigate/geo', async (req, res) => {
    const { deviceId, destLat, destLng } = req.body;

    if (!deviceId || destLat === undefined || destLng === undefined) {
      return res.status(400).json({ error: 'Missing deviceId, destLat, or destLng' });
    }

    const device = deviceManager.getDevice(deviceId);
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    try {
      // Use getGPSCoordinates from the device for source
      const sourceLat = device.lat;
      const sourceLng = device.lng;

      const route = await navEngine.generateRoute(
        sourceLat, sourceLng,
        destLat, destLng
      );

      res.json({
        success: true,
        source: { lat: sourceLat, lng: sourceLng },
        destination: { lat: destLat, lng: destLng },
        geometry: route.geometry,       // [[lng,lat], ...] - the main route
        roads: route.roads,             // [[[lng,lat], ...], ...] - surrounding roads
        turnPoints: route.turnPoints,
        totalDistance: route.totalDistance,
        summary: route.summary
      });
    } catch (e) {
      console.error('[API] Geo data generation error:', e);
      res.status(500).json({ error: 'Failed to generate geographic data' });
    }
  });

  // GET /api/device/:id/navigation - get active navigation state for frontend recovery
  // Returns summary, destination, and timing so the UI can resume after a page reload.
  router.get('/device/:id/navigation', (req, res) => {
    const info = deviceManager.getNavInfo(req.params.id);
    if (!info) {
      return res.json({ navigating: false });
    }
    res.json(info);
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
