import { useState, useEffect, useRef, useCallback } from 'react'

export interface BrowserLocation {
  lat: number
  lng: number
  accuracy: number // meters
  timestamp: number
}

export interface UseBrowserLocationResult {
  location: BrowserLocation | null
  error: string | null
  watching: boolean
  supported: boolean
  start: () => void
  stop: () => void
}

/**
 * Custom hook that requests high-accuracy GPS from the browser (phone/laptop).
 * Automatically watches position updates once started.
 */
export function useBrowserLocation(): UseBrowserLocationResult {
  const [location, setLocation] = useState<BrowserLocation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [watching, setWatching] = useState(false)
  const watchIdRef = useRef<number | null>(null)

  const supported = typeof navigator !== 'undefined' && 'geolocation' in navigator

  const start = useCallback(() => {
    if (!supported) {
      setError('Geolocation not supported on this device')
      return
    }

    // Clear previous errors
    setError(null)

    const options: PositionOptions = {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0,
    }

    const onSuccess = (pos: GeolocationPosition) => {
      setLocation({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        timestamp: pos.timestamp,
      })
      setError(null)
    }

    const onError = (err: GeolocationPositionError) => {
      switch (err.code) {
        case err.PERMISSION_DENIED:
          setError('Location permission denied')
          break
        case err.POSITION_UNAVAILABLE:
          setError('Location unavailable')
          break
        case err.TIMEOUT:
          setError('Location request timed out')
          break
        default:
          setError('Unknown location error')
      }
    }

    // Start watching
    watchIdRef.current = navigator.geolocation.watchPosition(onSuccess, onError, options)
    setWatching(true)
  }, [supported])

  const stop = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current)
      watchIdRef.current = null
    }
    setWatching(false)
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current)
      }
    }
  }, [])

  return { location, error, watching, supported, start, stop }
}
