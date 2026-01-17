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

interface Stats {
  files_sorted_today: number
  files_sorted_this_week: number
  files_sorted_this_month: number
  total_files_sorted: number
  rules_count: number
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
  clustering_method: string
  naming_method: string
}

interface ExistingFolder {
  folder_name: string
  folder_path: string
  sample_files: string[]
  file_count: number
}

interface SuggestedRule {
  rule_type: string
  pattern: string
  target_folder: string
  file_count: number
  confidence: number
  description: string
  selected?: boolean
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
  const [useExistingFolders, setUseExistingFolders] = useState(true)
  const [useContentExtraction, setUseContentExtraction] = useState(false)
  const [customPrompt, setCustomPrompt] = useState('')
  const [suggestedRules, setSuggestedRules] = useState<SuggestedRule[]>([])
  const [showRulesModal, setShowRulesModal] = useState(false)
  const [stats, setStats] = useState<Stats | null>(null)

  useEffect(() => {
    loadRecentActions()
    loadUserFolders()
    loadStats()
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

  const loadStats = async () => {
    try {
      const accessToken = await invoke<string | null>('get_access_token')
      if (!accessToken) return
      
      const response = await httpFetch<Stats>(`${API_URL}/api/user/stats`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      })
      
      if (response.ok) {
        setStats(response.data)
      }
    } catch (error) {
      console.error('Failed to load stats:', error)
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
      
      if (files.length > 5000) {
        setOrganizeStatus(`❌ Слишком много файлов (${files.length}). Максимум 5000.`)
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
      // Step 2: Scan existing folders if option enabled
      let existingFolders: ExistingFolder[] = []
      if (useExistingFolders) {
        try {
          existingFolders = await invoke<ExistingFolder[]>('scan_existing_folders', { folderPath: selectedFolder })
          setOrganizeStatus(`Найдено ${files.length} файлов, ${existingFolders.length} папок. AI анализ...`)
        } catch (e) {
          console.warn('Failed to scan existing folders:', e)
        }
      }
      
      // Step 3: Extract content if enabled (OCR, PDF text, etc.)
      let filesForApi = files.map(f => ({
        filename: f.filename,
        extension: f.extension,
        size_bytes: f.size_bytes,
        content_preview: '',
        path: f.path
      }))
      
      if (useContentExtraction) {
        setOrganizeStatus(`Извлечение содержимого (0/${files.length})...`)
        
        // Process files in parallel (max 5 at a time)
        const batchSize = 5
        for (let i = 0; i < files.length; i += batchSize) {
          const batch = files.slice(i, i + batchSize)
          
          await Promise.all(batch.map(async (file, batchIdx) => {
            const fileIdx = i + batchIdx
            try {
              // Read first 50KB of file
              const content = await invoke<number[]>('read_file_content', { 
                filePath: file.path, 
                maxBytes: 50000 
              })
              
              if (content.length > 0) {
                // Convert to base64
                const bytes = new Uint8Array(content)
                const base64 = btoa(String.fromCharCode(...bytes))
                
                // Send to backend for extraction
                const extractResponse = await httpFetch<{ content_preview: string }>(`${API_URL}/api/auto-organize/extract-content`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken || ''}`
                  },
                  body: Body.json({
                    content_base64: base64,
                    extension: file.extension,
                    filename: file.filename
                  })
                })
                
                if (extractResponse.ok && extractResponse.data.content_preview) {
                  filesForApi[fileIdx].content_preview = extractResponse.data.content_preview
                }
              }
            } catch (e) {
              console.warn(`Failed to extract content from ${file.filename}:`, e)
            }
          }))
          
          setOrganizeStatus(`Извлечение содержимого (${Math.min(i + batchSize, files.length)}/${files.length})...`)
        }
        
        setOrganizeStatus(`Анализ ${files.length} файлов...`)
      }
      
      const response = await httpFetch<OrganizeResult>(`${API_URL}/api/auto-organize/analyze`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken || ''}`
        },
        body: Body.json({
          files: filesForApi,
          existing_folders: existingFolders.map(f => ({
            folder_name: f.folder_name,
            folder_path: f.folder_path,
            sample_files: f.sample_files,
            file_count: f.file_count
          })),
          use_existing_folders: useExistingFolders,
          use_gemini_naming: useGeminiNaming,
          use_gemini_full: useGeminiFull,
          custom_prompt: customPrompt,
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

  const handleGenerateRules = async () => {
    if (!organizeResult) return
    
    try {
      const accessToken = await invoke<string | null>('get_access_token')
      
      const response = await httpFetch<{ rules: SuggestedRule[], total_rules: number }>(`${API_URL}/api/auto-organize/generate-rules`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken || ''}`
        },
        body: Body.json({
          folders: organizeResult.folders.map(f => ({
            folder_path: f.folder_path,
            folder_name: f.folder_name,
            files: f.files,
            reason: f.reason,
            confidence: f.confidence,
            file_count: f.file_count
          })),
          source_folder: selectedFolder
        })
      })
      
      if (response.ok && response.data.rules.length > 0) {
        setSuggestedRules(response.data.rules.map(r => ({ ...r, selected: true })))
        setShowRulesModal(true)
      } else {
        setOrganizeStatus('Не удалось найти паттерны для правил')
      }
    } catch (error: any) {
      console.error('Failed to generate rules:', error)
    }
  }

  const resetOrganize = () => {
    setShowAutoOrganize(false)
    setSelectedFolder('')
    setOrganizeStep('idle')
    setOrganizeStatus('')
    setScannedFiles([])
    setOrganizeResult(null)
    setSuggestedRules([])
    setShowRulesModal(false)
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
          <span className="card-title">Статистика</span>
        </div>
        <div className="stats-grid">
          <div className="stat-item">
            <div className="stat-value">{stats?.files_sorted_today || 0}</div>
            <div className="stat-label">Сегодня</div>
          </div>
          <div className="stat-item">
            <div className="stat-value">{stats?.files_sorted_this_week || 0}</div>
            <div className="stat-label">Неделя</div>
          </div>
          <div className="stat-item">
            <div className="stat-value">{stats?.total_files_sorted || 0}</div>
            <div className="stat-label">Всего</div>
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div style={{ 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'space-between',
              padding: '0.75rem 1rem',
              background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.15), rgba(139, 92, 246, 0.1))',
              borderRadius: '12px',
              border: '1px solid rgba(99, 102, 241, 0.2)'
            }}>
              <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#a78bfa' }}>
                📊 {organizeResult.total_files} файлов
              </span>
              <span style={{ fontSize: '0.75rem', color: '#9ca3af' }}>→</span>
              <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#10b981' }}>
                📁 {organizeResult.total_folders} папок
              </span>
            </div>
            <div style={{ maxHeight: '180px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {organizeResult.folders.map((folder, i) => (
                <div key={i} className="preview-folder">
                  <div className="preview-folder-header">
                    <span className="preview-folder-icon">📁</span>
                    <span className="preview-folder-name">{folder.folder_path}</span>
                    <span className="preview-folder-count">{folder.files.length}</span>
                  </div>
                  <div className="preview-files">
                    {folder.files.slice(0, 4).map((file, j) => (
                      <span key={j} className="preview-file">{file}</span>
                    ))}
                    {folder.files.length > 4 && (
                      <span className="preview-file" style={{ background: 'rgba(99, 102, 241, 0.2)', color: '#a78bfa' }}>
                        +{folder.files.length - 4} ещё
                      </span>
                    )}
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
            <div style={{ display: 'flex', gap: '0.5rem', width: '100%' }}>
              <button className="btn btn-secondary" onClick={handleGenerateRules} style={{ flex: 1 }}>
                🔧 Создать правила
              </button>
              <button className="btn btn-primary" onClick={resetOrganize} style={{ flex: 1 }}>
                Готово
              </button>
            </div>
            
            {/* Rules Modal */}
            {showRulesModal && (
              <div style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                background: 'rgba(0,0,0,0.8)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 100
              }}>
                <div style={{
                  background: '#1f2937',
                  borderRadius: '1rem',
                  padding: '1rem',
                  maxWidth: '90%',
                  maxHeight: '80%',
                  overflow: 'auto'
                }}>
                  <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem' }}>🔧 Предложенные правила</h3>
                  <p style={{ fontSize: '0.7rem', color: '#9ca3af', margin: '0 0 0.5rem' }}>
                    Выберите правила для автоматической сортировки новых файлов:
                  </p>
                  
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', marginBottom: '0.5rem' }}>
                    {suggestedRules.map((rule, idx) => (
                      <label key={idx} style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        padding: '0.4rem',
                        background: 'rgba(0,0,0,0.2)',
                        borderRadius: '0.5rem',
                        cursor: 'pointer',
                        fontSize: '0.75rem'
                      }}>
                        <input
                          type="checkbox"
                          checked={rule.selected}
                          onChange={() => {
                            setSuggestedRules(prev => prev.map((r, i) => 
                              i === idx ? { ...r, selected: !r.selected } : r
                            ))
                          }}
                          style={{ accentColor: '#10b981' }}
                        />
                        <span style={{ flex: 1 }}>{rule.description}</span>
                        <span style={{ 
                          fontSize: '0.6rem', 
                          color: '#6b7280',
                          background: 'rgba(0,0,0,0.3)',
                          padding: '0.1rem 0.3rem',
                          borderRadius: '0.25rem'
                        }}>
                          {rule.file_count} файлов
                        </span>
                      </label>
                    ))}
                  </div>
                  
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button 
                      className="btn btn-secondary" 
                      onClick={() => setShowRulesModal(false)}
                      style={{ flex: 1 }}
                    >
                      Отмена
                    </button>
                    <button 
                      className="btn btn-primary" 
                      onClick={() => {
                        // TODO: Save rules to backend
                        const selectedRules = suggestedRules.filter(r => r.selected)
                        console.log('Selected rules:', selectedRules)
                        setShowRulesModal(false)
                        setOrganizeStatus(`✅ Готово! Выбрано ${selectedRules.length} правил`)
                      }}
                      style={{ flex: 1, background: 'linear-gradient(135deg, #10b981, #3b82f6)' }}
                    >
                      💾 Сохранить ({suggestedRules.filter(r => r.selected).length})
                    </button>
                  </div>
                </div>
              </div>
            )}
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
                      checked={useExistingFolders}
                      onChange={(e) => setUseExistingFolders(e.target.checked)}
                      style={{ accentColor: '#3b82f6' }}
                    />
                    <span style={{ fontSize: '0.7rem', color: '#d1d5db' }}>📁 Использовать существующие папки</span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={useContentExtraction}
                      onChange={(e) => setUseContentExtraction(e.target.checked)}
                      style={{ accentColor: '#f59e0b' }}
                    />
                    <span style={{ fontSize: '0.7rem', color: '#d1d5db' }}>🔍 OCR и извлечение текста</span>
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
                
                {/* Custom Prompt */}
                <div style={{ marginTop: '0.5rem' }}>
                  <label style={{ fontSize: '0.7rem', color: '#9ca3af', display: 'block', marginBottom: '0.25rem' }}>
                    📝 Свои инструкции (необязательно):
                  </label>
                  <textarea
                    value={customPrompt}
                    onChange={(e) => setCustomPrompt(e.target.value)}
                    placeholder="Например: Сортируй по проектам. Все документы с 'KBTU' в название папки Учёба/KBTU..."
                    style={{
                      width: '100%',
                      minHeight: '50px',
                      padding: '0.4rem',
                      borderRadius: '0.5rem',
                      border: '1px solid #374151',
                      background: '#1f2937',
                      color: 'white',
                      fontSize: '0.7rem',
                      resize: 'vertical'
                    }}
                  />
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
