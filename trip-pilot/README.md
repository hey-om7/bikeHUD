# Trip Pilot — Motorcycle Navigation System

A full-stack motorcycle navigation system with a companion ESP32-S3 HUD device. The system provides turn-by-turn navigation rendered on a 2-inch display mounted on the bike, controlled from a mobile web app.

## Architecture

```
┌─────────────────┐       WebSocket        ┌──────────────────┐
│  ESP32-S3 HUD   │◄─────────────────────►│   Node.js Server  │
│  (2" Display)   │   (nav frames, GPS)    │   (Port 3001)     │
└─────────────────┘                        └────────┬─────────┘
                                                    │ REST API
                                                    │
                                           ┌────────▼─────────┐
                                           │   React Web App   │
                                           │  (Vite Frontend)  │
                                           └──────────────────┘
                                                    │
                                           ┌────────▼─────────┐
                                           │     MongoDB       │
                                           │  (Users/Devices)  │
                                           └──────────────────┘
```

## Features

- **User Auth** — Email/password registration & login with JWT tokens
- **Device Pairing** — QR code or 8-digit code pairing flow between app and ESP32
- **Live Navigation** — Closed-loop GPS-driven frame rendering on the ESP32 display
- **Place Search** — Google Maps autocomplete for destination search
- **Device Management** — Pair/unpair devices, factory reset via app
- **Offline Unpair** — If device is offline when unpaired, it auto-resets on next server connection

## Project Structure

```
trip-pilot/
├── .env                    # Frontend env vars (Vite)
├── .env.example            # Frontend env template
├── package.json            # Frontend dependencies + scripts
├── vite.config.ts          # Vite configuration
├── tsconfig.json           # TypeScript config
├── index.html              # Entry HTML
├── src/
│   ├── main.tsx            # App entry + routing + auth guards
│   ├── App.tsx             # Maps/navigation page
│   ├── App.css             # All styles
│   ├── context/
│   │   └── AuthContext.tsx # JWT auth state management
│   └── pages/
│       ├── Login.tsx       # Login page
│       ├── Signup.tsx      # Registration page
│       ├── PairDevice.tsx  # QR scan / code entry pairing page
│       ├── Home.tsx        # Main menu (Directions / Settings)
│       └── Settings.tsx    # Account, device info, unpair, logout
├── server/
│   ├── .env                # Server env vars
│   ├── .env.example        # Server env template
│   ├── package.json        # Server dependencies
│   ├── index.js            # Express + WebSocket server entry
│   ├── models/
│   │   ├── User.js         # Mongoose user schema
│   │   └── Device.js       # Mongoose device schema
│   └── modules/
│       ├── db.js           # MongoDB connection
│       ├── auth.js         # Auth routes + JWT middleware
│       ├── devicePairing.js # Device registration & pairing
│       ├── deviceManager.js # In-memory device/WebSocket tracking
│       ├── api.js          # Navigation & search API routes
│       ├── navigationEngine.js # Route processing
│       └── frameRenderer.js    # Nav frame generation for ESP32
└── public/
    ├── esp-preview.html    # ESP display simulator (dev tool)
    ├── favicon.svg
    └── icons.svg
```

## Setup

### Prerequisites

- Node.js 18+
- MongoDB Atlas account (or local MongoDB)
- Google Maps API key (Directions + Places APIs enabled)

### 1. Clone & Install

```bash
cd trip-pilot

# Install frontend dependencies
npm install

# Install server dependencies
cd server && npm install && cd ..
```

### 2. Configure Environment Variables

```bash
# Frontend
cp .env.example .env
# Edit .env — set VITE_API_URL to your server address

# Server
cp server/.env.example server/.env
# Edit server/.env — set MONGODB_URI, JWT_SECRET, GOOGLE_MAPS_API_KEY
```

### 3. Run Locally (Dev)

```bash
npm run server
```

This starts both:
- **Backend** (Express + WebSocket) on port 3001
- **Frontend** (Vite dev server) on port 5173

### 4. Run in Production

```bash
# Build frontend
npm run build

# Start server (serves built frontend + API)
npm start
```

## Deployment (Render)

| Setting | Value |
|---------|-------|
| Root Directory | `trip-pilot` |
| Build Command | `npm run render-build` |
| Start Command | `npm start` |

Set these environment variables in Render dashboard:
- `MONGODB_URI`
- `JWT_SECRET`
- `GOOGLE_MAPS_API_KEY`

The server reads `PORT` from the environment (Render sets this automatically).

## NPM Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Vite dev server only |
| `npm run server` | Backend + Vite together (local development) |
| `npm start` | Production: Node server serves built React app |
| `npm run build` | TypeScript check + Vite production build |
| `npm run render-build` | Full build for Render (installs server deps + builds frontend) |

## API Endpoints

### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | Create account (email, password, name) |
| POST | `/api/auth/login` | Login, returns JWT |
| GET | `/api/auth/me` | Get current user + devices (requires token) |

### Devices
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/devices/register` | ESP32 registers itself, gets pairing code |
| POST | `/api/devices/pair` | User submits 8-digit code to pair (requires token) |
| GET | `/api/devices/my` | List user's paired devices (requires token) |
| DELETE | `/api/devices/:id` | Unpair a device (requires token) |

### Navigation
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/navigate` | Start navigation to destination |
| POST | `/api/navigate/stop` | Stop active navigation |
| GET | `/api/device/:id` | Get device status (online, GPS, navigating) |
| GET | `/api/search` | Place search autocomplete |

### WebSocket (`/device`)
| Message Type | Direction | Description |
|--------------|-----------|-------------|
| `DEVICE_REGISTER` | ESP→Server | Register new device, get pairing code |
| `PAIRING_CODE` | Server→ESP | Pairing code assigned |
| `DEVICE_PAIRED` | Server→ESP | User paired this device |
| `DEVICE_UNPAIRED` | Server→ESP | User unpaired, device should factory reset |
| `DEVICE_IDENTIFY` | ESP→Server | Paired device identifies on connect |
| `GPS_UPDATE` | ESP→Server | Live GPS position push |
| `NAV_CHUNK` | Server→ESP | Navigation frame (rendered path data) |
| `START_NAVIGATION` | Server→ESP | Begin navigation mode |
| `STOP_NAVIGATION` | Server→ESP | End navigation mode |

## Database Schema

### Users Collection
```json
{
  "email": "user@example.com",
  "password": "$2b$12$...",
  "name": "User Name",
  "devices": ["<ObjectId>"],
  "createdAt": "...",
  "updatedAt": "..."
}
```

### Devices Collection
```json
{
  "deviceId": "TRIP-AABBCCDD",
  "pairingCode": "50643048",
  "paired": true,
  "owner": "<ObjectId>",
  "name": "My Tripper",
  "lastSeen": "...",
  "lastLat": 18.5534,
  "lastLng": 73.9468,
  "firmwareVer": "5.0.0",
  "createdAt": "...",
  "updatedAt": "..."
}
```

## User Flow

```
Open App → Login/Signup
    ↓
No device? → Pair Device (scan QR or enter 8-digit code)
    ↓
Home Menu
  ├── Directions → Map view → Search/tap destination → Start Navigation
  └── Settings → Account info, Unpair Device, Sign Out
```

## ESP32 Boot Flow

```
Splash (3s)
  ├── Has WiFi + Paired → Dashboard
  ├── No WiFi → WiFi Setup screen → (connected) → Pairing screen
  └── Has WiFi, not paired → Pairing screen (QR + code)
```

When unpaired from the app:
- Online: receives `DEVICE_UNPAIRED` instantly → factory reset
- Offline: on next server connection, server checks DB → sends `DEVICE_UNPAIRED` → factory reset
