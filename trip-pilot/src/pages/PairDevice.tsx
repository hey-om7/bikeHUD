import { useState, useRef, useEffect, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001'

export default function PairDevice() {
  const { token, refreshUser, logout } = useAuth()
  const navigate = useNavigate()
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<'choice' | 'code' | 'camera'>('choice')
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const scanIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Cleanup camera on unmount or mode change
  useEffect(() => {
    return () => stopCamera()
  }, [])

  function stopCamera() {
    if (scanIntervalRef.current) {
      clearInterval(scanIntervalRef.current)
      scanIntervalRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }

  async function startCamera() {
    setMode('camera')
    setError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        videoRef.current.play()
      }
      // Start scanning for QR codes using BarcodeDetector API
      startScanning()
    } catch (err) {
      setError('Could not access camera. Please allow camera permission.')
      setMode('choice')
    }
  }

  function startScanning() {
    // Use BarcodeDetector if available (Chrome, Edge, Safari 17.2+)
    if (!('BarcodeDetector' in window)) {
      setError('QR scanning not supported in this browser. Please enter the code manually.')
      stopCamera()
      setMode('code')
      return
    }

    const detector = new (window as any).BarcodeDetector({ formats: ['qr_code'] })

    scanIntervalRef.current = setInterval(async () => {
      if (!videoRef.current || videoRef.current.readyState < 2) return

      try {
        const barcodes = await detector.detect(videoRef.current)
        if (barcodes.length > 0) {
          const value = barcodes[0].rawValue
          // QR contains: tripper://pair/<8-digit-code>
          const match = value.match(/tripper:\/\/pair\/(\d{8})/)
          if (match) {
            stopCamera()
            await handlePair(match[1])
          }
        }
      } catch {
        // Ignore detection errors
      }
    }, 300)
  }

  async function handlePair(pairingCode: string) {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API_BASE}/api/devices/pair`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ pairingCode }),
      })
      const data = await res.json()
      if (res.ok) {
        await refreshUser()
        navigate('/', { replace: true })
      } else {
        setError(data.error || 'Pairing failed')
      }
    } catch {
      setError('Network error. Please try again.')
    }
    setLoading(false)
  }

  async function handleCodeSubmit(e: FormEvent) {
    e.preventDefault()
    if (code.length !== 8) {
      setError('Please enter the full 8-digit code')
      return
    }
    await handlePair(code)
  }

  return (
    <div className="auth-page">
      <div className="auth-card pair-card">
        <div className="auth-header">
          <h1 className="auth-brand">TRIPPER</h1>
          <p className="auth-subtitle">Pair Your Device</p>
        </div>

        {error && <div className="auth-error">{error}</div>}

        {mode === 'choice' && (
          <div className="pair-choices">
            <p className="pair-desc">
              Turn on your Tripper device. It will display a QR code and an 8-digit
              pairing code on its screen.
            </p>
            <button
              className="btn btn-navigate auth-btn"
              onClick={startCamera}
              disabled={loading}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 8, verticalAlign: 'middle' }}>
                <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
              </svg>
              Scan QR Code
            </button>
            <button
              className="btn btn-secondary auth-btn"
              onClick={() => setMode('code')}
              disabled={loading}
            >
              Enter Code Manually
            </button>
          </div>
        )}

        {mode === 'camera' && (
          <div className="pair-camera">
            <div className="camera-viewfinder">
              <video ref={videoRef} playsInline muted className="camera-video" />
              <div className="viewfinder-frame" />
              <canvas ref={canvasRef} style={{ display: 'none' }} />
            </div>
            <p className="pair-hint">Point your camera at the QR code on the device screen</p>
            <button
              className="btn btn-secondary auth-btn"
              onClick={() => { stopCamera(); setMode('choice') }}
            >
              Cancel
            </button>
          </div>
        )}

        {mode === 'code' && (
          <form onSubmit={handleCodeSubmit} className="auth-form">
            <div className="input-group">
              <label htmlFor="pairing-code">8-Digit Pairing Code</label>
              <input
                id="pairing-code"
                type="text"
                inputMode="numeric"
                pattern="\d{8}"
                maxLength={8}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
                placeholder="Enter code from device screen"
                required
                autoFocus
                className="code-input"
              />
            </div>
            <button type="submit" className="btn btn-navigate auth-btn" disabled={loading || code.length !== 8}>
              {loading ? 'Pairing...' : 'Pair Device'}
            </button>
            <button
              type="button"
              className="btn btn-secondary auth-btn"
              onClick={() => setMode('choice')}
            >
              Back
            </button>
          </form>
        )}

        <button className="auth-logout-link" onClick={logout}>
          Sign out
        </button>
      </div>
    </div>
  )
}
