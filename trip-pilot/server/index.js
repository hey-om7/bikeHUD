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
import { renderChunkToScreen } from './modules/pathRenderer.js';

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

wss.on('connection', (ws) => {
  console.log('[WS] New device connection');

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleDeviceMessage(ws, msg);
    } catch (e) {
      console.error('[WS] Invalid message:', e.message);
    }
  });

  ws.on('close', () => {
    deviceManager.handleDisconnect(ws);
    console.log('[WS] Device disconnected');
  });

  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message);
  });
});

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

  // Render smooth path coordinates for the ESP32 display
  const renderedPayload = renderChunkToScreen(chunk, chunkIndex, session.chunks.length);
  sendToDevice(ws, renderedPayload);
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
