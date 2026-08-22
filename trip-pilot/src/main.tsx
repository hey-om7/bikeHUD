import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import App from './App'
import Login from './pages/Login'
import Signup from './pages/Signup'
import PairDevice from './pages/PairDevice'
import Home from './pages/Home'
import Settings from './pages/Settings'
import './index.css'
import './App.css'

// Auth guard: redirects to /login if not authenticated
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <div className="auth-page"><div className="auth-card"><p className="auth-subtitle">Loading...</p></div></div>
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

// Device guard: if user has no devices, redirect to /pair
function RequireDevice({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <div className="auth-page"><div className="auth-card"><p className="auth-subtitle">Loading...</p></div></div>
  if (!user) return <Navigate to="/login" replace />
  if (!user.devices || user.devices.length === 0) return <Navigate to="/pair" replace />
  return <>{children}</>
}

// Guest guard: redirect to / if already logged in
function GuestOnly({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <div className="auth-page"><div className="auth-card"><p className="auth-subtitle">Loading...</p></div></div>
  if (user) return <Navigate to="/" replace />
  return <>{children}</>
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<GuestOnly><Login /></GuestOnly>} />
      <Route path="/signup" element={<GuestOnly><Signup /></GuestOnly>} />
      <Route path="/pair" element={<RequireAuth><PairDevice /></RequireAuth>} />
      <Route path="/" element={<RequireDevice><Home /></RequireDevice>} />
      <Route path="/directions" element={<RequireDevice><App /></RequireDevice>} />
      <Route path="/settings" element={<RequireDevice><Settings /></RequireDevice>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  </StrictMode>,
)
