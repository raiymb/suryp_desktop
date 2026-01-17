//! API client for communicating with the FileSorter backend.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Serialize)]
pub struct ClassifyRequest {
    pub filename: String,
    pub extension: String,
    pub size_bytes: Option<u64>,
    pub content_preview: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ClassifyResponse {
    pub category: String,
    pub destination: String,
    pub confidence: f64,
    pub rule_id: Option<String>,
    pub rule_name: Option<String>,
    pub classification_method: String,
    pub conflict_strategy: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ActionLogRequest {
    pub filename: String,
    pub source_path: String,
    pub dest_path: String,
    pub category_id: Option<String>,
    pub rule_id: Option<String>,
    pub confidence: f64,
}

/// Login to the API and get tokens
pub async fn login(api_url: &str, email: &str, password: &str) -> Result<Value, String> {
    let client = reqwest::Client::new();
    
    let response = client
        .post(format!("{}/api/auth/login", api_url))
        .json(&serde_json::json!({
            "email": email,
            "password": password,
        }))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Login failed: {} - {}", status, body));
    }

    response
        .json()
        .await
        .map_err(|e| format!("Parse error: {}", e))
}

/// Refresh access token
pub async fn refresh_token(api_url: &str, refresh_token: &str) -> Result<Value, String> {
    let client = reqwest::Client::new();
    
    let response = client
        .post(format!("{}/api/auth/refresh", api_url))
        .json(&serde_json::json!({
            "refresh_token": refresh_token,
        }))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        return Err("Token refresh failed".to_string());
    }

    response
        .json()
        .await
        .map_err(|e| format!("Parse error: {}", e))
}

/// Classify a file using the API
pub async fn classify_file(
    api_url: &str,
    token: &str,
    request: &ClassifyRequest,
) -> Result<ClassifyResponse, String> {
    let client = reqwest::Client::new();
    
    let response = client
        .post(format!("{}/api/classify", api_url))
        .header("Authorization", format!("Bearer {}", token))
        .json(request)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if response.status().as_u16() == 402 {
        return Err("Plan limit reached. Upgrade to Pro for unlimited sorting.".to_string());
    }

    if !response.status().is_success() {
        let status = response.status();
        return Err(format!("Classification failed: {}", status));
    }

    response
        .json()
        .await
        .map_err(|e| format!("Parse error: {}", e))
}

/// Log a completed action
pub async fn log_action(
    api_url: &str,
    token: &str,
    request: &ActionLogRequest,
) -> Result<Value, String> {
    let client = reqwest::Client::new();
    
    let response = client
        .post(format!("{}/api/actions/log", api_url))
        .header("Authorization", format!("Bearer {}", token))
        .json(request)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        return Err(format!("Action logging failed: {}", status));
    }

    response
        .json()
        .await
        .map_err(|e| format!("Parse error: {}", e))
}

/// Get recent actions for display
pub async fn get_recent_actions(api_url: &str, token: &str) -> Result<Value, String> {
    let client = reqwest::Client::new();
    
    let response = client
        .get(format!("{}/api/history?page=1&per_page=5", api_url))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        return Ok(serde_json::json!({"actions": []}));
    }

    response
        .json()
        .await
        .map_err(|e| format!("Parse error: {}", e))
}

/// Get user's rules for local caching
pub async fn get_rules(api_url: &str, token: &str) -> Result<Value, String> {
    let client = reqwest::Client::new();
    
    let response = client
        .get(format!("{}/api/rules", api_url))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        return Err("Failed to fetch rules".to_string());
    }

    response
        .json()
        .await
        .map_err(|e| format!("Parse error: {}", e))
}
