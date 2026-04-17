use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
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
        "openai"    => openai_chat(model, api_key, system, messages, tools).await,
        other => Err(format!("provider '{other}' not supported")),
    }
}

// ---- Anthropic ---------------------------------------------------------------

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
    headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
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
    let body: Value = response.json().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        let msg = body["error"]["message"]
            .as_str()
            .unwrap_or("unknown error")
            .to_string();
        return Err(format!("Anthropic {status}: {msg}"));
    }

    Ok(body)
}

// ---- OpenAI ------------------------------------------------------------------

// The frontend turn loop speaks Anthropic's message/response format exclusively.
// We convert both directions here so the JS layer stays provider-agnostic.

/// Convert Anthropic-format tools → OpenAI function-tool objects.
///
/// Anthropic: `{ name, description, input_schema }`
/// OpenAI:    `{ type: "function", function: { name, description, parameters } }`
fn to_openai_tools(tools: &[Value]) -> Value {
    let converted: Vec<Value> = tools
        .iter()
        .map(|t| {
            json!({
                "type": "function",
                "function": {
                    "name":        t["name"],
                    "description": t["description"],
                    "parameters":  t["input_schema"]
                }
            })
        })
        .collect();
    json!(converted)
}

/// Convert Anthropic-format messages → OpenAI messages.
///
/// Anthropic user messages may be a plain string or an array of content blocks.
/// When the array contains `tool_result` blocks (the turn-loop feedback),
/// each block becomes a separate OpenAI message with `role: "tool"`.
///
/// Anthropic assistant messages may be an array of `text` and `tool_use` blocks;
/// these collapse to a single OpenAI assistant message whose `content` is the
/// concatenated text and whose `tool_calls` field carries the function calls.
fn to_openai_messages(system: Option<&str>, messages: &[Value]) -> Value {
    let mut out: Vec<Value> = Vec::new();

    if let Some(sys) = system {
        if !sys.is_empty() {
            out.push(json!({ "role": "system", "content": sys }));
        }
    }

    for msg in messages {
        let role = msg["role"].as_str().unwrap_or("user");

        match role {
            "user" => {
                match &msg["content"] {
                    Value::String(s) => {
                        out.push(json!({ "role": "user", "content": s }));
                    }
                    Value::Array(blocks) => {
                        // Partition: plain text blocks vs tool_result blocks.
                        let mut text_parts: Vec<&str> = Vec::new();
                        let mut tool_results: Vec<&Value> = Vec::new();

                        for block in blocks {
                            match block["type"].as_str() {
                                Some("tool_result") => tool_results.push(block),
                                Some("text") => {
                                    if let Some(t) = block["text"].as_str() {
                                        text_parts.push(t);
                                    }
                                }
                                _ => {}
                            }
                        }

                        if !text_parts.is_empty() {
                            out.push(json!({
                                "role": "user",
                                "content": text_parts.join("\n")
                            }));
                        }

                        for tr in tool_results {
                            let content = match &tr["content"] {
                                Value::String(s) => s.clone(),
                                other => other.to_string(),
                            };
                            out.push(json!({
                                "role":         "tool",
                                "tool_call_id": tr["tool_use_id"],
                                "content":      content
                            }));
                        }
                    }
                    _ => {}
                }
            }

            "assistant" => {
                match &msg["content"] {
                    Value::String(s) => {
                        out.push(json!({ "role": "assistant", "content": s }));
                    }
                    Value::Array(blocks) => {
                        let mut text_parts: Vec<&str> = Vec::new();
                        let mut tool_calls: Vec<Value> = Vec::new();

                        for block in blocks {
                            match block["type"].as_str() {
                                Some("text") => {
                                    if let Some(t) = block["text"].as_str() {
                                        text_parts.push(t);
                                    }
                                }
                                Some("tool_use") => {
                                    let args = match &block["input"] {
                                        Value::Object(_) => block["input"].to_string(),
                                        Value::String(s) => s.clone(),
                                        _ => "{}".to_string(),
                                    };
                                    tool_calls.push(json!({
                                        "id":   block["id"],
                                        "type": "function",
                                        "function": {
                                            "name":      block["name"],
                                            "arguments": args
                                        }
                                    }));
                                }
                                _ => {}
                            }
                        }

                        let mut assistant_msg = json!({
                            "role":    "assistant",
                            "content": if text_parts.is_empty() {
                                Value::Null
                            } else {
                                json!(text_parts.join("\n"))
                            }
                        });

                        if !tool_calls.is_empty() {
                            assistant_msg["tool_calls"] = json!(tool_calls);
                        }

                        out.push(assistant_msg);
                    }
                    _ => {}
                }
            }

            _ => {}
        }
    }

    json!(out)
}

/// Convert an OpenAI response → Anthropic-shaped response so the frontend
/// turn loop can read it without knowing which provider was used.
///
/// OpenAI response shape (relevant fields):
/// ```json
/// {
///   "choices": [{
///     "message": {
///       "content": "text or null",
///       "tool_calls": [{ "id": "…", "function": { "name": "…", "arguments": "{…}" } }]
///     },
///     "finish_reason": "stop" | "tool_calls"
///   }]
/// }
/// ```
fn from_openai_response(resp: Value) -> Result<Value, String> {
    let choice = resp["choices"]
        .as_array()
        .and_then(|a| a.first())
        .ok_or_else(|| "OpenAI response missing choices".to_string())?;

    let finish_reason = choice["finish_reason"].as_str().unwrap_or("stop");
    let message = &choice["message"];

    let mut content_blocks: Vec<Value> = Vec::new();

    // Text content
    if let Some(text) = message["content"].as_str() {
        if !text.is_empty() {
            content_blocks.push(json!({ "type": "text", "text": text }));
        }
    }

    // Tool calls → tool_use blocks
    if let Some(calls) = message["tool_calls"].as_array() {
        for call in calls {
            let raw_args = call["function"]["arguments"].as_str().unwrap_or("{}");
            let input: Value = serde_json::from_str(raw_args).unwrap_or(json!({}));
            content_blocks.push(json!({
                "type":  "tool_use",
                "id":    call["id"],
                "name":  call["function"]["name"],
                "input": input
            }));
        }
    }

    let stop_reason = if finish_reason == "tool_calls" {
        "tool_use"
    } else {
        "end_turn"
    };

    Ok(json!({
        "content":     content_blocks,
        "stop_reason": stop_reason
    }))
}

async fn openai_chat(
    model: String,
    api_key: String,
    system: Option<String>,
    messages: Vec<Value>,
    tools: Vec<Value>,
) -> Result<Value, String> {
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {api_key}"))
            .map_err(|e| e.to_string())?,
    );
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

    let oai_messages = to_openai_messages(system.as_deref(), &messages);

    let mut body = json!({
        "model":    model,
        "messages": oai_messages,
    });

    if !tools.is_empty() {
        body["tools"] = to_openai_tools(&tools);
    }

    let client = reqwest::Client::new();
    let response = client
        .post("https://api.openai.com/v1/chat/completions")
        .headers(headers)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    let resp_body: Value = response.json().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        let msg = resp_body["error"]["message"]
            .as_str()
            .unwrap_or("unknown error")
            .to_string();
        return Err(format!("OpenAI {status}: {msg}"));
    }

    from_openai_response(resp_body)
}
