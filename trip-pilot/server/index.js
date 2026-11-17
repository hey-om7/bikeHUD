/**
 * Trip Pilot Navigation Server
 * - REST API for frontend
 * - WebSocket for ESP32-S3 device communication
 * - Route generation and chunking
 */

import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { DeviceManager } from './modules/deviceManager.js';
import { NavigationEngine } from './modules/navigationEngine.js';
import { createApiRouter } from './modules/api.js';
import { renderFrameAt } from './modules/frameRenderer.js';
import { projectOntoRoute } from './modules/navigationEngine.js';
import { connectDB } from './modules/db.js';
import { createAuthRouter } from './modules/auth.js';
import { createDevicePairingRouter, handleDeviceRegister } from './modules/devicePairing.js';
import { Device } from './models/Device.js';
import { Ride } from './models/Ride.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

// ===== Device Manager =====
const deviceManager = new DeviceManager();

// ===== Navigation Engine =====
const navEngine = new NavigationEngine();

// ===== WebSocket Server for ESP32 devices =====
const wss = new WebSocketServer({ server, path: '/device' });

// Mark a socket alive when it answers our ping.
function markAlive() { this.isAlive = true; }

wss.on('connection', (ws) => {
  console.log('[WS] New device connection');

  // Keepalive bookkeeping (see the interval below).
  ws.isAlive = true;
  ws.on('pong', markAlive);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleDeviceMessage(ws, msg);
    } catch (e) {
      console.error('[WS] Invalid message:', e.message);
    }
  });

  ws.on('close', (code, reason) => {
    deviceManager.handleDisconnect(ws);
    console.log(`[WS] Device disconnected (code=${code}${reason && reason.length ? ', ' + reason : ''})`);
  });

  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message);
  });
});

// Server-side keepalive: ping every device every 25s and terminate any that
// missed the previous ping. This keeps the connection alive through WiFi/NAT
// idle timeouts and cleanly reaps half-open sockets (the other half of fixing
// the "randomly disconnects" problem — the device also heartbeats us).
const WS_PING_INTERVAL_MS = 25000;
const wsKeepAlive = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('[WS] Terminating unresponsive device connection');
      deviceManager.handleDisconnect(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* socket already closing */ }
  });
}, WS_PING_INTERVAL_MS);

wss.on('close', () => clearInterval(wsKeepAlive));

// ===== Check Device Pairing Status in DB =====
// When a device connects and identifies itself, verify it's still paired in
// the database. If the user unpaired it while the device was offline, send
// DEVICE_UNPAIRED so it factory resets on next connection.
async function checkDevicePairingStatus(ws, deviceId) {
  try {
    const device = await Device.findOne({ deviceId });
    if (!device || device.paired === false) {
      console.log(`[WS] Device ${deviceId} is unpaired in DB — sending DEVICE_UNPAIRED`);
      sendToDevice(ws, {
        type: 'DEVICE_UNPAIRED',
        deviceId,
      });
    }
  } catch (err) {
    console.error('[WS] Error checking pairing status:', err.message);
  }
}

// ===== Save Ride to DB =====
// Persists a completed/stopped navigation session as a Ride document.
async function saveRide(deviceId, session) {
  if (!session || !session.breadcrumbs || session.breadcrumbs.length < 2) return;
  try {
    // Calculate total distance from breadcrumbs
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

    // Look up owner from Device model
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
    console.log(`[RIDES] Saved ride for ${deviceId}: ${Math.round(totalDist)}m, ${durationSec}s, ${session.breadcrumbs.length} points`);
  } catch (e) {
    console.error('[RIDES] Failed to save ride:', e.message);
  }
}

// ===== Handle Device Messages =====
function handleDeviceMessage(ws, msg) {
  switch (msg.type) {
    case 'DEVICE_IDENTIFY':
      deviceManager.registerDevice(ws, {
        deviceId: msg.deviceId,
        lat: msg.lat,
        lng: msg.lng,
        gpsValid: msg.gpsValid
      });
      console.log(`[WS] Device identified: ${msg.deviceId} at (${msg.lat}, ${msg.lng})`);
      // Check DB pairing status — if the device was unpaired while offline,
      // tell it to factory reset now that it's back online.
      checkDevicePairingStatus(ws, msg.deviceId);
      break;

    case 'GPS_UPDATE':
      deviceManager.updateGPS(msg.deviceId, msg.lat, msg.lng, msg.valid);
      // Closed loop: if the device is navigating and has a valid fix, render the
      // frame for its real map-matched position and push it immediately.
      if (msg.valid) handleLiveGpsFrame(ws, msg.deviceId, msg.lat, msg.lng);
      break;

    case 'REQUEST_CHUNK':
      handleChunkRequest(ws, msg.deviceId, msg.chunkIndex);
      break;

    case 'NAV_CHUNK_CONSUMED':
      if (msg.complete) {
        const session = deviceManager.completeNavigation(msg.deviceId);
        saveRide(msg.deviceId, session);
        sendToDevice(ws, { type: 'NAV_COMPLETE' });
        console.log(`[NAV] Device ${msg.deviceId} completed navigation`);
      }
      break;

    case 'DEVICE_REGISTER':
      handleDeviceRegister(ws, msg, sendToDevice, deviceManager);
      break;

    default:
      console.log(`[WS] Unknown message type: ${msg.type}`);
  }
}

// ===== Closed-loop: render + push the frame for the device's live position =====
// Called on every GPS_UPDATE while navigating. Map-matches the fix onto the
// route, renders ONE frame at that position (heading smoothed across updates),
// and pushes it. This is what makes the display track the real bike position
// and speed instead of a fixed timer.
function handleLiveGpsFrame(ws, deviceId, lat, lng) {
  const session = deviceManager.getNavSession(deviceId);
  if (!session || !session.route || !session.cum) return; // no closed-loop context

  // Record breadcrumb for backtracking
  deviceManager.addBreadcrumb(deviceId, lat, lng, 'esp');

  const geometry = session.route.geometry || [];
  const cum = session.cum;
  const total = cum[cum.length - 1] || 0;
  if (geometry.length < 2 || total <= 0) return;

  // Match near the last known position (the route starts at the bike, so 0 is
  // right for the first fix). Falls back to a whole-route search if nothing in
  // the window is close.
  const match = projectOntoRoute(geometry, cum, lat, lng, { distAlong: session.lastDistAlong || 0 });

  // Reject wild fixes that are nowhere near the route (keeps a bad GPS sample
  // from yanking the view); the device keeps showing the last good frame.
  if (match.offMeters > 60) return;

  // Never step backwards along the route on noise; allow a small tolerance.
  let d = match.distAlong;
  if (d < session.lastDistAlong - 15) d = session.lastDistAlong;
  session.lastDistAlong = d;

  const { frame, heading } = renderFrameAt(session.route, cum, d, session.prevHeading);
  session.prevHeading = heading;
  session.liveSeq += 1;

  frame.chunkIndex = session.liveSeq;
  frame.totalChunks = 0;             // 0 => progress comes from `progress` field
  frame.isLast = d >= total - 8;     // within 8 m of destination

  sendToDevice(ws, frame);

  if (frame.isLast) {
    const session = deviceManager.completeNavigation(deviceId);
    saveRide(deviceId, session);
    console.log(`[NAV] Device ${deviceId} reached destination (live GPS)`);
  }
}

// ===== Send chunk to device =====
function handleChunkRequest(ws, deviceId, chunkIndex) {
  const session = deviceManager.getNavSession(deviceId);
  if (!session || !session.chunks) {
    sendToDevice(ws, { type: 'STOP_NAVIGATION' });
    return;
  }

  if (chunkIndex >= session.chunks.length) {
    sendToDevice(ws, { type: 'NAV_COMPLETE' });
    return;
  }

  const chunk = session.chunks[chunkIndex];

  // Each chunk is already a fully-rendered NAV_CHUNK frame (see frameRenderer).
  // Re-stamp index metadata defensively in case the session was re-chunked.
  sendToDevice(ws, {
    ...chunk,
    chunkIndex,
    totalChunks: session.chunks.length,
    isLast: chunkIndex === session.chunks.length - 1
  });
}

function sendToDevice(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ===== REST API Routes =====
app.use('/api', createApiRouter(deviceManager, navEngine));
app.use('/api/auth', createAuthRouter());
app.use('/api/devices', createDevicePairingRouter(deviceManager));

// ===== Health Check =====
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ===== Dev Mode: Register a simulated device so frontend works without hardware =====
// Only useful when no real device is connected. The real ESP will overwrite this
// entry if it connects with the same ID, or register its own TRIP-XXXXXXXX entry.
function registerSimulatedDevice() {
  // Create a fake WebSocket-like object for the simulated device
  const fakeWs = {
    readyState: 1, // OPEN
    OPEN: 1,
    send(data) {
      const msg = JSON.parse(data);
      console.log(`[SIM] Message to device: ${msg.type}`);
      // Simulate device requesting chunks after START_NAVIGATION
      if (msg.type === 'START_NAVIGATION') {
        setTimeout(() => {
          handleDeviceMessage(fakeWs, { type: 'REQUEST_CHUNK', deviceId: 'tripper-001', chunkIndex: 0 });
        }, 500);
      }
    }
  };

  deviceManager.registerDevice(fakeWs, {
    deviceId: 'tripper-001',
    lat: 18.5534,
    lng: 73.9468,
    gpsValid: false
  });

  console.log('[SIM] Simulated device "tripper-001" registered for development');
}

registerSimulatedDevice();

// ===== Serve Built Frontend (production) =====
// In production (Render), serve the Vite-built static files from ../dist.
// All unmatched routes fall through to index.html for client-side routing.
const distPath = path.join(__dirname, '..', 'dist');
app.use(express.static(distPath));
app.get('*', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

// ===== Start Server =====
async function start() {
  await connectDB();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Trip Pilot running on port ${PORT}`);
    console.log(`[Server] Device WebSocket: ws://0.0.0.0:${PORT}/device`);
    console.log(`[Server] API: http://0.0.0.0:${PORT}/api`);
  });
}

start();
