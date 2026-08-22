import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001'

interface User {
  _id: string
  email: string
  name: string
  devices: Array<{ _id: string; deviceId: string; name: string }>
}

interface AuthContextType {
  user: User | null
  token: string | null
  loading: boolean
  login: (email: string, password: string) => Promise<string | null>
  register: (email: string, password: string, name: string) => Promise<string | null>
  logout: () => void
  refreshUser: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | null>(null)

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('tp_token'))
  const [loading, setLoading] = useState(true)

  // On mount or token change, fetch current user
  useEffect(() => {
    if (!token) {
      setLoading(false)
      setUser(null)
      return
    }
    fetchMe(token)
  }, [token])

  async function fetchMe(t: string) {
    try {
      const res = await fetch(`${API_BASE}/api/auth/me`, {
        headers: { Authorization: `Bearer ${t}` },
      })
      if (res.ok) {
        const data = await res.json()
        setUser(data.user)
      } else {
        // Token invalid — clear
        localStorage.removeItem('tp_token')
        setToken(null)
        setUser(null)
      }
    } catch {
      // Network error — keep token, user stays null
    }
    setLoading(false)
  }

  async function login(email: string, password: string): Promise<string | null> {
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json()
      if (res.ok) {
        localStorage.setItem('tp_token', data.token)
        setToken(data.token)
        setUser(data.user)
        return null
      }
      return data.error || 'Login failed'
    } catch {
      return 'Network error'
    }
  }

  async function register(email: string, password: string, name: string): Promise<string | null> {
    try {
      const res = await fetch(`${API_BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name }),
      })
      const data = await res.json()
      if (res.ok) {
        localStorage.setItem('tp_token', data.token)
        setToken(data.token)
        setUser(data.user)
        return null
      }
      return data.error || 'Registration failed'
    } catch {
      return 'Network error'
    }
  }

  function logout() {
    localStorage.removeItem('tp_token')
    setToken(null)
    setUser(null)
  }

  async function refreshUser() {
    if (token) await fetchMe(token)
  }

  return (
    <AuthContext.Provider value={{ user, token, loading, login, register, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  )
}
