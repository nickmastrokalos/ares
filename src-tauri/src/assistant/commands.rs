use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE};
use serde_json::{json, Value};

#[tauri::command]
pub async fn assistant_chat(
    provider: String,
    model: String,
    api_key: String,
    system: Option<String>,
    messages: Vec<Value>,
    tools: Vec<Value>,
) -> Result<Value, String> {
    match provider.as_str() {
        "anthropic" => anthropic_chat(model, api_key, system, messages, tools).await,
        other => Err(format!("provider '{other}' not yet supported")),
    }
}

async fn anthropic_chat(
    model: String,
    api_key: String,
    system: Option<String>,
    messages: Vec<Value>,
    tools: Vec<Value>,
) -> Result<Value, String> {
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-api-key",
        HeaderValue::from_str(&api_key).map_err(|e| e.to_string())?,
    );
    headers.insert(
        "anthropic-version",
        HeaderValue::from_static("2023-06-01"),
    );
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

    let mut body = json!({
        "model": model,
        "max_tokens": 4096,
        "messages": messages,
    });

    if let Some(sys) = system {
        if !sys.is_empty() {
            body["system"] = json!(sys);
        }
    }

    if !tools.is_empty() {
        body["tools"] = json!(tools);
    }

    let client = reqwest::Client::new();
    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .headers(headers)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    let response_body: Value = response.json().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        let msg = response_body["error"]["message"]
            .as_str()
            .unwrap_or("unknown error")
            .to_string();
        return Err(format!("Anthropic API error {status}: {msg}"));
    }

    Ok(response_body)
}
