import { open } from '@tauri-apps/api/dialog'
import { invoke } from '@tauri-apps/api/tauri'
import { useEffect, useState } from 'react'

interface Config {
  api_url: string
  dashboard_url: string
  watched_folders: string[]
  show_notifications: boolean
  start_on_boot: boolean
  processing_delay_seconds: number
}

interface SettingsProps {
  onLogout: () => Promise<void>
  onRefresh: () => Promise<void>
}

function Settings({ onLogout, onRefresh }: SettingsProps) {
  const [config, setConfig] = useState<Config | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    loadConfig()
  }, [])

  const loadConfig = async () => {
    try {
      const result = await invoke<Config>('get_config')
      setConfig(result)
    } catch (error) {
      console.error('Failed to load config:', error)
    } finally {
      setLoading(false)
    }
  }

  const saveConfig = async (newConfig: Config) => {
    setSaving(true)
    try {
      await invoke('save_config', { config: newConfig })
      setConfig(newConfig)
      await onRefresh()
    } catch (error) {
      console.error('Failed to save config:', error)
    } finally {
      setSaving(false)
    }
  }

  const handleAddFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Выберите папку для мониторинга',
      })

      if (selected && config) {
        const newFolders = [...config.watched_folders, selected as string]
        await saveConfig({ ...config, watched_folders: newFolders })
      }
    } catch (error) {
      console.error('Failed to select folder:', error)
    }
  }

  const handleRemoveFolder = async (folder: string) => {
    if (config) {
      const newFolders = config.watched_folders.filter((f) => f !== folder)
      await saveConfig({ ...config, watched_folders: newFolders })
    }
  }

  const handleToggleNotifications = async () => {
    if (config) {
      await saveConfig({ ...config, show_notifications: !config.show_notifications })
    }
  }

  const handleToggleStartOnBoot = async () => {
    if (config) {
      await saveConfig({ ...config, start_on_boot: !config.start_on_boot })
    }
  }

  if (loading || !config) {
    return (
      <div className="loading">
        <div className="spinner"></div>
      </div>
    )
  }

  return (
    <>
      {/* Watched Folders */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">📁 Отслеживаемые папки</span>
        </div>
        <div className="folder-list">
          {config.watched_folders.length > 0 ? (
            config.watched_folders.map((folder) => (
              <div key={folder} className="folder-item">
                <span className="path" title={folder}>
                  {folder.split('\\').pop() || folder}
                </span>
                <button
                  className="remove-btn"
                  onClick={() => handleRemoveFolder(folder)}
                  title="Удалить"
                >
                  ✕
                </button>
              </div>
            ))
          ) : (
            <div className="empty-state">
              <p>Нет отслеживаемых папок</p>
            </div>
          )}
        </div>
        <button
          className="btn btn-secondary"
          onClick={handleAddFolder}
          style={{ marginTop: '0.75rem' }}
        >
          ➕ Добавить папку
        </button>
      </div>

      {/* Preferences */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">⚙️ Настройки</span>
        </div>

        <div className="toggle-container">
          <span className="toggle-label">Показывать уведомления</span>
          <label className="toggle">
            <input
              type="checkbox"
              checked={config.show_notifications}
              onChange={handleToggleNotifications}
            />
            <span className="toggle-slider"></span>
          </label>
        </div>

        <div className="toggle-container">
          <span className="toggle-label">Запускать при старте</span>
          <label className="toggle">
            <input
              type="checkbox"
              checked={config.start_on_boot}
              onChange={handleToggleStartOnBoot}
            />
            <span className="toggle-slider"></span>
          </label>
        </div>
      </div>

      {/* Server */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">🔗 Подключение</span>
        </div>
        <div className="form-group">
          <label className="form-label">API сервер</label>
          <input
            type="text"
            className="form-input"
            value={config.api_url}
            onChange={(e) => setConfig({ ...config, api_url: e.target.value })}
            onBlur={() => saveConfig(config)}
          />
        </div>
      </div>

      {/* Logout */}
      <div className="card">
        <button className="btn btn-danger" onClick={onLogout}>
          🚪 Выйти из аккаунта
        </button>
      </div>

      {saving && (
        <div style={{ textAlign: 'center', color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
          Сохранение...
        </div>
      )}
    </>
  )
}

export default Settings
