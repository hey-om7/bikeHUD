/**
 * db.js - MongoDB connection via Mongoose
 */
import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://heyom:heyom@domesticlabsbluffed.dplarrb.mongodb.net/trip-pilot';

let connected = false;

export async function connectDB() {
  if (connected) return;

  try {
    await mongoose.connect(MONGODB_URI);
    connected = true;
    console.log('[DB] Connected to MongoDB');
  } catch (err) {
    console.error('[DB] MongoDB connection error:', err.message);
    process.exit(1);
  }

  mongoose.connection.on('error', (err) => {
    console.error('[DB] MongoDB error:', err.message);
  });

  mongoose.connection.on('disconnected', () => {
    connected = false;
    console.warn('[DB] MongoDB disconnected');
  });
}
