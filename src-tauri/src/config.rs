//! Configuration management for the desktop agent.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    /// API server URL
    pub api_url: String,
    
    /// Web dashboard URL
    pub dashboard_url: String,
    
    /// Access token for API authentication
    pub access_token: Option<String>,
    
    /// Refresh token for renewing access
    pub refresh_token: Option<String>,
    
    /// List of folders to watch for new files
    pub watched_folders: Vec<String>,
    
    /// Show desktop notifications
    pub show_notifications: bool,
    
    /// Start on system boot
    pub start_on_boot: bool,
    
    /// Delay in seconds before processing new file
    pub processing_delay_seconds: u64,
}

impl Default for AppConfig {
    fn default() -> Self {
        let downloads = dirs::download_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        Self {
            api_url: "http://localhost:8085".to_string(),
            dashboard_url: "http://localhost:3000".to_string(),
            access_token: None,
            refresh_token: None,
            watched_folders: vec![downloads],
            show_notifications: true,
            start_on_boot: false,
            processing_delay_seconds: 3,
        }
    }
}

impl AppConfig {
    /// Get the config file path
    fn config_path() -> PathBuf {
        let config_dir = dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("filesorter");
        
        fs::create_dir_all(&config_dir).ok();
        config_dir.join("config.json")
    }

    /// Load configuration from file
    pub fn load() -> Result<Self, Box<dyn std::error::Error>> {
        let path = Self::config_path();
        
        if !path.exists() {
            let config = Self::default();
            config.save()?;
            return Ok(config);
        }

        let content = fs::read_to_string(&path)?;
        let config: Self = serde_json::from_str(&content)?;
        Ok(config)
    }

    /// Save configuration to file
    pub fn save(&self) -> Result<(), Box<dyn std::error::Error>> {
        let path = Self::config_path();
        let content = serde_json::to_string_pretty(self)?;
        fs::write(&path, content)?;
        Ok(())
    }
}
