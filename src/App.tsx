import { open } from '@tauri-apps/api/shell'
import { invoke } from '@tauri-apps/api/tauri'
import { useEffect, useState } from 'react'
import Dashboard from './components/Dashboard'
import Login from './components/Login'
import Settings from './components/Settings'

interface AppStatus {
  is_paused: boolean
  files_today: number
  is_logged_in: boolean
  watched_folders: string[]
}

function App() {
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [activeTab, setActiveTab] = useState<'dashboard' | 'settings'>('dashboard')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadStatus()
  }, [])

  const loadStatus = async () => {
    try {
      const result = await invoke<AppStatus>('get_status')
      setStatus(result)
    } catch (error) {
      console.error('Failed to load status:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleLogin = async (email: string, password: string) => {
    await invoke('login', { email, password })
    await loadStatus()
    // Start watching after login
    await invoke('start_watching')
  }

  const handleLogout = async () => {
    await invoke('stop_watching')
    await invoke('logout')
    await loadStatus()
  }

  const handleTogglePause = async () => {
    await invoke('toggle_pause')
    await loadStatus()
  }

  const handleOpenDashboard = async () => {
    const url = await invoke<string>('open_dashboard')
    await open(url)
  }

  if (loading) {
    return (
      <div className="app">
        <div className="loading">
          <div className="spinner"></div>
        </div>
      </div>
    )
  }

  if (!status?.is_logged_in) {
    return <Login onLogin={handleLogin} />
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-title">
          <span className="icon">📁</span>
          <h1>FileSorter</h1>
        </div>
        <div className={`status-badge ${status.is_paused ? 'paused' : 'active'}`}>
          {status.is_paused ? '⏸️ Пауза' : '✅ Активен'}
        </div>
      </header>

      <div className="tabs">
        <button
          className={`tab ${activeTab === 'dashboard' ? 'active' : ''}`}
          onClick={() => setActiveTab('dashboard')}
        >
          📊 Статус
        </button>
        <button
          className={`tab ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveTab('settings')}
        >
          ⚙️ Настройки
        </button>
      </div>

      {activeTab === 'dashboard' ? (
        <Dashboard
          status={status}
          onTogglePause={handleTogglePause}
          onOpenDashboard={handleOpenDashboard}
        />
      ) : (
        <Settings onLogout={handleLogout} onRefresh={loadStatus} />
      )}
    </div>
  )
}

export default App
