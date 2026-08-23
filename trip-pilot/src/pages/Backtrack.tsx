import { useState, useEffect, useRef } from 'react'
import { MapContainer, TileLayer, Marker, Polyline, useMap } from 'react-leaflet'
import { useNavigate } from 'react-router-dom'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useAuth } from '../context/AuthContext'
import { useBrowserLocation } from '../hooks/useBrowserLocation'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001'
const DEFAULT_CENTER: [number, number] = [18.5534, 73.9468]

const markerIcon = L.icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
})

const startIcon = L.icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
  className: 'dest-marker',
})

interface TrailPoint {
  lat: number
  lng: number
  t: number
}

// Follow user position on map
function FollowPos({ pos }: { pos: [number, number] | null }) {
  const map = useMap()
  const didInit = useRef(false)
  useEffect(() => {
    if (!pos) return
    if (!didInit.current) {
      map.setView(pos, 16, { animate: false })
      didInit.current = true
    } else {
      map.panTo(pos, { animate: true, duration: 0.5 })
    }
  }, [map, pos])
  return null
}

// Fit map to show the entire trail
function FitTrail({ trail }: { trail: [number, number][] }) {
  const map = useMap()
  const didFit = useRef(false)
  useEffect(() => {
    if (trail.length >= 2 && !didFit.current) {
      const bounds = L.latLngBounds(trail.map(p => L.latLng(p[0], p[1])))
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 })
      didFit.current = true
    }
  }, [map, trail])
  return null
}

type BacktrackState = 'idle' | 'recording' | 'navigating'

export default function Backtrack() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const DEVICE_ID = user?.devices?.[0]?.deviceId || 'tripper-001'

  const [state, setState] = useState<BacktrackState>('idle')
  const [trail, setTrail] = useState<TrailPoint[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [navSummary, setNavSummary] = useState<{ distance: string; pointCount: number } | null>(null)

  const browserGps = useBrowserLocation()
  const recordIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Start browser GPS on mount
  useEffect(() => {
    browserGps.start()
    return () => browserGps.stop()
  }, [])

  // Check if there's an existing backtrack session on mount
  useEffect(() => {
    const checkSession = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/backtrack/status/${DEVICE_ID}`)
        if (res.ok) {
          const data = await res.json()
          if (data.active) {
            setTrail(data.trail || [])
            if (data.recording) {
              setState('recording')
            }
          }
        }
      } catch { /* ignore */ }
    }
    checkSession()
  }, [DEVICE_ID])

  // Send GPS points to server while recording
  useEffect(() => {
    if (state !== 'recording') {
      if (recordIntervalRef.current) {
        clearInterval(recordIntervalRef.current)
        recordIntervalRef.current = null
      }
      return
    }

    const record = async () => {
      const loc = browserGps.location
      if (!loc) return
      try {
        const res = await fetch(`${API_BASE}/api/backtrack/record`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId: DEVICE_ID, lat: loc.lat, lng: loc.lng })
        })
        if (res.ok) {
          const data = await res.json()
          if (data.added) {
            setTrail(prev => [...prev, { lat: loc.lat, lng: loc.lng, t: Date.now() }])
          }
        }
      } catch { /* ignore */ }
    }

    record() // immediate first call
    recordIntervalRef.current = setInterval(record, 3000)
    return () => {
      if (recordIntervalRef.current) {
        clearInterval(recordIntervalRef.current)
        recordIntervalRef.current = null
      }
    }
  }, [state, browserGps.location?.lat, browserGps.location?.lng, DEVICE_ID])

  // Start recording
  const handleStartRecording = async () => {
    const loc = browserGps.location
    if (!loc) {
      setError('Waiting for GPS location...')
      return
    }
    setError('')
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/backtrack/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_ID, lat: loc.lat, lng: loc.lng })
      })
      if (res.ok) {
        setState('recording')
        setTrail([{ lat: loc.lat, lng: loc.lng, t: Date.now() }])
      } else {
        const data = await res.json()
        setError(data.error || 'Failed to start recording')
      }
    } catch {
      setError('Connection error')
    }
    setLoading(false)
  }

  // Navigate back
  const handleNavigateBack = async () => {
    if (trail.length < 2) {
      setError('Need at least 2 points to navigate back. Keep moving!')
      return
    }
    setError('')
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/backtrack/navigate-back`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_ID })
      })
      const data = await res.json()
      if (res.ok && data.success) {
        setState('navigating')
        setNavSummary({ distance: data.summary.distance, pointCount: data.pointCount })
      } else {
        setError(data.error || 'Failed to start backtrack navigation')
      }
    } catch {
      setError('Connection error')
    }
    setLoading(false)
  }

  // Cancel / Stop recording
  const handleCancel = async () => {
    try {
      await fetch(`${API_BASE}/api/backtrack/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_ID })
      })
    } catch { /* ignore */ }
    setState('idle')
    setTrail([])
    setNavSummary(null)
  }

  // Current position
  const currentPos: [number, number] | null = browserGps.location
    ? [browserGps.location.lat, browserGps.location.lng]
    : null

  // Trail as lat/lng tuples for the polyline
  const trailLine: [number, number][] = trail.map(p => [p.lat, p.lng])
  const startPoint: [number, number] | null = trail.length > 0 ? [trail[0].lat, trail[0].lng] : null

  // Calculate total distance
  const totalDistM = trail.reduce((sum, p, i) => {
    if (i === 0) return 0
    const prev = trail[i - 1]
    const R = 6371000
    const dLat = (p.lat - prev.lat) * Math.PI / 180
    const dLng = (p.lng - prev.lng) * Math.PI / 180
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(prev.lat * Math.PI / 180) * Math.cos(p.lat * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2
    return sum + R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  }, 0)

  const distDisplay = totalDistM > 1000
    ? `${(totalDistM / 1000).toFixed(1)} km`
    : `${Math.round(totalDistM)} m`

  const center: [number, number] = currentPos ?? DEFAULT_CENTER

  return (
    <div className="app">
      {/* Status Bar */}
      <header className="status-bar">
        <div className="status-bar-left">
          <button className="status-bar-back" onClick={() => navigate('/')} aria-label="Back to menu">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <div className="brand">BACKTRACK</div>
        </div>
        <div className="status-group">
          {state === 'recording' && (
            <div className="backtrack-recording-badge">
              <span className="backtrack-rec-dot" />
              Recording
            </div>
          )}
          {state === 'navigating' && (
            <div className="backtrack-nav-badge">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
              Navigating
            </div>
          )}
        </div>
      </header>

      {/* Map */}
      <div className="map-container">
        <MapContainer center={center} zoom={16} zoomControl={false} attributionControl={false}>
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" maxZoom={19} />
          {state === 'recording' && <FollowPos pos={currentPos} />}
          {state === 'navigating' && <FitTrail trail={trailLine} />}
          {currentPos && <Marker position={currentPos} icon={markerIcon} />}
          {startPoint && trail.length > 1 && <Marker position={startPoint} icon={startIcon} />}
          {trailLine.length >= 2 && (
            <Polyline
              positions={trailLine}
              pathOptions={{ color: '#2dafff', weight: 4, opacity: 0.8 }}
            />
          )}
        </MapContainer>
      </div>

      {/* Bottom Panel */}
      <div className="bottom-panel">
        {error && <div className="error-msg">{error}</div>}

        {state === 'idle' && (
          <div className="backtrack-idle-panel">
            <div className="backtrack-explain">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
              <p>Start recording your path. When you're ready to head back, tap <strong>Navigate Back</strong> to retrace your exact route.</p>
            </div>
            <button
              className="btn btn-navigate"
              onClick={handleStartRecording}
              disabled={loading || !browserGps.location}
            >
              {loading ? 'Starting...' : !browserGps.location ? 'Waiting for GPS...' : 'Start Recording'}
            </button>
          </div>
        )}

        {state === 'recording' && (
          <div className="backtrack-recording-panel">
            <div className="nav-info">
              <div className="nav-stat">
                <span className="stat-value">{distDisplay}</span>
                <span className="stat-label">Distance</span>
              </div>
              <div className="nav-stat">
                <span className="stat-value">{trail.length}</span>
                <span className="stat-label">Points</span>
              </div>
            </div>
            <button
              className="btn btn-backtrack"
              onClick={handleNavigateBack}
              disabled={loading || trail.length < 2}
            >
              {loading ? 'Starting...' : 'Navigate Back'}
            </button>
            <button className="btn btn-stop" onClick={handleCancel}>
              Cancel Recording
            </button>
          </div>
        )}

        {state === 'navigating' && (
          <div className="backtrack-navigating-panel">
            <div className="backtrack-banner">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
              Navigating back to start
            </div>
            <div className="nav-info">
              <div className="nav-stat">
                <span className="stat-value">{navSummary?.distance || distDisplay}</span>
                <span className="stat-label">Distance Back</span>
              </div>
              <div className="nav-stat">
                <span className="stat-value">{navSummary?.pointCount || trail.length}</span>
                <span className="stat-label">Trail Points</span>
              </div>
            </div>
            <button className="btn btn-stop" onClick={handleCancel}>
              Stop Navigation
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
