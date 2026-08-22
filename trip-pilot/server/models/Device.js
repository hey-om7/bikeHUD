/**
 * Device Model
 * 
 * Schema:
 *   deviceId     - unique hardware ID from the ESP32 (e.g. MAC-derived)
 *   pairingCode  - 8-digit code displayed on the ESP screen for manual pairing
 *   paired       - whether this device has been claimed by a user
 *   owner        - reference to the User who paired this device (null if unpaired)
 *   name         - user-given friendly name (e.g. "My Bike")
 *   lastSeen     - last time the device connected to the server
 *   lastLat/Lng  - last known GPS coordinates
 *   firmwareVer  - reported firmware version string
 *   createdAt    - when the device first registered itself
 *   updatedAt    - auto timestamp
 * 
 * Flow:
 *   1. ESP32 boots, generates a unique deviceId (from MAC address)
 *   2. ESP32 connects to server via WebSocket and sends DEVICE_REGISTER
 *   3. Server creates/finds the device doc, generates an 8-digit pairing code
 *   4. Server sends the code back; ESP32 displays the code + QR on screen
 *   5. User opens the app, enters code or scans QR -> server pairs device to user
 *   6. Once paired, server tells ESP32 to proceed to WiFi config / dashboard
 */
import mongoose from 'mongoose';

const deviceSchema = new mongoose.Schema({
  deviceId: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },
  pairingCode: {
    type: String,
    default: null,
    index: true,
  },
  paired: {
    type: Boolean,
    default: false,
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  name: {
    type: String,
    default: 'My Tripper',
    trim: true,
  },
  lastSeen: {
    type: Date,
    default: Date.now,
  },
  lastLat: {
    type: Number,
    default: 0,
  },
  lastLng: {
    type: Number,
    default: 0,
  },
  firmwareVer: {
    type: String,
    default: '1.0.0',
  },
}, {
  timestamps: true,
});

// Generate a random 8-digit pairing code
deviceSchema.statics.generatePairingCode = function () {
  return String(Math.floor(10000000 + Math.random() * 90000000));
};

export const Device = mongoose.model('Device', deviceSchema);
