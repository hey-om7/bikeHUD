/**
 * auth.js - Authentication routes and JWT middleware
 * 
 * Endpoints:
 *   POST /api/auth/register - Create new user account
 *   POST /api/auth/login    - Login and receive JWT
 *   GET  /api/auth/me       - Get current user (requires token)
 */
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { User } from '../models/User.js';

const JWT_SECRET = process.env.JWT_SECRET || 'tripper-pilot-secret-key-2026';
const JWT_EXPIRES_IN = '30d';

// ===== Generate JWT Token =====
function generateToken(userId) {
  return jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

// ===== JWT Auth Middleware =====
// Attach to any route that requires a logged-in user.
// Sets req.userId on success, returns 401 on failure.
export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ===== Auth Router =====
export function createAuthRouter() {
  const router = Router();

  // POST /api/auth/register
  router.post('/register', async (req, res) => {
    try {
      const { email, password, name } = req.body;

      if (!email || !password || !name) {
        return res.status(400).json({ error: 'Email, password, and name are required' });
      }

      if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }

      // Check if user already exists
      const existing = await User.findOne({ email: email.toLowerCase() });
      if (existing) {
        return res.status(409).json({ error: 'An account with this email already exists' });
      }

      // Create user
      const user = await User.create({ email, password, name });
      const token = generateToken(user._id);

      res.status(201).json({
        token,
        user: user.toJSON(),
      });
    } catch (err) {
      console.error('[AUTH] Register error:', err.message);
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  // POST /api/auth/login
  router.post('/login', async (req, res) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }

      // Find user
      const user = await User.findOne({ email: email.toLowerCase() });
      if (!user) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      // Check password
      const isMatch = await user.comparePassword(password);
      if (!isMatch) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const token = generateToken(user._id);

      res.json({
        token,
        user: user.toJSON(),
      });
    } catch (err) {
      console.error('[AUTH] Login error:', err.message);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  // GET /api/auth/me - Get current authenticated user
  router.get('/me', requireAuth, async (req, res) => {
    try {
      const user = await User.findById(req.userId).populate('devices');
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      res.json({ user: user.toJSON() });
    } catch (err) {
      console.error('[AUTH] Me error:', err.message);
      res.status(500).json({ error: 'Failed to fetch user' });
    }
  });

  return router;
}
