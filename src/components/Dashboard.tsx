import { open as openDialog } from '@tauri-apps/api/dialog'
import { Body, fetch as httpFetch } from '@tauri-apps/api/http'
import { invoke } from '@tauri-apps/api/tauri'
import { useEffect, useState } from 'react'

const API_URL = 'http://localhost:8085'

interface DashboardProps {
  status: {
    is_paused: boolean
    files_today: number
    watched_folders: string[]
  }
  onTogglePause: () => Promise<void>
  onOpenDashboard: () => Promise<void>
}

interface Action {
  id: string
  filename: string
  dest_path: string
  category_icon: string | null
  created_at: string
}

interface UserFolders {
  desktop: string | null
  documents: string | null
  downloads: string | null
  home: string | null
}

interface ScannedFile {
  filename: string
  extension: string
  size_bytes: number
  path: string
  modified: string | null
}

interface FolderSuggestion {
  folder_path: string
  folder_name: string
  files: string[]
  reason: string
  confidence: number
  file_count: number
}

interface OrganizeResult {
  folders: FolderSuggestion[]
  total_files: number
  total_folders: number
  naming_method: string
}

type OrganizeStep = 'idle' | 'scanning' | 'analyzing' | 'preview' | 'executing' | 'done'

function Dashboard({ status, onTogglePause, onOpenDashboard }: DashboardProps) {
  const [recentActions, setRecentActions] = useState<Action[]>([])
  const [loading, setLoading] = useState(true)
  const [showAutoOrganize, setShowAutoOrganize] = useState(false)
  const [userFolders, setUserFolders] = useState<UserFolders | null>(null)
  const [selectedFolder, setSelectedFolder] = useState('')
  const [organizeStep, setOrganizeStep] = useState<OrganizeStep>('idle')
  const [organizeStatus, setOrganizeStatus] = useState('')
  const [scannedFiles, setScannedFiles] = useState<ScannedFile[]>([])
  const [organizeResult, setOrganizeResult] = useState<OrganizeResult | null>(null)
  const [useGeminiNaming, setUseGeminiNaming] = useState(true)
  const [useGeminiFull, setUseGeminiFull] = useState(false)

  useEffect(() => {
    loadRecentActions()
    loadUserFolders()
  }, [])

  const loadRecentActions = async () => {
    try {
      const result = await invoke<{ actions: Action[] }>('get_recent_actions')
      setRecentActions(result.actions || [])
    } catch (error) {
      console.error('Failed to load actions:', error)
    } finally {
      setLoading(false)
    }
  }

  const loadUserFolders = async () => {
    try {
      const folders = await invoke<UserFolders>('get_user_folders')
      setUserFolders(folders)
    } catch (error) {
      console.error('Failed to load user folders:', error)
    }
  }

  const handleBrowseFolder = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: 'Выберите папку для организации'
      })
      if (typeof selected === 'string') {
        setSelectedFolder(selected)
      }
    } catch (error) {
      console.error('Failed to open folder dialog:', error)
    }
  }

  const handleStartOrganize = async () => {
    if (!selectedFolder) return
    
    setOrganizeStep('scanning')
    setOrganizeStatus('Сканирование папки...')
    
    try {
      // Step 1: Scan folder
      const files = await invoke<ScannedFile[]>('scan_folder_for_organize', { folderPath: selectedFolder })
      
      if (files.length === 0) {
        setOrganizeStatus('❌ Папка пуста')
        setOrganizeStep('idle')
        return
      }
      
      setScannedFiles(files)
      setOrganizeStatus(`Найдено ${files.length} файлов. AI анализ...`)
      setOrganizeStep('analyzing')
      
      // Get access token from Tauri
      const accessToken = await invoke<string | null>('get_access_token')
      
      if (!accessToken) {
        setOrganizeStatus('❌ Требуется авторизация. Перезайдите в приложение.')
        setOrganizeStep('idle')
        return
      }
      
      // Step 2: Call backend API for AI analysis
      const filesForApi = files.map(f => ({
        filename: f.filename,
        extension: f.extension,
        size_bytes: f.size_bytes,
        content_preview: '', // Skip content extraction for speed
        path: f.path
      }))
      
      const response = await httpFetch<OrganizeResult>(`${API_URL}/api/auto-organize/analyze`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken || ''}`
        },
        body: Body.json({
          files: filesForApi,
          use_gemini_naming: useGeminiNaming,
          use_gemini_full: useGeminiFull,
          min_clusters: 3,
          max_clusters: 15
        })
      })
      
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('Сессия истекла. Перезайдите в Настройках → Выйти.')
        }
        throw new Error(`API error: ${response.status}`)
      }
      
      const result = response.data
      setOrganizeResult(result)
      setOrganizeStep('preview')
      setOrganizeStatus(`Готово: ${result.total_folders} папок`)
      
    } catch (error: any) {
      setOrganizeStatus(`❌ Ошибка: ${error.message || error}`)
      setOrganizeStep('idle')
    }
  }

  const handleExecuteOrganize = async () => {
    if (!organizeResult || !selectedFolder) return
    
    setOrganizeStep('executing')
    setOrganizeStatus('Перемещение файлов...')
    
    try {
      // Build move actions
      const moves = organizeResult.folders.flatMap(folder => 
        folder.files.map(filename => {
          const file = scannedFiles.find(f => f.filename === filename)
          return {
            source_path: file?.path || '',
            dest_folder: folder.folder_path,
            filename
          }
        }).filter(m => m.source_path)
      )
      
      const result = await invoke<{ success: boolean; moved_count: number; errors: string[] }>('execute_file_moves', {
        baseFolder: selectedFolder,
        moves,
        createFolders: true
      })
      
      if (result.success || result.moved_count > 0) {
        // Log actions to backend for history
        const accessToken = await invoke<string | null>('get_access_token')
        if (accessToken) {
          for (const folder of organizeResult.folders) {
            for (const filename of folder.files) {
              const file = scannedFiles.find(f => f.filename === filename)
              if (file) {
                try {
                  await httpFetch(`${API_URL}/api/actions/log`, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Authorization': `Bearer ${accessToken}`
                    },
                    body: Body.json({
                      filename: file.filename,
                      source_path: file.path,
                      dest_path: `${selectedFolder}\\${folder.folder_path}\\${filename}`,
                      confidence: folder.confidence || 0.9
                    })
                  })
                } catch (e) {
                  console.warn('Failed to log action:', e)
                }
              }
            }
          }
          // Refresh recent actions
          loadRecentActions()
        }
        
        setOrganizeStatus(`✅ Перемещено ${result.moved_count} файлов!`)
        setOrganizeStep('done')
      } else {
        setOrganizeStatus(`⚠️ Перемещено ${result.moved_count}, ошибок: ${result.errors.length}`)
        setOrganizeStep('done')
      }
      
    } catch (error: any) {
      setOrganizeStatus(`❌ Ошибка: ${error.message || error}`)
      setOrganizeStep('preview')
    }
  }

  const resetOrganize = () => {
    setShowAutoOrganize(false)
    setSelectedFolder('')
    setOrganizeStep('idle')
    setOrganizeStatus('')
    setScannedFiles([])
    setOrganizeResult(null)
  }

  const formatTime = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const getFileIcon = (filename: string) => {
    const ext = filename.split('.').pop()?.toLowerCase() || ''
    const iconMap: Record<string, string> = {
      pdf: '📄', doc: '📝', docx: '📝', xls: '📊', xlsx: '📊',
      jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️',
      mp4: '🎬', mp3: '🎵', zip: '📦', rar: '📦', exe: '💿', py: '🐍', js: '📜',
    }
    return iconMap[ext] || '📁'
  }

  return (
    <>
      {/* Stats */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Статистика за сегодня</span>
        </div>
        <div className="stats-grid">
          <div className="stat-item">
            <div className="stat-value">{status.files_today}</div>
            <div className="stat-label">Файлов</div>
          </div>
          <div className="stat-item">
            <div className="stat-value">{status.watched_folders.length}</div>
            <div className="stat-label">Папок</div>
          </div>
          <div className="stat-item">
            <div className="stat-value">{status.is_paused ? '⏸️' : '▶️'}</div>
            <div className="stat-label">{status.is_paused ? 'Пауза' : 'Активен'}</div>
          </div>
        </div>
      </div>

      {/* AI Auto-Organize */}
      <div className="card" style={{ background: 'linear-gradient(135deg, rgba(147, 51, 234, 0.1), rgba(236, 72, 153, 0.1))', border: '1px solid rgba(147, 51, 234, 0.3)' }}>
        <div className="card-header">
          <span className="card-title">✨ AI Auto-Organize</span>
        </div>
        
        {!showAutoOrganize ? (
          <button 
            className="btn btn-primary" 
            onClick={() => setShowAutoOrganize(true)}
            style={{ background: 'linear-gradient(135deg, #9333ea, #ec4899)' }}
          >
            🪄 Организовать папку
          </button>
        ) : organizeStep === 'preview' && organizeResult ? (
          // Preview results
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={{ fontSize: '0.8rem', color: '#a78bfa', fontWeight: 500 }}>
              {organizeResult.total_files} файлов → {organizeResult.total_folders} папок
            </div>
            <div style={{ maxHeight: '150px', overflow: 'auto' }}>
              {organizeResult.folders.map((folder, i) => (
                <div key={i} style={{ 
                  padding: '0.5rem', 
                  background: 'rgba(0,0,0,0.2)', 
                  borderRadius: '0.5rem',
                  marginBottom: '0.25rem',
                  fontSize: '0.75rem'
                }}>
                  <div style={{ fontWeight: 500, color: '#a78bfa' }}>📁 {folder.folder_path}</div>
                  <div style={{ color: '#9ca3af' }}>
                    {folder.files.slice(0, 3).join(', ')}
                    {folder.files.length > 3 && ` +${folder.files.length - 3}`}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button className="btn btn-secondary" onClick={resetOrganize} style={{ flex: 1 }}>
                Отмена
              </button>
              <button 
                className="btn btn-primary" 
                onClick={handleExecuteOrganize}
                style={{ flex: 1, background: 'linear-gradient(135deg, #10b981, #059669)' }}
              >
                ✅ Применить
              </button>
            </div>
          </div>
        ) : organizeStep === 'done' ? (
          // Done state
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', alignItems: 'center' }}>
            <div style={{ fontSize: '2rem' }}>🎉</div>
            <div style={{ fontSize: '0.8rem', color: '#10b981' }}>{organizeStatus}</div>
            <button className="btn btn-primary" onClick={resetOrganize}>
              Готово
            </button>
          </div>
        ) : (
          // Selection / Loading state
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {organizeStep === 'idle' && (
              <>
                {/* Quick folder buttons */}
                <div style={{ display: 'flex', gap: '0.25rem' }}>
                  {userFolders?.desktop && (
                    <button 
                      className={`btn ${selectedFolder === userFolders.desktop ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => setSelectedFolder(userFolders.desktop!)}
                      style={{ flex: 1, fontSize: '0.7rem', padding: '0.4rem' }}
                    >
                      🖥️ Рабочий стол
                    </button>
                  )}
                  {userFolders?.downloads && (
                    <button 
                      className={`btn ${selectedFolder === userFolders.downloads ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => setSelectedFolder(userFolders.downloads!)}
                      style={{ flex: 1, fontSize: '0.7rem', padding: '0.4rem' }}
                    >
                      📥 Загрузки
                    </button>
                  )}
                  {userFolders?.documents && (
                    <button 
                      className={`btn ${selectedFolder === userFolders.documents ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => setSelectedFolder(userFolders.documents!)}
                      style={{ flex: 1, fontSize: '0.7rem', padding: '0.4rem' }}
                    >
                      📄 Документы
                    </button>
                  )}
                </div>
                
                {/* Selected folder display */}
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <input 
                    type="text"
                    value={selectedFolder}
                    onChange={(e) => setSelectedFolder(e.target.value)}
                    placeholder="Выберите папку..."
                    style={{ 
                      flex: 1, padding: '0.5rem', borderRadius: '0.5rem', 
                      border: '1px solid #374151', background: '#1f2937',
                      color: 'white', fontSize: '0.75rem'
                    }}
                  />
                  <button className="btn btn-secondary" onClick={handleBrowseFolder} style={{ padding: '0.5rem' }}>
                    📂
                  </button>
                </div>
                
                {/* Gemini Options */}
                <div style={{ 
                  display: 'flex', flexDirection: 'column', gap: '0.4rem',
                  padding: '0.5rem', background: 'rgba(0,0,0,0.2)', borderRadius: '0.5rem'
                }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={useGeminiNaming}
                      onChange={(e) => setUseGeminiNaming(e.target.checked)}
                      style={{ accentColor: '#9333ea' }}
                    />
                    <span style={{ fontSize: '0.7rem', color: '#d1d5db' }}>✨ Gemini для названий</span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={useGeminiFull}
                      onChange={(e) => setUseGeminiFull(e.target.checked)}
                      style={{ accentColor: '#a855f7' }}
                    />
                    <span style={{ fontSize: '0.7rem', color: '#d1d5db' }}>🔮 Глубокий анализ (медленнее)</span>
                  </label>
                </div>
              </>
            )}
            
            {/* Status */}
            {organizeStatus && (
              <div style={{ fontSize: '0.75rem', color: '#9ca3af', padding: '0.25rem', textAlign: 'center' }}>
                {(organizeStep === 'scanning' || organizeStep === 'analyzing') && '⏳ '}
                {organizeStatus}
              </div>
            )}
            
            {/* Action buttons */}
            {organizeStep === 'idle' && (
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button className="btn btn-secondary" onClick={resetOrganize} style={{ flex: 1 }}>
                  Отмена
                </button>
                <button 
                  className="btn btn-primary" 
                  onClick={handleStartOrganize}
                  disabled={!selectedFolder}
                  style={{ flex: 1, background: !selectedFolder ? '#6b7280' : 'linear-gradient(135deg, #9333ea, #ec4899)' }}
                >
                  ✨ Анализировать
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Recent Actions */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Последние действия</span>
        </div>
        {loading ? (
          <div className="loading">
            <div className="spinner"></div>
          </div>
        ) : recentActions.length > 0 ? (
          <div className="actions-list">
            {recentActions.map((action) => (
              <div key={action.id} className="action-item">
                <span className="icon">{action.category_icon || getFileIcon(action.filename)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="filename">{action.filename}</div>
                  <div className="destination">→ {action.dest_path.split('/').pop()}</div>
                </div>
                <span className="time">{formatTime(action.created_at)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <div className="icon">📭</div>
            <p>Пока нет действий</p>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="card">
        <button className="btn btn-secondary" onClick={onTogglePause} style={{ marginBottom: '0.5rem' }}>
          {status.is_paused ? '▶️ Продолжить' : '⏸️ Пауза'}
        </button>
        <button className="btn btn-primary" onClick={onOpenDashboard}>
          🌐 Открыть Dashboard
        </button>
      </div>
    </>
  )
}

export default Dashboard
