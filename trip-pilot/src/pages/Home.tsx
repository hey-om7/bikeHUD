import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useBrowserLocation } from '../hooks/useBrowserLocation'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001'

interface DeviceStatus {
  deviceId: string
  online: boolean
  lat: number
  lng: number
  gpsValid: boolean
  navigating: boolean
  lastSeen: number
}

export default function Home() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const device = user?.devices?.[0]
  const DEVICE_ID = device?.deviceId || 'tripper-001'

  const [status, setStatus] = useState<DeviceStatus | null>(null)
  const [backtrackAvailable, setBacktrackAvailable] = useState(false)
  const [backtrackLoading, setBacktrackLoading] = useState(false)
  const browserGps = useBrowserLocation()

  // Start watching browser location
  useEffect(() => {
    browserGps.start()
    return () => browserGps.stop()
  }, [])

  // Poll device status every 3 seconds
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/device/${DEVICE_ID}`)
        if (res.ok) {
          setStatus(await res.json())
        } else {
          setStatus(null)
        }
      } catch {
        setStatus(null)
      }
      // Check backtrack availability
      try {
        const btRes = await fetch(`${API_BASE}/api/device/${DEVICE_ID}/backtrack`)
        if (btRes.ok) {
          const btData = await btRes.json()
          setBacktrackAvailable(btData.available)
        }
      } catch { /* ignore */ }
    }
    poll()
    const interval = setInterval(poll, 5000)
    return () => clearInterval(interval)
  }, [DEVICE_ID])

  const isOnline = status?.online ?? false
  const hasTripperGps = !!(status && status.online && status.gpsValid && (status.lat !== 0 || status.lng !== 0))
  const hasBrowserGps = !!browserGps.location
  const gpsSource: 'tripper' | 'browser' | null = hasTripperGps ? 'tripper' : hasBrowserGps ? 'browser' : null

  // Start backtracking directly from home
  const handleBacktrack = async () => {
    if (!isOnline) return
    setBacktrackLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/navigate/backtrack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_ID })
      })
      const data = await res.json()
      if (res.ok && data.success) {
        // Navigate to directions page which will pick up the active nav session
        navigate('/directions')
      }
    } catch { /* ignore */ }
    setBacktrackLoading(false)
  }

  return (
    <div className="home-page">
      <div className="home-header">
        <h1 className="home-brand">TRIPPER PILOT</h1>
        <p className="home-greeting">Hello, {user?.name}</p>
      </div>

      <div className="home-device-card">
        <div className="home-device-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="5" y="2" width="14" height="20" rx="2" />
            <circle cx="12" cy="18" r="1" />
            <path d="M9 6h6" />
          </svg>
        </div>
        <div className="home-device-info">
          <span className="home-device-name">{device?.name || 'My Tripper'}</span>
          <span className="home-device-id">{device?.deviceId}</span>
        </div>
        <div className={`home-device-badge ${isOnline ? 'online' : 'offline'}`}>
          <span className="home-device-badge-dot" />
          {isOnline ? 'Connected' : 'Offline'}
        </div>
      </div>

      {/* GPS Source Indicator */}
      {gpsSource && (
        <div className={`home-gps-source ${gpsSource}`}>
          {gpsSource === 'tripper' ? (
            <>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
              </svg>
              <span>Using Tripper GPS</span>
            </>
          ) : (
            <>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="5" y="2" width="14" height="20" rx="2" />
                <circle cx="12" cy="18" r="1" />
              </svg>
              <span>Using this device's GPS</span>
            </>
          )}
        </div>
      )}

      <div className="home-actions">
        <button className="home-action-btn home-action-directions" onClick={() => navigate('/directions')}>
          <div className="home-action-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="3 11 22 2 13 21 11 13 3 11" />
            </svg>
          </div>
          <div className="home-action-text">
            <span className="home-action-title">Directions</span>
            <span className="home-action-desc">Navigate to a destination</span>
          </div>
          <svg className="home-action-chevron" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>

        {backtrackAvailable && (
          <button
            className="home-action-btn home-action-backtrack"
            onClick={handleBacktrack}
            disabled={backtrackLoading || !isOnline}
          >
            <div className="home-action-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
            </div>
            <div className="home-action-text">
              <span className="home-action-title">{backtrackLoading ? 'Starting...' : 'Backtrack'}</span>
              <span className="home-action-desc">Navigate back to where you started</span>
            </div>
            <svg className="home-action-chevron" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        )}

        <button className="home-action-btn home-action-settings" onClick={() => navigate('/settings')}>
          <div className="home-action-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </div>
          <div className="home-action-text">
            <span className="home-action-title">Settings</span>
            <span className="home-action-desc">Device settings &amp; account</span>
          </div>
          <svg className="home-action-chevron" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>
    </div>
  )
}
