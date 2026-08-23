import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001'

interface RideSummary {
  id: string
  startedAt: string
  endedAt: string
  duration: number // seconds
  distance: number // meters
  summary: {
    distance: string
    duration: string
    startAddress: string
    endAddress: string
  }
  type: 'navigation' | 'backtrack'
  pointCount: number
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr)
  const now = new Date()
  const diffDays = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return `Today, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  if (diffDays === 1) return `Yesterday, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  if (diffDays < 7) return `${d.toLocaleDateString([], { weekday: 'short' })}, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) + `, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
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
  return `${(meters / 1000).toFixed(1)} km`
}

export default function Rides() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const DEVICE_ID = user?.devices?.[0]?.deviceId || 'tripper-001'

  const [rides, setRides] = useState<RideSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [total, setTotal] = useState(0)

  useEffect(() => {
    const fetchRides = async () => {
      setLoading(true)
      try {
        const res = await fetch(`${API_BASE}/api/rides/${DEVICE_ID}?limit=50`)
        if (res.ok) {
          const data = await res.json()
          setRides(data.rides)
          setTotal(data.total)
        }
      } catch { /* ignore */ }
      setLoading(false)
    }
    fetchRides()
  }, [DEVICE_ID])

  return (
    <div className="rides-page">
      <header className="rides-header">
        <button className="settings-back" onClick={() => navigate('/')} aria-label="Back">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <h1 className="rides-title">Rides</h1>
        <span className="rides-count">{total} ride{total !== 1 ? 's' : ''}</span>
      </header>

      <div className="rides-content">
        {loading ? (
          <div className="rides-loading">
            <p>Loading rides...</p>
          </div>
        ) : rides.length === 0 ? (
          <div className="rides-empty">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" />
              <path d="M12 6v6l4 2" />
            </svg>
            <p>No rides yet</p>
            <span>Your navigation sessions will appear here automatically. Rides are kept for 30 days.</span>
          </div>
        ) : (
          <div className="rides-list">
            {rides.map(ride => (
              <button
                key={ride.id}
                className="ride-card"
                onClick={() => navigate(`/rides/${ride.id}`)}
              >
                <div className="ride-card-header">
                  <span className="ride-card-date">{formatDate(ride.startedAt)}</span>
                  <span className={`ride-card-type ${ride.type}`}>
                    {ride.type === 'backtrack' ? '↩ Backtrack' : '→ Navigation'}
                  </span>
                </div>
                <div className="ride-card-stats">
                  <div className="ride-card-stat">
                    <span className="ride-card-stat-value">{formatDistance(ride.distance)}</span>
                    <span className="ride-card-stat-label">Distance</span>
                  </div>
                  <div className="ride-card-stat">
                    <span className="ride-card-stat-value">{formatDuration(ride.duration)}</span>
                    <span className="ride-card-stat-label">Duration</span>
                  </div>
                  <div className="ride-card-stat">
                    <span className="ride-card-stat-value">{ride.pointCount}</span>
                    <span className="ride-card-stat-label">Points</span>
                  </div>
                </div>
                {(ride.summary.startAddress || ride.summary.endAddress) && (
                  <div className="ride-card-route">
                    {ride.summary.startAddress && (
                      <span className="ride-card-address">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                          <circle cx="12" cy="12" r="4" />
                        </svg>
                        {ride.summary.startAddress}
                      </span>
                    )}
                    {ride.summary.endAddress && (
                      <span className="ride-card-address">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                          <circle cx="12" cy="12" r="4" />
                        </svg>
                        {ride.summary.endAddress}
                      </span>
                    )}
                  </div>
                )}
                <svg className="ride-card-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
            ))}
          </div>
        )}

        <p className="rides-footer-note">Rides are automatically recorded and kept for 30 days.</p>
      </div>
    </div>
  )
}
