import { useState, useEffect, useCallback, useRef } from 'react'
import { MapContainer, TileLayer, Marker, useMapEvents, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './App.css'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001'
const DEVICE_ID = 'tripper-001'
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

// ===== Fly to position =====
function FlyTo({ lat, lng }: { lat: number; lng: number }) {
  const map = useMap()
  const flown = useRef(false)
  useEffect(() => {
    if (!flown.current && lat && lng) {
      map.flyTo([lat, lng], 14, { duration: 1 })
      flown.current = true
    }
  }, [map, lat, lng])
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
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchRef = useRef<HTMLDivElement>(null)

  // Poll device status
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/device/${DEVICE_ID}`)
        if (res.ok) {
          const data = await res.json()
          setDevice(data)
          if (data.navigating) setNavigating(true)
          else if (navigating && !data.navigating) {
            setNavigating(false)
            setNavSummary(null)
            setDestLat(null)
            setDestLng(null)
          }
        } else {
          setDevice(null)
        }
      } catch {
        setDevice(null)
      }
    }
    poll()
    const interval = setInterval(poll, 3000)
    return () => clearInterval(interval)
  }, [navigating])

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
        const lat = device?.lat ?? DEFAULT_CENTER[0]
        const lng = device?.lng ?? DEFAULT_CENTER[1]
        const res = await fetch(
          `${API_BASE}/api/search?q=${encoded}&lat=${lat}&lng=${lng}`
        )
        const results: SearchResult[] = await res.json()
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
  }

  const center: [number, number] = device
    ? [device.lat, device.lng]
    : DEFAULT_CENTER

  return (
    <div className="app">
      {/* Device Status Bar */}
      <header className="status-bar">
        <div className="brand">TRIPPER</div>
        <div className={`device-status ${device?.online ? 'online' : 'offline'}`}>
          <span className="dot" />
          {device?.online ? 'Connected' : 'Offline'}
        </div>
      </header>

      {/* Map */}
      <div className="map-container">
        <MapContainer center={center} zoom={15} zoomControl={false} attributionControl={false}>
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            maxZoom={19}
          />
          <MapClickHandler onMapClick={handleMapClick} disabled={navigating} />
          <FlyTo lat={center[0]} lng={center[1]} />
          <FlyToDest lat={destLat} lng={destLng} />
          {device && <Marker position={[device.lat, device.lng]} icon={defaultIcon} />}
          {destLat !== null && destLng !== null && (
            <Marker position={[destLat, destLng]} icon={destIcon} />
          )}
        </MapContainer>

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
            <div className="nav-info">
              <div className="nav-stat">
                <span className="stat-value">{navSummary.distance}</span>
                <span className="stat-label">Distance</span>
              </div>
              <div className="nav-stat">
                <span className="stat-value">{navSummary.duration}</span>
                <span className="stat-label">ETA</span>
              </div>
            </div>
            <p className="nav-dest">{navSummary.endAddress}</p>
            <button className="btn btn-stop" onClick={handleStopNavigation}>
              Stop Navigation
            </button>
          </div>
        ) : (
          <div className="destination-panel">
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
              <p className="hint">Tap the map or search to set a destination</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default App
