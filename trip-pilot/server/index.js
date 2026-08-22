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
import { DeviceManager } from './modules/deviceManager.js';
import { NavigationEngine } from './modules/navigationEngine.js';
import { createApiRouter } from './modules/api.js';
import { renderFrameAt } from './modules/frameRenderer.js';
import { projectOntoRoute } from './modules/navigationEngine.js';

const PORT = 3001;

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
        deviceManager.completeNavigation(msg.deviceId);
        sendToDevice(ws, { type: 'NAV_COMPLETE' });
        console.log(`[NAV] Device ${msg.deviceId} completed navigation`);
      }
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

  const geometry = session.route.geometry || [];
  const cum = session.cum;
  const total = cum[cum.length - 1] || 0;
  if (geometry.length < 2 || total <= 0) return;

  const match = projectOntoRoute(geometry, cum, lat, lng);

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
    deviceManager.completeNavigation(deviceId);
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

// ===== Health Check =====
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ===== Dev Mode: Register a simulated device so frontend works without hardware =====
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

// ===== Start Server =====
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Trip Pilot running on port ${PORT}`);
  console.log(`[Server] Device WebSocket: ws://0.0.0.0:${PORT}/device`);
  console.log(`[Server] API: http://0.0.0.0:${PORT}/api`);
});
