//! File watching and processing module.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::AppHandle;
use tokio::sync::mpsc;
use tokio::time::sleep;

use crate::api_client::{self, ActionLogRequest, ClassifyRequest};

pub struct FileWatcher {
    folders: Vec<String>,
    api_url: String,
    token: String,
    app_handle: AppHandle,
    is_paused: Arc<Mutex<bool>>,
    files_today: Arc<Mutex<u32>>,
    processed_files: Arc<Mutex<HashSet<PathBuf>>>,
}

impl FileWatcher {
    pub fn new(
        folders: Vec<String>,
        api_url: String,
        token: String,
        app_handle: AppHandle,
        is_paused: Arc<Mutex<bool>>,
        files_today: Arc<Mutex<u32>>,
    ) -> Self {
        Self {
            folders,
            api_url,
            token,
            app_handle,
            is_paused,
            files_today,
            processed_files: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    pub async fn start(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let (tx, mut rx) = mpsc::channel::<PathBuf>(100);

        let folders = self.folders.clone();
        
        // Spawn the watcher in a blocking thread
        std::thread::spawn(move || {
            let rt = tokio::runtime::Runtime::new().unwrap();
            let tx_clone = tx.clone();
            
            let mut watcher = RecommendedWatcher::new(
                move |res: Result<Event, notify::Error>| {
                    if let Ok(event) = res {
                        for path in event.paths {
                            if path.is_file() {
                                let tx = tx_clone.clone();
                                rt.spawn(async move {
                                    let _ = tx.send(path).await;
                                });
                            }
                        }
                    }
                },
                Config::default(),
            ).unwrap();

            for folder in &folders {
                let path = PathBuf::from(folder);
                if path.exists() {
                    watcher.watch(&path, RecursiveMode::NonRecursive).ok();
                    log::info!("Watching folder: {}", folder);
                }
            }

            // Keep the watcher alive
            loop {
                std::thread::sleep(Duration::from_secs(1));
            }
        });

        // Process events
        let api_url = self.api_url.clone();
        let token = self.token.clone();
        let app_handle = self.app_handle.clone();
        let is_paused = self.is_paused.clone();
        let files_today = self.files_today.clone();
        let processed_files = self.processed_files.clone();

        tokio::spawn(async move {
            while let Some(path) = rx.recv().await {
                // Skip if paused
                if *is_paused.lock().unwrap() {
                    continue;
                }

                // Skip if already processed
                {
                    let processed = processed_files.lock().unwrap();
                    if processed.contains(&path) {
                        continue;
                    }
                }

                // Wait for file to be fully written
                sleep(Duration::from_secs(3)).await;

                // Skip if file no longer exists
                if !path.exists() {
                    continue;
                }

                // Skip temp files
                let filename = path.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("");
                
                if filename.starts_with('.') || filename.starts_with('~') {
                    continue;
                }

                // Process the file
                if let Err(e) = process_file(
                    &path,
                    &api_url,
                    &token,
                    &app_handle,
                    &files_today,
                ).await {
                    log::error!("Error processing file {:?}: {}", path, e);
                }

                // Mark as processed
                {
                    let mut processed = processed_files.lock().unwrap();
                    processed.insert(path);
                }
            }
        });

        Ok(())
    }
}

async fn process_file(
    path: &PathBuf,
    api_url: &str,
    token: &str,
    app_handle: &AppHandle,
    files_today: &Arc<Mutex<u32>>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let filename = path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();
    
    let extension = path.extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e))
        .unwrap_or_default();

    let size = path.metadata().map(|m| m.len()).ok();

    // Read content preview for text files
    let content_preview = if is_text_file(&extension) {
        read_content_preview(path).ok()
    } else {
        None
    };

    log::info!("Processing file: {}", filename);

    // Classify the file
    let classify_request = ClassifyRequest {
        filename: filename.clone(),
        extension: extension.clone(),
        size_bytes: size,
        content_preview,
    };

    let classification = api_client::classify_file(api_url, token, &classify_request).await?;
    
    log::info!(
        "Classified {} -> {} ({})",
        filename,
        classification.destination,
        classification.classification_method
    );

    // Build destination path
    let source_dir = path.parent().unwrap();
    let dest_dir = source_dir.join(&classification.destination);
    
    // Create destination directory
    std::fs::create_dir_all(&dest_dir)?;
    
    let dest_path = dest_dir.join(&filename);
    
    // Check for conflict
    let mut final_dest_path = dest_path.clone();
    let strategy = classification.conflict_strategy.as_deref().unwrap_or("skip");

    if dest_path.exists() {
        match strategy {
            "overwrite" => {
                // Will evaluate to simple rename, which overwrites on atomic systems, 
                // but on Windows might fail if not handled. 
                // std::fs::rename on Windows FAILS if target exists.
                if dest_path.exists() {
                    std::fs::remove_file(&dest_path)?;
                }
            },
            "rename" => {
                let mut counter = 1;
                let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
                let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
                
                while final_dest_path.exists() {
                    let new_name = if ext.is_empty() {
                        format!("{} ({})", stem, counter)
                    } else {
                        format!("{} ({}).{}", stem, counter, ext)
                    };
                    final_dest_path = dest_dir.join(new_name);
                    counter += 1;
                }
            },
            "skip" | _ => {
                log::info!("Skipping {} because it exists and strategy is skip", filename);
                return Ok(());
            }
        }
    }
    
    let dest_path = final_dest_path; // Re-bind to immutable

    // Move the file
    std::fs::rename(path, &dest_path)?;
    
    log::info!("Moved {} to {:?}", filename, dest_path);

    // Log the action
    let action_request = ActionLogRequest {
        filename: filename.clone(),
        source_path: path.to_string_lossy().to_string(),
        dest_path: dest_path.to_string_lossy().to_string(),
        category_id: None,
        rule_id: classification.rule_id,
        confidence: classification.confidence,
    };

    api_client::log_action(api_url, token, &action_request).await?;

    // Update counter
    {
        let mut count = files_today.lock().unwrap();
        *count += 1;
    }

    // Send notification
    let _ = tauri::api::notification::Notification::new(&app_handle.config().tauri.bundle.identifier)
        .title("Файл отсортирован")
        .body(&format!("{} → {}", filename, classification.destination))
        .show();

    Ok(())
}

fn is_text_file(extension: &str) -> bool {
    matches!(
        extension.to_lowercase().as_str(),
        ".txt" | ".md" | ".json" | ".xml" | ".csv" | ".log"
            | ".py" | ".js" | ".ts" | ".html" | ".css"
            | ".yaml" | ".yml" | ".toml" | ".ini" | ".cfg"
    )
}

fn read_content_preview(path: &PathBuf) -> Result<String, std::io::Error> {
    use std::io::Read;
    
    let mut file = std::fs::File::open(path)?;
    let mut buffer = vec![0u8; 1000]; // Read first 1000 bytes
    let bytes_read = file.read(&mut buffer)?;
    buffer.truncate(bytes_read);
    
    Ok(String::from_utf8_lossy(&buffer).to_string())
}
