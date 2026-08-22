import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001'

export default function Settings() {
  const { user, token, logout, refreshUser } = useAuth()
  const navigate = useNavigate()
  const [unpairLoading, setUnpairLoading] = useState(false)
  const [error, setError] = useState('')
  const [showConfirm, setShowConfirm] = useState(false)

  const device = user?.devices?.[0]

  async function handleUnpair() {
    if (!device) return
    setUnpairLoading(true)
    setError('')

    try {
      const res = await fetch(`${API_BASE}/api/devices/${device._id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })

      if (res.ok) {
        // Refresh user data — devices array will be empty, triggering redirect to /pair
        await refreshUser()
        navigate('/pair', { replace: true })
      } else {
        const data = await res.json()
        setError(data.error || 'Unpair failed')
      }
    } catch {
      setError('Network error')
    }
    setUnpairLoading(false)
  }

  return (
    <div className="settings-page">
      <div className="settings-header">
        <button className="settings-back" onClick={() => navigate('/')} aria-label="Back">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <h1 className="settings-title">Settings</h1>
        <div style={{ width: 24 }} />
      </div>

      <div className="settings-content">
        {/* Account Section */}
        <div className="settings-section">
          <h2 className="settings-section-title">Account</h2>
          <div className="settings-card">
            <div className="settings-row">
              <span className="settings-label">Name</span>
              <span className="settings-value">{user?.name}</span>
            </div>
            <div className="settings-row">
              <span className="settings-label">Email</span>
              <span className="settings-value">{user?.email}</span>
            </div>
          </div>
        </div>

        {/* Device Section */}
        <div className="settings-section">
          <h2 className="settings-section-title">Paired Device</h2>
          <div className="settings-card">
            <div className="settings-row">
              <span className="settings-label">Device</span>
              <span className="settings-value">{device?.name || 'My Tripper'}</span>
            </div>
            <div className="settings-row">
              <span className="settings-label">ID</span>
              <span className="settings-value settings-mono">{device?.deviceId}</span>
            </div>
          </div>
        </div>

        {/* Danger Zone */}
        <div className="settings-section">
          <h2 className="settings-section-title settings-danger-title">Danger Zone</h2>

          {error && <div className="auth-error">{error}</div>}

          {!showConfirm ? (
            <button
              className="btn settings-btn-unpair"
              onClick={() => setShowConfirm(true)}
            >
              Unpair Device
            </button>
          ) : (
            <div className="settings-confirm">
              <p className="settings-confirm-text">
                This will unpair the device and reset its saved WiFi credentials.
                You'll need to pair again to use it.
              </p>
              <div className="settings-confirm-actions">
                <button
                  className="btn settings-btn-unpair-confirm"
                  onClick={handleUnpair}
                  disabled={unpairLoading}
                >
                  {unpairLoading ? 'Unpairing...' : 'Yes, Unpair'}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => setShowConfirm(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <button className="btn settings-btn-logout" onClick={logout}>
            Sign Out
          </button>
        </div>
      </div>
    </div>
  )
}
