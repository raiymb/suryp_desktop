#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod api_client;
mod file_watcher;
mod classifier;
mod config;
mod storage;

use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::{
    CustomMenuItem, Manager, SystemTray, SystemTrayEvent, SystemTrayMenu, SystemTrayMenuItem,
    WindowEvent,
};
use serde::{Deserialize, Serialize};

use crate::config::AppConfig;
use crate::file_watcher::FileWatcher;

pub struct AppState {
    pub config: Arc<Mutex<AppConfig>>,
    pub watcher: Arc<Mutex<Option<FileWatcher>>>,
    pub is_paused: Arc<Mutex<bool>>,
    pub files_today: Arc<Mutex<u32>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileInfoForOrganize {
    pub filename: String,
    pub extension: String,
    pub size_bytes: u64,
    pub path: String,
    pub modified: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MoveAction {
    pub source_path: String,
    pub dest_folder: String,
    pub filename: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MoveResult {
    pub success: bool,
    pub moved_count: u32,
    pub skipped_count: u32,
    pub errors: Vec<String>,
}

fn main() {
    env_logger::init();

    let config = AppConfig::load().unwrap_or_default();
    
    let app_state = AppState {
        config: Arc::new(Mutex::new(config)),
        watcher: Arc::new(Mutex::new(None)),
        is_paused: Arc::new(Mutex::new(false)),
        files_today: Arc::new(Mutex::new(0)),
    };

    let tray_menu = create_tray_menu(false, 0);
    let system_tray = SystemTray::new().with_menu(tray_menu);

    tauri::Builder::default()
        .system_tray(system_tray)
        .on_system_tray_event(handle_tray_event)
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            get_status,
            get_config,
            save_config,
            login,
            logout,
            toggle_pause,
            get_recent_actions,
            open_dashboard,
            start_watching,
            stop_watching,
            // Auto-organize commands
            scan_folder_for_organize,
            read_file_content,
            execute_file_moves,
            get_user_folders,
            get_access_token,
        ])
        .on_window_event(|event| match event.event() {
            WindowEvent::CloseRequested { api, .. } => {
                // Hide window instead of closing
                event.window().hide().unwrap();
                api.prevent_close();
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn create_tray_menu(is_paused: bool, files_count: u32) -> SystemTrayMenu {
    let status = if is_paused { "⏸️ На паузе" } else { "✅ Активен" };
    let status_item = CustomMenuItem::new("status", format!("{} • {} файлов сегодня", status, files_count)).disabled();
    
    let pause_text = if is_paused { "▶️ Продолжить" } else { "⏸️ Пауза" };
    let pause = CustomMenuItem::new("pause", pause_text);
    let settings = CustomMenuItem::new("settings", "⚙️ Настройки");
    let dashboard = CustomMenuItem::new("dashboard", "🌐 Открыть Dashboard");
    let quit = CustomMenuItem::new("quit", "❌ Выход");

    SystemTrayMenu::new()
        .add_item(status_item)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(pause)
        .add_item(settings)
        .add_item(dashboard)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(quit)
}

fn handle_tray_event(app: &tauri::AppHandle, event: SystemTrayEvent) {
    match event {
        SystemTrayEvent::LeftClick { .. } => {
            if let Some(window) = app.get_window("main") {
                // Always try to show and focus the window
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        SystemTrayEvent::DoubleClick { .. } => {
            if let Some(window) = app.get_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        SystemTrayEvent::MenuItemClick { id, .. } => {
            let state = app.state::<AppState>();
            
            match id.as_str() {
                "pause" => {
                    if let Ok(mut is_paused) = state.is_paused.lock() {
                        *is_paused = !*is_paused;
                        let files_count = state.files_today.lock().map(|f| *f).unwrap_or(0);
                        let new_menu = create_tray_menu(*is_paused, files_count);
                        let _ = app.tray_handle().set_menu(new_menu);
                    }
                }
                "settings" => {
                    if let Some(window) = app.get_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "dashboard" => {
                    let config = state.config.lock().unwrap();
                    let url = config.dashboard_url.clone();
                    drop(config);
                    tauri::api::shell::open(&app.shell_scope(), url, None).unwrap();
                }
                "quit" => {
                    std::process::exit(0);
                }
                _ => {}
            }
        }
        _ => {}
    }
}

#[tauri::command]
fn get_status(state: tauri::State<AppState>) -> serde_json::Value {
    let is_paused = *state.is_paused.lock().unwrap();
    let files_today = *state.files_today.lock().unwrap();
    let config = state.config.lock().unwrap();
    
    serde_json::json!({
        "is_paused": is_paused,
        "files_today": files_today,
        "is_logged_in": config.access_token.is_some(),
        "watched_folders": config.watched_folders.clone(),
    })
}

#[tauri::command]
fn get_access_token(state: tauri::State<AppState>) -> Option<String> {
    let config = state.config.lock().unwrap();
    config.access_token.clone()
}

#[tauri::command]
fn get_config(state: tauri::State<AppState>) -> serde_json::Value {
    let config = state.config.lock().unwrap();
    serde_json::to_value(&*config).unwrap()
}

#[tauri::command]
async fn save_config(state: tauri::State<'_, AppState>, config: AppConfig) -> Result<(), String> {
    let mut current_config = state.config.lock().map_err(|e| e.to_string())?;
    *current_config = config.clone();
    config.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn login(
    state: tauri::State<'_, AppState>,
    email: String,
    password: String,
) -> Result<serde_json::Value, String> {
    let api_url = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        config.api_url.clone()
    };

    let result = api_client::login(&api_url, &email, &password).await?;
    
    {
        let mut config = state.config.lock().map_err(|e| e.to_string())?;
        config.access_token = Some(result["access_token"].as_str().unwrap().to_string());
        config.refresh_token = Some(result["refresh_token"].as_str().unwrap().to_string());
        config.save().map_err(|e| e.to_string())?;
    }

    Ok(result)
}

#[tauri::command]
async fn logout(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.access_token = None;
    config.refresh_token = None;
    config.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn toggle_pause(app: tauri::AppHandle, state: tauri::State<AppState>) -> bool {
    let Ok(mut is_paused) = state.is_paused.lock() else {
        return false;
    };
    *is_paused = !*is_paused;
    
    let files_count = state.files_today.lock().map(|f| *f).unwrap_or(0);
    let new_menu = create_tray_menu(*is_paused, files_count);
    let _ = app.tray_handle().set_menu(new_menu);
    
    *is_paused
}

#[tauri::command]
async fn get_recent_actions(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let (api_url, token) = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        
        if config.access_token.is_none() {
            return Ok(serde_json::json!([]));
        }

        (config.api_url.clone(), config.access_token.clone().unwrap())
    };

    api_client::get_recent_actions(&api_url, &token).await
}

#[tauri::command]
fn open_dashboard(state: tauri::State<AppState>) -> String {
    let config = state.config.lock().unwrap();
    config.dashboard_url.clone()
}

#[tauri::command]
async fn start_watching(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let (folders, api_url, token) = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        let folders = config.watched_folders.clone();
        let api_url = config.api_url.clone();
        let token = config.access_token.clone();
        (folders, api_url, token)
    };

    if token.is_none() {
        return Err("Not logged in".to_string());
    }

    let is_paused = state.is_paused.clone();
    let files_today = state.files_today.clone();

    let watcher = FileWatcher::new(
        folders,
        api_url,
        token.unwrap(),
        app.clone(),
        is_paused,
        files_today,
    );

    watcher.start().await.map_err(|e| e.to_string())?;

    {
        let mut watcher_guard = state.watcher.lock().map_err(|e| e.to_string())?;
        *watcher_guard = Some(watcher);
    }

    Ok(())
}

#[tauri::command]
fn stop_watching(state: tauri::State<AppState>) -> Result<(), String> {
    let mut watcher = state.watcher.lock().map_err(|e| e.to_string())?;
    *watcher = None;
    Ok(())
}

// ============================================
// Auto-Organize Commands
// ============================================

/// Scan a folder and return list of files with metadata
#[tauri::command]
async fn scan_folder_for_organize(folder_path: String) -> Result<Vec<FileInfoForOrganize>, String> {
    let path = Path::new(&folder_path);
    
    if !path.exists() {
        return Err(format!("Folder does not exist: {}", folder_path));
    }
    
    if !path.is_dir() {
        return Err(format!("Path is not a directory: {}", folder_path));
    }
    
    let mut files = Vec::new();
    
    // Read directory entries
    let entries = fs::read_dir(path).map_err(|e| format!("Failed to read directory: {}", e))?;
    
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        
        let file_path = entry.path();
        
        // Skip directories and hidden files
        if file_path.is_dir() {
            continue;
        }
        
        let filename = file_path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        
        // Skip hidden files (starting with .)
        if filename.starts_with('.') {
            continue;
        }
        
        let extension = file_path.extension()
            .and_then(|e| e.to_str())
            .map(|e| format!(".{}", e.to_lowercase()))
            .unwrap_or_default();
        
        let metadata = fs::metadata(&file_path).ok();
        let size_bytes = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
        let modified = metadata.and_then(|m| m.modified().ok())
            .map(|t| {
                let datetime: chrono::DateTime<chrono::Utc> = t.into();
                datetime.to_rfc3339()
            });
        
        files.push(FileInfoForOrganize {
            filename,
            extension,
            size_bytes,
            path: file_path.to_string_lossy().to_string(),
            modified,
        });
    }
    
    Ok(files)
}

/// Read file content (first N bytes) for content extraction
#[tauri::command]
async fn read_file_content(file_path: String, max_bytes: Option<usize>) -> Result<Vec<u8>, String> {
    let path = Path::new(&file_path);
    
    if !path.exists() {
        return Err(format!("File does not exist: {}", file_path));
    }
    
    let max_bytes = max_bytes.unwrap_or(1024 * 1024); // Default 1MB
    
    let content = fs::read(path).map_err(|e| format!("Failed to read file: {}", e))?;
    
    // Limit content size
    if content.len() > max_bytes {
        Ok(content[..max_bytes].to_vec())
    } else {
        Ok(content)
    }
}

/// Execute file moves for auto-organize
#[tauri::command]
async fn execute_file_moves(
    base_folder: String,
    moves: Vec<MoveAction>,
    create_folders: bool,
) -> Result<MoveResult, String> {
    let mut moved_count = 0u32;
    let mut skipped_count = 0u32;
    let mut errors = Vec::new();
    
    let base_path = Path::new(&base_folder);
    
    for action in moves {
        let source = Path::new(&action.source_path);
        let dest_folder = base_path.join(&action.dest_folder);
        let dest_file = dest_folder.join(&action.filename);
        
        // Create destination folder if needed
        if create_folders && !dest_folder.exists() {
            if let Err(e) = fs::create_dir_all(&dest_folder) {
                errors.push(format!("Failed to create folder {}: {}", dest_folder.display(), e));
                skipped_count += 1;
                continue;
            }
        }
        
        // Check if destination already exists
        if dest_file.exists() {
            skipped_count += 1;
            continue;
        }
        
        // Move the file
        match fs::rename(source, &dest_file) {
            Ok(_) => {
                moved_count += 1;
            }
            Err(e) => {
                // Try copy + delete if rename fails (cross-filesystem)
                match fs::copy(source, &dest_file) {
                    Ok(_) => {
                        let _ = fs::remove_file(source);
                        moved_count += 1;
                    }
                    Err(copy_err) => {
                        errors.push(format!("Failed to move {}: {} / {}", action.filename, e, copy_err));
                        skipped_count += 1;
                    }
                }
            }
        }
    }
    
    Ok(MoveResult {
        success: errors.is_empty(),
        moved_count,
        skipped_count,
        errors,
    })
}

/// Get common user folder paths
#[tauri::command]
fn get_user_folders() -> serde_json::Value {
    let desktop = dirs::desktop_dir().map(|p| p.to_string_lossy().to_string());
    let documents = dirs::document_dir().map(|p| p.to_string_lossy().to_string());
    let downloads = dirs::download_dir().map(|p| p.to_string_lossy().to_string());
    let home = dirs::home_dir().map(|p| p.to_string_lossy().to_string());
    
    serde_json::json!({
        "desktop": desktop,
        "documents": documents,
        "downloads": downloads,
        "home": home
    })
}

