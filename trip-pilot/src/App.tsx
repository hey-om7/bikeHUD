import { useState, useEffect, useCallback, useRef } from 'react'
import { MapContainer, TileLayer, Marker, useMapEvents, useMap } from 'react-leaflet'
import { useNavigate } from 'react-router-dom'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './App.css'
import { useAuth } from './context/AuthContext'
import { useBrowserLocation } from './hooks/useBrowserLocation'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001'
const DEFAULT_CENTER: [number, number] = [18.5534, 73.9468] // Kharadi, Pune

// Fix default marker icons for Leaflet + bundler
const defaultIcon = L.icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
})

const destIcon = L.icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
  className: 'dest-marker',
})

interface DeviceStatus {
  deviceId: string
  online: boolean
  lat: number
  lng: number
  gpsValid: boolean
  navigating: boolean
  lastSeen: number
}

interface NavSummary {
  distance: string
  duration: string
  startAddress: string
  endAddress: string
}

interface SearchResult {
  name: string
  address: string
  lat: number
  lng: number
}

// ===== Map Click Handler =====
function MapClickHandler({ onMapClick, disabled }: { onMapClick: (lat: number, lng: number) => void; disabled: boolean }) {
  useMapEvents({
    click(e) {
      if (!disabled) {
        onMapClick(e.latlng.lat, e.latlng.lng)
      }
    },
  })
  return null
}

// ===== Follow the device's live GPS position =====
// On the first valid GPS fix, centers the map on the device at a low zoom then
// smoothly zooms in — a subtle "here you are" animation. After that it gently
// pans to keep the device in view as it moves.
function FollowDevice({ pos, enabled }: { pos: [number, number] | null; enabled: boolean }) {
  const map = useMap()
  const didInitialZoom = useRef(false)
  useEffect(() => {
    if (!pos || !enabled) return
    if (!didInitialZoom.current) {
      // Immediately set the map to the device position at a wide zoom, then
      // smoothly zoom in — gives a subtle "locating you" feel without flying
      // across from an unrelated city.
      map.setView(pos, 12, { animate: false })
      setTimeout(() => {
        map.flyTo(pos, 16, { duration: 1.5 })
      }, 200)
      didInitialZoom.current = true
    } else {
      map.panTo(pos, { animate: true, duration: 0.5 })
    }
  }, [map, pos, enabled])
  return null
}

// ===== Fly to destination when selected =====
function FlyToDest({ lat, lng }: { lat: number | null; lng: number | null }) {
  const map = useMap()
  useEffect(() => {
    if (lat !== null && lng !== null) {
      map.flyTo([lat, lng], 15, { duration: 0.8 })
    }
  }, [map, lat, lng])
  return null
}

function App() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const DEVICE_ID = user?.devices?.[0]?.deviceId || 'tripper-001'

  const [device, setDevice] = useState<DeviceStatus | null>(null)
  const [destLat, setDestLat] = useState<number | null>(null)
  const [destLng, setDestLng] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [suggestions, setSuggestions] = useState<SearchResult[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [searching, setSearching] = useState(false)
  const [navigating, setNavigating] = useState(false)
  const [navSummary, setNavSummary] = useState<NavSummary | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [backtrackAvailable, setBacktrackAvailable] = useState(false)
  const [isBacktracking, setIsBacktracking] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchRef = useRef<HTMLDivElement>(null)

  // Browser GPS fallback
  const browserGps = useBrowserLocation()

  // Start watching browser location immediately (user will be prompted for permission)
  useEffect(() => {
    browserGps.start()
    return () => browserGps.stop()
  }, [])

  // Push browser GPS to server periodically when ESP has no fix but browser does
  // This keeps the server's device position updated for live navigation rendering
  useEffect(() => {
    if (!browserGps.location || !device?.online || (device.gpsValid && (device.lat !== 0 || device.lng !== 0))) {
      return // ESP has fix, no need to push browser location
    }
    const push = async () => {
      try {
        await fetch(`${API_BASE}/api/device/${DEVICE_ID}/location`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lat: browserGps.location!.lat,
            lng: browserGps.location!.lng,
            source: 'browser'
          })
        })
      } catch { /* ignore */ }
    }
    push()
    const interval = setInterval(push, 3000)
    return () => clearInterval(interval)
  }, [browserGps.location?.lat, browserGps.location?.lng, device?.online, device?.gpsValid, DEVICE_ID])

  // Poll device status
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/device/${DEVICE_ID}`)
        if (res.ok) {
          const data = await res.json()
          setDevice(data)
          if (data.navigating) {
            setNavigating(true)
            // Recover navigation state if we don't have it locally (page reload)
            if (!navSummary) {
              try {
                const navRes = await fetch(`${API_BASE}/api/device/${DEVICE_ID}/navigation`)
                if (navRes.ok) {
                  const navData = await navRes.json()
                  if (navData.navigating) {
                    if (navData.summary) setNavSummary(navData.summary)
                    if (navData.destLat != null && navData.destLng != null) {
                      setDestLat(navData.destLat)
                      setDestLng(navData.destLng)
                    }
                  }
                }
              } catch { /* ignore recovery failure */ }
            }
          }
          else if (navigating && !data.navigating) {
            setNavigating(false)
            setNavSummary(null)
            setDestLat(null)
            setDestLng(null)
            setIsBacktracking(false)
            // Check if backtracking is available
            try {
              const btRes = await fetch(`${API_BASE}/api/device/${DEVICE_ID}/backtrack`)
              if (btRes.ok) {
                const btData = await btRes.json()
                setBacktrackAvailable(btData.available)
              }
            } catch { /* ignore */ }
          }
        } else {
          // Device not yet registered on the server (e.g. after a server restart
          // before the ESP reconnects). Show as offline rather than null.
          setDevice(prev => prev ? { ...prev, online: false, gpsValid: false } : null)
        }
      } catch {
        // Network error reaching the server — preserve last known state
        setDevice(prev => prev ? { ...prev, online: false } : null)
      }
    }
    poll()
    const interval = setInterval(poll, 3000)
    return () => clearInterval(interval)
  }, [navigating, navSummary])

  // Close suggestions when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowSuggestions(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('touchstart', handleClickOutside as EventListener)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('touchstart', handleClickOutside as EventListener)
    }
  }, [])

  // Debounced search — fires 400ms after user stops typing
  const handleSearchInput = (value: string) => {
    setSearchQuery(value)
    setError('')

    if (debounceRef.current) clearTimeout(debounceRef.current)

    if (value.trim().length < 3) {
      setSuggestions([])
      setShowSuggestions(false)
      return
    }

    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const encoded = encodeURIComponent(value.trim())
        const lat = device?.lat ?? browserGps.location?.lat ?? DEFAULT_CENTER[0]
        const lng = device?.lng ?? browserGps.location?.lng ?? DEFAULT_CENTER[1]

        let results: SearchResult[] = []

        // Try server API first
        try {
          const res = await fetch(
            `${API_BASE}/api/search?q=${encoded}&lat=${lat}&lng=${lng}`,
            { signal: AbortSignal.timeout(4000) }
          )
          if (res.ok) {
            results = await res.json()
          }
        } catch {
          // Server unreachable or timed out — fall through to client-side fallback
        }

        // Fallback: call Nominatim directly from the browser if server returned nothing
        if (results.length === 0) {
          try {
            const nomRes = await fetch(
              `https://nominatim.openstreetmap.org/search?format=json&q=${encoded}&limit=5&addressdetails=1&countrycodes=in&viewbox=68.0,6.0,97.5,37.0&bounded=1`,
              { headers: { 'Accept': 'application/json' } }
            )
            if (nomRes.ok) {
              const nomData = await nomRes.json()
              const refLat = Number(lat)
              const refLng = Number(lng)
              nomData.sort((a: any, b: any) => {
                const distA = Math.hypot(parseFloat(a.lat) - refLat, parseFloat(a.lon) - refLng)
                const distB = Math.hypot(parseFloat(b.lat) - refLat, parseFloat(b.lon) - refLng)
                return distA - distB
              })
              results = nomData.slice(0, 5).map((r: any) => ({
                name: r.display_name.split(',')[0],
                address: r.display_name,
                lat: parseFloat(r.lat),
                lng: parseFloat(r.lon),
              }))
            }
          } catch {
            // Both server and Nominatim failed
          }
        }

        setSuggestions(results)
        setShowSuggestions(results.length > 0)
      } catch {
        setSuggestions([])
        setShowSuggestions(false)
      }
      setSearching(false)
    }, 400)
  }

  // Select a suggestion
  const handleSelectSuggestion = (result: SearchResult) => {
    setDestLat(result.lat)
    setDestLng(result.lng)
    setSearchQuery(result.name)
    setSuggestions([])
    setShowSuggestions(false)
    setError('')
  }

  // Handle map click to set destination
  const handleMapClick = useCallback((lat: number, lng: number) => {
    if (navigating) return
    setDestLat(lat)
    setDestLng(lng)
    setError('')
    setShowSuggestions(false)
  }, [navigating])

  // Start navigation
  const handleStartNavigation = async () => {
    if (destLat === null || destLng === null) return
    if (!device?.online) {
      setError('Device is offline')
      return
    }
    setLoading(true)
    setError('')

    // If ESP doesn't have GPS fix, push browser location to server first
    if (!hasFix && browserGps.location) {
      try {
        await fetch(`${API_BASE}/api/device/${DEVICE_ID}/location`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lat: browserGps.location.lat,
            lng: browserGps.location.lng,
            source: 'browser'
          })
        })
      } catch {
        // Non-fatal — server will use whatever position it has
      }
    }

    try {
      const res = await fetch(`${API_BASE}/api/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_ID, destLat, destLng })
      })
      const data = await res.json()
      if (res.ok && data.success) {
        setNavigating(true)
        setNavSummary(data.summary)

        // Open ESP preview in a new tab so user can monitor the route visually
        const previewParams = new URLSearchParams({
          api: API_BASE,
          device: DEVICE_ID,
          destLat: String(destLat),
          destLng: String(destLng),
        })
        window.open(`/esp-preview.html?${previewParams.toString()}`, '_blank')
      } else {
        setError(data.error || 'Failed to start navigation')
      }
    } catch {
      setError('Connection error')
    }
    setLoading(false)
  }

  // Stop navigation
  const handleStopNavigation = async () => {
    try {
      await fetch(`${API_BASE}/api/navigate/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_ID })
      })
    } catch { /* ignore */ }
    setNavigating(false)
    setNavSummary(null)
    setIsBacktracking(false)

    // Check if backtracking is available after stopping
    try {
      const res = await fetch(`${API_BASE}/api/device/${DEVICE_ID}/backtrack`)
      if (res.ok) {
        const data = await res.json()
        setBacktrackAvailable(data.available)
      }
    } catch { /* ignore */ }
  }

  // Start backtrack navigation
  const handleStartBacktrack = async () => {
    if (!device?.online) {
      setError('Device is offline')
      return
    }
    setLoading(true)
    setError('')

    try {
      const res = await fetch(`${API_BASE}/api/navigate/backtrack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_ID })
      })
      const data = await res.json()
      if (res.ok && data.success) {
        setNavigating(true)
        setIsBacktracking(true)
        setBacktrackAvailable(false)
        setNavSummary(data.summary)
        setDestLat(data.destLat)
        setDestLng(data.destLng)
      } else {
        setError(data.error || 'Failed to start backtracking')
      }
    } catch {
      setError('Connection error')
    }
    setLoading(false)
  }

  // The device position is only trustworthy once the GPS has a valid fix.
  // Until then we don't place a marker or recenter (avoids showing a fake
  // location such as the server's Pune fallback).
  const hasFix = !!(device && device.online && device.gpsValid &&
                    (device.lat !== 0 || device.lng !== 0))
  const devicePos: [number, number] | null = hasFix ? [device!.lat, device!.lng] : null

  // Browser GPS fallback: use phone/laptop location when ESP has no fix
  const browserPos: [number, number] | null = browserGps.location
    ? [browserGps.location.lat, browserGps.location.lng]
    : null

  // Determine effective position
  const effectivePos: [number, number] | null = devicePos ?? browserPos

  const center: [number, number] = effectivePos ?? DEFAULT_CENTER
  // Follow the rider when we have a position and the user isn't mid-selecting a
  // destination (during navigation we keep following).
  const followEnabled = effectivePos !== null && (navigating || destLat === null)

  return (
    <div className="app">
      {/* Device Status Bar */}
      <header className="status-bar">
        <div className="status-bar-left">
          <button className="status-bar-back" onClick={() => navigate('/')} aria-label="Back to menu">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <div className="brand">TRIPPER</div>
        </div>
        <div className="status-group">
          {device?.online && (
            <div className={`gps-status ${hasFix ? 'fixed' : 'searching'}`}>
              <span className="dot" />
              {hasFix ? 'GPS' : 'GPS…'}
            </div>
          )}
          <div className={`device-status ${device?.online ? 'online' : 'offline'}`}>
            <span className="dot" />
            {device?.online ? 'Connected' : 'Offline'}
          </div>
        </div>
      </header>

      {/* Map */}
      <div className="map-container">
        <MapContainer center={center} zoom={effectivePos ? 12 : 13} zoomControl={false} attributionControl={false}>
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            maxZoom={19}
          />
          <MapClickHandler onMapClick={handleMapClick} disabled={navigating} />
          <FollowDevice pos={effectivePos} enabled={followEnabled} />
          <FlyToDest lat={destLat} lng={destLng} />
          {effectivePos && <Marker position={effectivePos} icon={defaultIcon} />}
          {destLat !== null && destLng !== null && (
            <Marker position={[destLat, destLng]} icon={destIcon} />
          )}
        </MapContainer>

        {/* Waiting-for-fix hint */}
        {device?.online && !hasFix && !browserPos && (
          <div className="gps-wait-banner">Waiting for GPS fix…</div>
        )}

        {/* Search with autocomplete dropdown */}
        {!navigating && (
          <div className="search-overlay" ref={searchRef}>
            <div className="search-form">
              <input
                type="text"
                className="search-input"
                placeholder="Search destination..."
                value={searchQuery}
                onChange={(e) => handleSearchInput(e.target.value)}
                onFocus={() => { if (suggestions.length > 0) setShowSuggestions(true) }}
                aria-label="Search destination"
                autoComplete="off"
              />
              {searching ? (
                <div className="search-btn search-spinner" aria-label="Searching">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="spin">
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                  </svg>
                </div>
              ) : (
                <button
                  type="button"
                  className="search-btn"
                  onClick={() => { if (searchQuery.trim()) handleSearchInput(searchQuery) }}
                  aria-label="Search"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                  </svg>
                </button>
              )}
            </div>

            {/* Suggestions Dropdown */}
            {showSuggestions && suggestions.length > 0 && (
              <ul className="suggestions-list">
                {suggestions.map((result, i) => (
                  <li key={`${result.lat}-${result.lng}-${i}`}>
                    <button
                      className="suggestion-item"
                      onClick={() => handleSelectSuggestion(result)}
                      type="button"
                    >
                      <svg className="suggestion-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
                        <circle cx="12" cy="10" r="3"/>
                      </svg>
                      <span className="suggestion-text">
                        <strong>{result.name}</strong>
                        <small>{result.address.length > 50 ? result.address.substring(0, 48) + '...' : result.address}</small>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Bottom Panel */}
      <div className="bottom-panel">
        {error && <div className="error-msg">{error}</div>}

        {navigating && navSummary ? (
          <div className="nav-active-panel">
            {isBacktracking && (
              <div className="backtrack-banner">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="1 4 1 10 7 10" />
                  <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                </svg>
                Backtracking to start
              </div>
            )}
            <div className="nav-info">
              <div className="nav-stat">
                <span className="stat-value">{navSummary.distance}</span>
                <span className="stat-label">Distance</span>
              </div>
              <div className="nav-stat">
                <span className="stat-value">{isBacktracking ? 'Backtrack' : navSummary.duration}</span>
                <span className="stat-label">{isBacktracking ? 'Mode' : 'ETA'}</span>
              </div>
            </div>
            <p className="nav-dest">{navSummary.endAddress}</p>
            <button className="btn btn-stop" onClick={handleStopNavigation}>
              {isBacktracking ? 'Stop Backtracking' : 'Stop Navigation'}
            </button>
          </div>
        ) : (
          <div className="destination-panel">
            {/* Backtrack button - shown after stopping navigation when breadcrumbs are available */}
            {backtrackAvailable && destLat === null && (
              <div className="backtrack-offer">
                <div className="backtrack-offer-info">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="1 4 1 10 7 10" />
                    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                  </svg>
                  <span>Backtrack to where you started?</span>
                </div>
                <button
                  className="btn btn-backtrack"
                  onClick={handleStartBacktrack}
                  disabled={loading || !device?.online}
                >
                  {loading ? 'Starting...' : 'Navigate Back'}
                </button>
                <button
                  className="backtrack-dismiss"
                  onClick={() => setBacktrackAvailable(false)}
                >
                  Dismiss
                </button>
              </div>
            )}

            {destLat !== null && destLng !== null ? (
              <>
                <div className="dest-info">
                  <div className="dest-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
                      <circle cx="12" cy="10" r="3"/>
                    </svg>
                  </div>
                  <div className="dest-coords">
                    <span className="dest-label">Destination</span>
                    <span className="dest-value">{destLat.toFixed(5)}, {destLng.toFixed(5)}</span>
                  </div>
                  <button
                    className="dest-clear"
                    onClick={() => { setDestLat(null); setDestLng(null); setSearchQuery('') }}
                    aria-label="Clear destination"
                  >
                    &times;
                  </button>
                </div>
                <button
                  className="btn btn-navigate"
                  onClick={handleStartNavigation}
                  disabled={loading || !device?.online}
                >
                  {loading ? 'Starting...' : 'Start Navigation'}
                </button>
              </>
            ) : (
              !backtrackAvailable && <p className="hint">Tap the map or search to set a destination</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default App
