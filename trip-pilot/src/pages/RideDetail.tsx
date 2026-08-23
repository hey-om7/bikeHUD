import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { MapContainer, TileLayer, Polyline, Marker, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useAuth } from '../context/AuthContext'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001'

const startMarker = L.icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  shadowSize: [41, 41],
})

const endMarker = L.icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  shadowSize: [41, 41],
  className: 'dest-marker',
})

interface RidePoint {
  lat: number
  lng: number
  t: number
}

interface RideData {
  id: string
  startedAt: string
  endedAt: string
  duration: number
  distance: number
  summary: {
    distance: string
    duration: string
    startAddress: string
    endAddress: string
  }
  type: 'navigation' | 'backtrack'
  destLat: number | null
  destLng: number | null
  path: RidePoint[]
  pointCount: number
}

function FitBounds({ path }: { path: [number, number][] }) {
  const map = useMap()
  const fitted = useRef(false)
  useEffect(() => {
    if (path.length >= 2 && !fitted.current) {
      const bounds = L.latLngBounds(path.map(p => L.latLng(p[0], p[1])))
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 })
      fitted.current = true
    }
  }, [map, path])
  return null
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) +
    ` at ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const mins = Math.floor(seconds / 60)
  if (mins < 60) return `${mins} min`
  const hrs = Math.floor(mins / 60)
  const remainMins = mins % 60
  return `${hrs}h ${remainMins}m`
}

function formatDistance(meters: number): string {
  if (meters < 1000) return `${meters} m`
  return `${(meters / 1000).toFixed(2)} km`
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export default function RideDetail() {
  const { user } = useAuth()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const DEVICE_ID = user?.devices?.[0]?.deviceId || 'tripper-001'

  const [ride, setRide] = useState<RideData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const fetchRide = async () => {
      setLoading(true)
      try {
        const res = await fetch(`${API_BASE}/api/rides/${DEVICE_ID}/${id}`)
        if (res.ok) {
          setRide(await res.json())
        } else {
          setError('Ride not found')
        }
      } catch {
        setError('Failed to load ride')
      }
      setLoading(false)
    }
    fetchRide()
  }, [DEVICE_ID, id])

  if (loading) {
    return (
      <div className="rides-page">
        <header className="rides-header">
          <button className="settings-back" onClick={() => navigate('/rides')} aria-label="Back">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <h1 className="rides-title">Ride Details</h1>
          <span />
        </header>
        <div className="rides-content"><div className="rides-loading"><p>Loading...</p></div></div>
      </div>
    )
  }

  if (error || !ride) {
    return (
      <div className="rides-page">
        <header className="rides-header">
          <button className="settings-back" onClick={() => navigate('/rides')} aria-label="Back">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <h1 className="rides-title">Ride Details</h1>
          <span />
        </header>
        <div className="rides-content"><div className="rides-empty"><p>{error || 'Ride not found'}</p></div></div>
      </div>
    )
  }

  const pathLine: [number, number][] = ride.path.map(p => [p.lat, p.lng])
  const startPos: [number, number] | null = pathLine.length > 0 ? pathLine[0] : null
  const endPos: [number, number] | null = pathLine.length > 1 ? pathLine[pathLine.length - 1] : null
  const center: [number, number] = startPos || [18.5534, 73.9468]

  // Calculate average speed
  const avgSpeedKmh = ride.duration > 0 ? (ride.distance / 1000) / (ride.duration / 3600) : 0

  return (
    <div className="rides-page">
      <header className="rides-header">
        <button className="settings-back" onClick={() => navigate('/rides')} aria-label="Back">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <h1 className="rides-title">Ride Details</h1>
        <span className={`ride-card-type ${ride.type}`}>
          {ride.type === 'backtrack' ? '↩ Backtrack' : '→ Nav'}
        </span>
      </header>

      {/* Map with full path */}
      <div className="ride-detail-map">
        <MapContainer center={center} zoom={14} zoomControl={false} attributionControl={false}>
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" maxZoom={19} />
          <FitBounds path={pathLine} />
          {pathLine.length >= 2 && (
            <Polyline
              positions={pathLine}
              pathOptions={{ color: '#ff8c00', weight: 4, opacity: 0.9 }}
            />
          )}
          {startPos && <Marker position={startPos} icon={startMarker} />}
          {endPos && <Marker position={endPos} icon={endMarker} />}
        </MapContainer>
      </div>

      {/* Stats */}
      <div className="ride-detail-content">
        <div className="ride-detail-stats">
          <div className="ride-detail-stat">
            <span className="ride-detail-stat-value">{formatDistance(ride.distance)}</span>
            <span className="ride-detail-stat-label">Distance</span>
          </div>
          <div className="ride-detail-stat">
            <span className="ride-detail-stat-value">{formatDuration(ride.duration)}</span>
            <span className="ride-detail-stat-label">Duration</span>
          </div>
          <div className="ride-detail-stat">
            <span className="ride-detail-stat-value">{avgSpeedKmh.toFixed(1)} km/h</span>
            <span className="ride-detail-stat-label">Avg Speed</span>
          </div>
          <div className="ride-detail-stat">
            <span className="ride-detail-stat-value">{ride.pointCount}</span>
            <span className="ride-detail-stat-label">GPS Points</span>
          </div>
        </div>

        {/* Time info */}
        <div className="ride-detail-section">
          <h3 className="ride-detail-section-title">Timing</h3>
          <div className="ride-detail-rows">
            <div className="ride-detail-row">
              <span className="ride-detail-row-label">Started</span>
              <span className="ride-detail-row-value">{formatDate(ride.startedAt)}</span>
            </div>
            <div className="ride-detail-row">
              <span className="ride-detail-row-label">Ended</span>
              <span className="ride-detail-row-value">{formatDate(ride.endedAt)}</span>
            </div>
          </div>
        </div>

        {/* Route info */}
        {(ride.summary.startAddress || ride.summary.endAddress) && (
          <div className="ride-detail-section">
            <h3 className="ride-detail-section-title">Route</h3>
            <div className="ride-detail-rows">
              {ride.summary.startAddress && (
                <div className="ride-detail-row">
                  <span className="ride-detail-row-label">From</span>
                  <span className="ride-detail-row-value">{ride.summary.startAddress}</span>
                </div>
              )}
              {ride.summary.endAddress && (
                <div className="ride-detail-row">
                  <span className="ride-detail-row-label">To</span>
                  <span className="ride-detail-row-value">{ride.summary.endAddress}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Trail timestamps */}
        {ride.path.length > 0 && (
          <div className="ride-detail-section">
            <h3 className="ride-detail-section-title">Trail Timeline</h3>
            <div className="ride-trail-timeline">
              <div className="ride-trail-point ride-trail-start">
                <span className="ride-trail-time">{formatTime(ride.path[0].t)}</span>
                <span className="ride-trail-label">Start</span>
                <span className="ride-trail-coords">{ride.path[0].lat.toFixed(5)}, {ride.path[0].lng.toFixed(5)}</span>
              </div>
              {ride.path.length > 10 && (
                <>
                  {[0.25, 0.5, 0.75].map(frac => {
                    const idx = Math.floor(frac * (ride.path.length - 1))
                    const p = ride.path[idx]
                    return (
                      <div key={frac} className="ride-trail-point">
                        <span className="ride-trail-time">{formatTime(p.t)}</span>
                        <span className="ride-trail-label">{Math.round(frac * 100)}%</span>
                        <span className="ride-trail-coords">{p.lat.toFixed(5)}, {p.lng.toFixed(5)}</span>
                      </div>
                    )
                  })}
                </>
              )}
              <div className="ride-trail-point ride-trail-end">
                <span className="ride-trail-time">{formatTime(ride.path[ride.path.length - 1].t)}</span>
                <span className="ride-trail-label">End</span>
                <span className="ride-trail-coords">{ride.path[ride.path.length - 1].lat.toFixed(5)}, {ride.path[ride.path.length - 1].lng.toFixed(5)}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
