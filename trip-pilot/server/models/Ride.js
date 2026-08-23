/**
 * Ride Model
 *
 * Auto-records every navigation session (directions + backtrack).
 * Documents expire after 30 days via MongoDB TTL index.
 *
 * Schema:
 *   deviceId    - which device this ride belongs to
 *   owner       - reference to User who owns the device
 *   startedAt   - when navigation started
 *   endedAt     - when navigation stopped/completed
 *   duration    - ride duration in seconds
 *   distance    - total distance in meters
 *   path        - array of { lat, lng, t } GPS breadcrumbs
 *   summary     - route summary (distance text, duration text, addresses)
 *   type        - 'navigation' | 'backtrack'
 *   destLat     - destination latitude
 *   destLng     - destination longitude
 *   createdAt   - auto (used by TTL index for 30-day expiry)
 */
import mongoose from 'mongoose';

const ridePointSchema = new mongoose.Schema({
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },
  t: { type: Number, required: true }, // unix timestamp ms
}, { _id: false });

const rideSchema = new mongoose.Schema({
  deviceId: {
    type: String,
    required: true,
    index: true,
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true,
  },
  startedAt: {
    type: Date,
    required: true,
  },
  endedAt: {
    type: Date,
    default: null,
  },
  duration: {
    type: Number, // seconds
    default: 0,
  },
  distance: {
    type: Number, // meters
    default: 0,
  },
  path: {
    type: [ridePointSchema],
    default: [],
  },
  summary: {
    distance: { type: String, default: '' },
    duration: { type: String, default: '' },
    startAddress: { type: String, default: '' },
    endAddress: { type: String, default: '' },
  },
  type: {
    type: String,
    enum: ['navigation', 'backtrack'],
    default: 'navigation',
  },
  destLat: {
    type: Number,
    default: null,
  },
  destLng: {
    type: Number,
    default: null,
  },
}, {
  timestamps: true,
});

// TTL index: auto-delete rides after 30 days
rideSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

// Compound index for efficient queries
rideSchema.index({ deviceId: 1, startedAt: -1 });

export const Ride = mongoose.model('Ride', rideSchema);
