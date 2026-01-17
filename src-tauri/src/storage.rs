//! Local storage for caching rules and history.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::classifier::LocalRule;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LocalStorage {
    pub cached_rules: Vec<LocalRule>,
    pub pending_actions: Vec<PendingAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingAction {
    pub filename: String,
    pub source_path: String,
    pub dest_path: String,
    pub confidence: f64,
    pub timestamp: i64,
}

impl LocalStorage {
    fn storage_path() -> PathBuf {
        let config_dir = dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("filesorter");
        
        fs::create_dir_all(&config_dir).ok();
        config_dir.join("storage.json")
    }

    pub fn load() -> Self {
        let path = Self::storage_path();
        
        if !path.exists() {
            return Self::default();
        }

        fs::read_to_string(&path)
            .ok()
            .and_then(|content| serde_json::from_str(&content).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> Result<(), Box<dyn std::error::Error>> {
        let path = Self::storage_path();
        let content = serde_json::to_string_pretty(self)?;
        fs::write(&path, content)?;
        Ok(())
    }

    pub fn cache_rules(&mut self, rules: Vec<LocalRule>) {
        self.cached_rules = rules;
        self.save().ok();
    }

    pub fn add_pending_action(&mut self, action: PendingAction) {
        self.pending_actions.push(action);
        self.save().ok();
    }

    pub fn clear_pending_actions(&mut self) {
        self.pending_actions.clear();
        self.save().ok();
    }
}
