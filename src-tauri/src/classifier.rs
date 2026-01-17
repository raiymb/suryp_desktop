//! Local file classifier for offline mode.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalRule {
    pub id: String,
    pub name: String,
    pub condition_type: String,
    pub condition_value: serde_json::Value,
    pub destination: String,
    pub priority: i32,
}

#[derive(Debug, Clone)]
pub struct LocalClassifier {
    rules: Vec<LocalRule>,
    extension_map: HashMap<String, String>,
}

impl Default for LocalClassifier {
    fn default() -> Self {
        let mut extension_map = HashMap::new();
        
        // Documents
        for ext in &[".pdf", ".doc", ".docx", ".txt", ".rtf", ".odt", ".xls", ".xlsx", ".ppt", ".pptx"] {
            extension_map.insert(ext.to_string(), "Documents".to_string());
        }
        
        // Images
        for ext in &[".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".svg", ".heic", ".ico"] {
            extension_map.insert(ext.to_string(), "Pictures".to_string());
        }
        
        // Videos
        for ext in &[".mp4", ".avi", ".mkv", ".mov", ".wmv", ".webm", ".flv", ".m4v"] {
            extension_map.insert(ext.to_string(), "Videos".to_string());
        }
        
        // Audio
        for ext in &[".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a", ".wma"] {
            extension_map.insert(ext.to_string(), "Music".to_string());
        }
        
        // Archives
        for ext in &[".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz"] {
            extension_map.insert(ext.to_string(), "Archives".to_string());
        }
        
        // Executables
        for ext in &[".exe", ".msi", ".dmg", ".deb", ".rpm", ".appimage"] {
            extension_map.insert(ext.to_string(), "Installers".to_string());
        }
        
        // Code
        for ext in &[".py", ".js", ".ts", ".html", ".css", ".java", ".cpp", ".c", ".go", ".rs", ".rb"] {
            extension_map.insert(ext.to_string(), "Code".to_string());
        }

        Self {
            rules: Vec::new(),
            extension_map,
        }
    }
}

impl LocalClassifier {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_rules(&mut self, rules: Vec<LocalRule>) {
        self.rules = rules;
        self.rules.sort_by(|a, b| b.priority.cmp(&a.priority));
    }

    pub fn classify(&self, filename: &str, extension: &str) -> Option<(String, String, f64)> {
        // First try user rules
        for rule in &self.rules {
            if self.matches_rule(rule, filename, extension) {
                return Some((
                    rule.name.clone(),
                    rule.destination.clone(),
                    1.0,
                ));
            }
        }

        // Fall back to extension-based classification
        if let Some(category) = self.extension_map.get(&extension.to_lowercase()) {
            return Some((
                category.clone(),
                category.clone(),
                0.8,
            ));
        }

        // Default to "Other"
        Some(("Other".to_string(), "Other".to_string(), 0.5))
    }

    fn matches_rule(&self, rule: &LocalRule, filename: &str, extension: &str) -> bool {
        match rule.condition_type.as_str() {
            "extension" => {
                if let Some(extensions) = rule.condition_value.get("extensions") {
                    if let Some(arr) = extensions.as_array() {
                        return arr.iter()
                            .filter_map(|v| v.as_str())
                            .any(|e| e.eq_ignore_ascii_case(extension));
                    }
                }
                false
            }
            "keyword" => {
                if let Some(keywords) = rule.condition_value.get("keywords") {
                    if let Some(arr) = keywords.as_array() {
                        let case_sensitive = rule.condition_value
                            .get("case_sensitive")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        
                        let check_filename = if case_sensitive {
                            filename.to_string()
                        } else {
                            filename.to_lowercase()
                        };

                        return arr.iter()
                            .filter_map(|v| v.as_str())
                            .any(|k| {
                                let keyword = if case_sensitive { k.to_string() } else { k.to_lowercase() };
                                check_filename.contains(&keyword)
                            });
                    }
                }
                false
            }
            "regex" => {
                if let Some(pattern) = rule.condition_value.get("pattern").and_then(|v| v.as_str()) {
                    if let Ok(re) = regex::Regex::new(pattern) {
                        return re.is_match(filename);
                    }
                }
                false
            }
            _ => false,
        }
    }
}
