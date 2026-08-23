/**
 * REST API routes for the frontend
 */

import { Router } from 'express';
import { buildFrames } from './frameRenderer.js';
import { cumulativeDistances } from './navigationEngine.js';
import { Ride } from '../models/Ride.js';
import { Device } from '../models/Device.js';

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
    // If the device is online but GPS is not yet valid, proactively request a
    // fresh GPS update from the device. This handles cold-start recovery: after
    // a server restart the device re-identifies with stale state, and the idle
    // GPS push (5s interval) may not have fired yet. The request triggers an
    // immediate GPS_UPDATE response from the ESP.
    if (status.online && !status.gpsValid) {
      deviceManager.requestGPS(req.params.id);
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
    // Record breadcrumb if navigating (browser GPS fallback path recording)
    const session = deviceManager.getNavSession(deviceId);
    if (session) {
      deviceManager.addBreadcrumb(deviceId, parseFloat(lat), parseFloat(lng), 'browser');
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
  router.post('/navigate/stop', async (req, res) => {
    const { deviceId } = req.body;
    if (!deviceId) {
      return res.status(400).json({ error: 'Missing deviceId' });
    }
    const session = deviceManager.stopNavigation(deviceId);
    // Auto-save ride
    if (session && session.breadcrumbs && session.breadcrumbs.length >= 2) {
      try {
        let totalDist = 0;
        for (let i = 1; i < session.breadcrumbs.length; i++) {
          const prev = session.breadcrumbs[i - 1];
          const curr = session.breadcrumbs[i];
          const R = 6371000;
          const dLat = (curr.lat - prev.lat) * Math.PI / 180;
          const dLng = (curr.lng - prev.lng) * Math.PI / 180;
          const a = Math.sin(dLat / 2) ** 2 +
                    Math.cos(prev.lat * Math.PI / 180) * Math.cos(curr.lat * Math.PI / 180) *
                    Math.sin(dLng / 2) ** 2;
          totalDist += R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        }
        const startedAt = new Date(session.startedAt);
        const endedAt = new Date();
        const durationSec = Math.round((endedAt - startedAt) / 1000);

        let owner = null;
        try {
          const deviceDoc = await Device.findOne({ deviceId });
          if (deviceDoc && deviceDoc.owner) owner = deviceDoc.owner;
        } catch { /* ignore */ }

        await Ride.create({
          deviceId,
          owner,
          startedAt,
          endedAt,
          duration: durationSec,
          distance: Math.round(totalDist),
          path: session.breadcrumbs.map(p => ({ lat: p.lat, lng: p.lng, t: p.t })),
          summary: {
            distance: session.summary?.distance || (totalDist > 1000 ? `${(totalDist / 1000).toFixed(1)} km` : `${Math.round(totalDist)} m`),
            duration: session.summary?.duration || `${Math.floor(durationSec / 60)} min`,
            startAddress: session.summary?.startAddress || '',
            endAddress: session.summary?.endAddress || '',
          },
          type: session.isBacktrack ? 'backtrack' : 'navigation',
          destLat: session.destLat ?? null,
          destLng: session.destLng ?? null,
        });
        console.log(`[RIDES] Saved ride for ${deviceId} on stop`);
      } catch (e) {
        console.error('[RIDES] Failed to save ride on stop:', e.message);
      }
    }
    res.json({ success: true });
  });

  // GET /api/device/:id/backtrack - check if backtracking is available
  // Returns the breadcrumb count and metadata from the last navigation
  router.get('/device/:id/backtrack', (req, res) => {
    const deviceId = req.params.id;
    const { breadcrumbs, meta } = deviceManager.getLastBreadcrumbs(deviceId) || {};
    if (!breadcrumbs || breadcrumbs.length < 2) {
      return res.json({ available: false });
    }
    res.json({
      available: true,
      pointCount: breadcrumbs.length,
      meta,
      startPoint: breadcrumbs[0],
      endPoint: breadcrumbs[breadcrumbs.length - 1]
    });
  });

  // POST /api/navigate/backtrack - start backtrack navigation along the reversed breadcrumb path
  // Body: { deviceId }
  router.post('/navigate/backtrack', async (req, res) => {
    const { deviceId } = req.body;

    if (!deviceId) {
      return res.status(400).json({ error: 'Missing deviceId' });
    }

    const device = deviceManager.getDevice(deviceId);
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }
    if (!device.online) {
      return res.status(409).json({ error: 'Device is offline' });
    }

    const { breadcrumbs, meta } = deviceManager.getLastBreadcrumbs(deviceId) || {};
    if (!breadcrumbs || breadcrumbs.length < 2) {
      return res.status(400).json({ error: 'No breadcrumb trail available for backtracking' });
    }

    try {
      // Reverse the breadcrumbs to create a route back to the start
      const reversedCrumbs = [...breadcrumbs].reverse();

      // Convert breadcrumbs to route geometry format: [[lng, lat], ...]
      const geometry = reversedCrumbs.map(c => [c.lng, c.lat]);

      // Generate turn points by detecting heading changes > 35 degrees
      const turnPoints = [];
      let cumDist = 0;
      for (let i = 1; i < geometry.length; i++) {
        const dLat = geometry[i][1] - geometry[i - 1][1];
        const dLng = geometry[i][0] - geometry[i - 1][0];
        const segDist = Math.sqrt(dLat * dLat + dLng * dLng) * 111320; // rough m
        cumDist += segDist;

        if (i < geometry.length - 1) {
          // heading before this point
          const h1 = Math.atan2(geometry[i][0] - geometry[i - 1][0], geometry[i][1] - geometry[i - 1][1]);
          // heading after this point
          const h2 = Math.atan2(geometry[i + 1][0] - geometry[i][0], geometry[i + 1][1] - geometry[i][1]);
          let angleDiff = (h2 - h1) * 180 / Math.PI;
          // Normalize to -180..180
          while (angleDiff > 180) angleDiff -= 360;
          while (angleDiff < -180) angleDiff += 360;

          if (Math.abs(angleDiff) > 35) {
            let direction;
            if (angleDiff > 120) direction = 'sharp-left';
            else if (angleDiff > 45) direction = 'left';
            else if (angleDiff > 0) direction = 'slight-left';
            else if (angleDiff < -120) direction = 'sharp-right';
            else if (angleDiff < -45) direction = 'right';
            else direction = 'slight-right';

            turnPoints.push({
              dist: cumDist,
              direction,
              instruction: `Turn ${direction.replace('-', ' ')}`
            });
          }
        }
      }

      // Calculate total distance
      const cum = cumulativeDistances(geometry);
      const totalDistance = cum[cum.length - 1] || 0;

      // Build the route object compatible with the frame renderer
      const backtrackRoute = {
        geometry,
        turnPoints,
        totalDistance,
        roads: [], // skip nearby roads for immediate backtrack start
        summary: {
          distance: totalDistance > 1000
            ? `${(totalDistance / 1000).toFixed(1)} km`
            : `${Math.round(totalDistance)} m`,
          duration: '', // unknown for backtrack
          startAddress: 'Current location',
          endAddress: meta?.summary?.startAddress || 'Start point'
        }
      };

      const frames = buildFrames(backtrackRoute);

      // The destination is where the original navigation started (first breadcrumb = last in reversed)
      const destLat = breadcrumbs[0].lat;
      const destLng = breadcrumbs[0].lng;

      const started = deviceManager.startNavigation(deviceId, frames, { route: backtrackRoute, cum }, {
        summary: backtrackRoute.summary,
        destLat,
        destLng,
        isBacktrack: true
      });

      if (!started) {
        return res.status(500).json({ error: 'Failed to send backtrack command to device' });
      }

      // Clear the preserved breadcrumbs since we've started using them
      deviceManager.clearLastBreadcrumbs(deviceId);

      res.json({
        success: true,
        summary: backtrackRoute.summary,
        totalChunks: frames.length,
        pointCount: breadcrumbs.length,
        destLat,
        destLng
      });
    } catch (e) {
      console.error('[API] Backtrack error:', e);
      res.status(500).json({ error: 'Failed to start backtrack navigation' });
    }
  });

  // ===== Standalone Backtrack Recording =====
  // Independent of navigation — user starts recording, walks/rides, then navigates back.

  // POST /api/backtrack/start - start recording the user's path
  // Body: { deviceId, lat, lng }
  router.post('/backtrack/start', (req, res) => {
    const { deviceId, lat, lng } = req.body;
    if (!deviceId || lat === undefined || lng === undefined) {
      return res.status(400).json({ error: 'Missing deviceId, lat, or lng' });
    }
    const device = deviceManager.getDevice(deviceId);
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }
    deviceManager.startBacktrackRecording(deviceId, parseFloat(lat), parseFloat(lng));
    console.log(`[BACKTRACK] Started recording for ${deviceId} at (${lat}, ${lng})`);
    res.json({ success: true });
  });

  // POST /api/backtrack/record - add a point to the backtrack trail
  // Body: { deviceId, lat, lng }
  router.post('/backtrack/record', (req, res) => {
    const { deviceId, lat, lng } = req.body;
    if (!deviceId || lat === undefined || lng === undefined) {
      return res.status(400).json({ error: 'Missing deviceId, lat, or lng' });
    }
    const session = deviceManager.getBacktrackSession(deviceId);
    if (!session || !session.recording) {
      return res.status(400).json({ error: 'No active backtrack recording' });
    }
    const added = deviceManager.addBacktrackPoint(deviceId, parseFloat(lat), parseFloat(lng));
    res.json({ success: true, added, pointCount: session.trail.length });
  });

  // GET /api/backtrack/status/:id - get current backtrack session state
  router.get('/backtrack/status/:id', (req, res) => {
    const session = deviceManager.getBacktrackSession(req.params.id);
    if (!session) {
      return res.json({ active: false });
    }
    res.json({
      active: true,
      recording: session.recording,
      pointCount: session.trail.length,
      startedAt: session.startedAt,
      trail: session.trail
    });
  });

  // POST /api/backtrack/navigate-back - stop recording and start navigation back to start
  // Body: { deviceId }
  router.post('/backtrack/navigate-back', async (req, res) => {
    const { deviceId } = req.body;
    if (!deviceId) {
      return res.status(400).json({ error: 'Missing deviceId' });
    }

    const device = deviceManager.getDevice(deviceId);
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }
    if (!device.online) {
      return res.status(409).json({ error: 'Device is offline' });
    }

    const session = deviceManager.getBacktrackSession(deviceId);
    if (!session || session.trail.length < 2) {
      return res.status(400).json({ error: 'Not enough trail points to navigate back (need at least 2)' });
    }

    // Stop recording if still active
    deviceManager.stopBacktrackRecording(deviceId);

    try {
      // Reverse the trail to navigate back to start
      const reversedTrail = [...session.trail].reverse();
      const geometry = reversedTrail.map(p => [p.lng, p.lat]);

      // Detect turn points from heading changes
      const turnPoints = [];
      let cumDist = 0;
      for (let i = 1; i < geometry.length; i++) {
        const dLat = geometry[i][1] - geometry[i - 1][1];
        const dLng = geometry[i][0] - geometry[i - 1][0];
        const segDist = Math.sqrt(dLat * dLat + dLng * dLng) * 111320;
        cumDist += segDist;

        if (i < geometry.length - 1) {
          const h1 = Math.atan2(geometry[i][0] - geometry[i - 1][0], geometry[i][1] - geometry[i - 1][1]);
          const h2 = Math.atan2(geometry[i + 1][0] - geometry[i][0], geometry[i + 1][1] - geometry[i][1]);
          let angleDiff = (h2 - h1) * 180 / Math.PI;
          while (angleDiff > 180) angleDiff -= 360;
          while (angleDiff < -180) angleDiff += 360;

          if (Math.abs(angleDiff) > 35) {
            let direction;
            if (angleDiff > 120) direction = 'sharp-left';
            else if (angleDiff > 45) direction = 'left';
            else if (angleDiff > 0) direction = 'slight-left';
            else if (angleDiff < -120) direction = 'sharp-right';
            else if (angleDiff < -45) direction = 'right';
            else direction = 'slight-right';

            turnPoints.push({ dist: cumDist, direction, instruction: `Turn ${direction.replace('-', ' ')}` });
          }
        }
      }

      const cum = cumulativeDistances(geometry);
      const totalDistance = cum[cum.length - 1] || 0;

      const backtrackRoute = {
        geometry,
        turnPoints,
        totalDistance,
        roads: [],
        summary: {
          distance: totalDistance > 1000
            ? `${(totalDistance / 1000).toFixed(1)} km`
            : `${Math.round(totalDistance)} m`,
          duration: '',
          startAddress: 'Current location',
          endAddress: 'Start point'
        }
      };

      const frames = buildFrames(backtrackRoute);

      const destLat = session.trail[0].lat;
      const destLng = session.trail[0].lng;

      const started = deviceManager.startNavigation(deviceId, frames, { route: backtrackRoute, cum }, {
        summary: backtrackRoute.summary,
        destLat,
        destLng,
        isBacktrack: true
      });

      if (!started) {
        return res.status(500).json({ error: 'Failed to send backtrack command to device' });
      }

      // Clear the backtrack session
      deviceManager.clearBacktrackSession(deviceId);

      res.json({
        success: true,
        summary: backtrackRoute.summary,
        totalChunks: frames.length,
        pointCount: session.trail.length,
        trail: session.trail,
        destLat,
        destLng
      });
    } catch (e) {
      console.error('[API] Backtrack navigate-back error:', e);
      res.status(500).json({ error: 'Failed to start backtrack navigation' });
    }
  });

  // POST /api/backtrack/stop - stop recording without navigating back (cancel)
  // Body: { deviceId }
  router.post('/backtrack/stop', (req, res) => {
    const { deviceId } = req.body;
    if (!deviceId) {
      return res.status(400).json({ error: 'Missing deviceId' });
    }
    deviceManager.clearBacktrackSession(deviceId);
    res.json({ success: true });
  });

  // ===== Rides History =====

  // GET /api/rides/:deviceId - list all rides for a device (sorted newest first)
  // Query params: ?limit=20&offset=0
  router.get('/rides/:deviceId', async (req, res) => {
    const { deviceId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;

    try {
      const rides = await Ride.find({ deviceId })
        .sort({ startedAt: -1 })
        .skip(offset)
        .limit(limit)
        .select('-path') // exclude full path from list for performance
        .lean();

      const total = await Ride.countDocuments({ deviceId });

      res.json({
        rides: rides.map(r => ({
          id: r._id,
          startedAt: r.startedAt,
          endedAt: r.endedAt,
          duration: r.duration,
          distance: r.distance,
          summary: r.summary,
          type: r.type,
          destLat: r.destLat,
          destLng: r.destLng,
          pointCount: r.path ? r.path.length : 0,
        })),
        total,
        limit,
        offset,
      });
    } catch (e) {
      console.error('[RIDES] List error:', e.message);
      res.status(500).json({ error: 'Failed to fetch rides' });
    }
  });

  // GET /api/rides/:deviceId/:rideId - get a single ride with full path
  router.get('/rides/:deviceId/:rideId', async (req, res) => {
    const { deviceId, rideId } = req.params;

    try {
      const ride = await Ride.findOne({ _id: rideId, deviceId }).lean();
      if (!ride) {
        return res.status(404).json({ error: 'Ride not found' });
      }

      res.json({
        id: ride._id,
        startedAt: ride.startedAt,
        endedAt: ride.endedAt,
        duration: ride.duration,
        distance: ride.distance,
        summary: ride.summary,
        type: ride.type,
        destLat: ride.destLat,
        destLng: ride.destLng,
        path: ride.path,
        pointCount: ride.path ? ride.path.length : 0,
      });
    } catch (e) {
      console.error('[RIDES] Detail error:', e.message);
      res.status(500).json({ error: 'Failed to fetch ride' });
    }
  });

  return router;
}
