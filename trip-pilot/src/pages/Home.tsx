import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function Home() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const device = user?.devices?.[0]

  return (
    <div className="home-page">
      <div className="home-header">
        <h1 className="home-brand">TRIPPER</h1>
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
      </div>

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
