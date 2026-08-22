/**
 * devicePairing.js - Device registration and pairing endpoints
 * 
 * Endpoints:
 *   POST /api/devices/register   - ESP32 registers itself (creates device doc + pairing code)
 *   POST /api/devices/pair       - User pairs a device by entering the 8-digit code
 *   GET  /api/devices/my         - Get all devices for the logged-in user
 *   DELETE /api/devices/:id      - Unpair a device from the user's account
 * 
 * WebSocket message handled in index.js:
 *   DEVICE_REGISTER - ESP32 sends its unique ID; server responds with pairing code
 */
import { Router } from 'express';
import { Device } from '../models/Device.js';
import { User } from '../models/User.js';
import { requireAuth } from './auth.js';

export function createDevicePairingRouter(deviceManager) {
  const router = Router();

  // POST /api/devices/register
  // Called by the ESP32 via HTTP (or handled via WebSocket — see handleDeviceRegister)
  // Body: { deviceId, firmwareVer? }
  router.post('/register', async (req, res) => {
    try {
      const { deviceId, firmwareVer } = req.body;

      if (!deviceId) {
        return res.status(400).json({ error: 'deviceId is required' });
      }

      // Find existing or create new device
      let device = await Device.findOne({ deviceId });

      if (device && device.paired) {
        // Already paired — just update lastSeen
        device.lastSeen = new Date();
        if (firmwareVer) device.firmwareVer = firmwareVer;
        await device.save();
        return res.json({
          status: 'paired',
          deviceId: device.deviceId,
          name: device.name,
        });
      }

      if (!device) {
        // New device — generate pairing code
        const pairingCode = Device.generatePairingCode();
        device = await Device.create({
          deviceId,
          pairingCode,
          firmwareVer: firmwareVer || '1.0.0',
        });
      } else {
        // Exists but unpaired — refresh code
        device.pairingCode = Device.generatePairingCode();
        device.lastSeen = new Date();
        if (firmwareVer) device.firmwareVer = firmwareVer;
        await device.save();
      }

      res.json({
        status: 'awaiting_pairing',
        deviceId: device.deviceId,
        pairingCode: device.pairingCode,
      });
    } catch (err) {
      console.error('[PAIR] Register error:', err.message);
      res.status(500).json({ error: 'Device registration failed' });
    }
  });

  // POST /api/devices/pair
  // User submits the 8-digit code from the ESP32 screen.
  // Body: { pairingCode }
  router.post('/pair', requireAuth, async (req, res) => {
    try {
      const { pairingCode } = req.body;

      if (!pairingCode) {
        return res.status(400).json({ error: 'Pairing code is required' });
      }

      // Find the device with this code
      const device = await Device.findOne({ pairingCode, paired: false });
      if (!device) {
        return res.status(404).json({ error: 'Invalid or expired pairing code' });
      }

      // Pair device to user
      device.paired = true;
      device.owner = req.userId;
      device.pairingCode = null; // Clear code after pairing
      await device.save();

      // Add device to user's devices array
      await User.findByIdAndUpdate(req.userId, {
        $addToSet: { devices: device._id },
      });

      // Notify the ESP32 device over WebSocket that pairing is complete
      if (deviceManager) {
        const ws = deviceManager.getDeviceSocket(device.deviceId);
        if (ws && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({
            type: 'DEVICE_PAIRED',
            deviceId: device.deviceId,
            name: device.name,
          }));
        }
      }

      res.json({
        status: 'paired',
        device: {
          id: device._id,
          deviceId: device.deviceId,
          name: device.name,
        },
      });
    } catch (err) {
      console.error('[PAIR] Pair error:', err.message);
      res.status(500).json({ error: 'Pairing failed' });
    }
  });

  // GET /api/devices/my
  // Get all devices belonging to the logged-in user
  router.get('/my', requireAuth, async (req, res) => {
    try {
      const devices = await Device.find({ owner: req.userId });
      res.json({ devices });
    } catch (err) {
      console.error('[PAIR] Get devices error:', err.message);
      res.status(500).json({ error: 'Failed to fetch devices' });
    }
  });

  // DELETE /api/devices/:id
  // Unpair a device from the user's account
  router.delete('/:id', requireAuth, async (req, res) => {
    try {
      const device = await Device.findOne({
        _id: req.params.id,
        owner: req.userId,
      });

      if (!device) {
        return res.status(404).json({ error: 'Device not found' });
      }

      device.paired = false;
      device.owner = null;
      device.pairingCode = Device.generatePairingCode(); // Fresh code for re-pairing
      await device.save();

      // Remove from user's devices array
      await User.findByIdAndUpdate(req.userId, {
        $pull: { devices: device._id },
      });

      // Notify the ESP32 to factory reset (clear WiFi creds + pairing state)
      if (deviceManager) {
        const ws = deviceManager.getDeviceSocket(device.deviceId);
        if (ws && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({
            type: 'DEVICE_UNPAIRED',
            deviceId: device.deviceId,
          }));
        }
      }

      res.json({ status: 'unpaired' });
    } catch (err) {
      console.error('[PAIR] Unpair error:', err.message);
      res.status(500).json({ error: 'Unpair failed' });
    }
  });

  return router;
}

// ===== WebSocket Device Registration Handler =====
// Call this from the main WS message handler when type === 'DEVICE_REGISTER'
export async function handleDeviceRegister(ws, msg, sendToDevice, deviceManager) {
  const { deviceId, firmwareVer } = msg;

  if (!deviceId) {
    sendToDevice(ws, { type: 'REGISTER_ERROR', error: 'Missing deviceId' });
    return;
  }

  // Register the socket in the deviceManager so we can reach it when user pairs
  if (deviceManager) {
    deviceManager.registerDevice(ws, {
      deviceId,
      lat: 0,
      lng: 0,
      gpsValid: false,
    });
  }

  try {
    let device = await Device.findOne({ deviceId });

    if (device && device.paired) {
      // Already paired — tell the device to proceed
      sendToDevice(ws, {
        type: 'DEVICE_PAIRED',
        deviceId: device.deviceId,
        name: device.name,
      });
      device.lastSeen = new Date();
      await device.save();
      return;
    }

    if (!device) {
      const pairingCode = Device.generatePairingCode();
      device = await Device.create({
        deviceId,
        pairingCode,
        firmwareVer: firmwareVer || '1.0.0',
      });
    } else {
      // Exists but unpaired — refresh code
      device.pairingCode = Device.generatePairingCode();
      device.lastSeen = new Date();
      if (firmwareVer) device.firmwareVer = firmwareVer;
      await device.save();
    }

    // Send pairing code back to the device for display
    sendToDevice(ws, {
      type: 'PAIRING_CODE',
      deviceId: device.deviceId,
      pairingCode: device.pairingCode,
    });
  } catch (err) {
    console.error('[PAIR] WS register error:', err.message);
    sendToDevice(ws, { type: 'REGISTER_ERROR', error: 'Registration failed' });
  }
}
