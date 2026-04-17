use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::query_registry;

#[derive(Debug, Deserialize)]
pub struct QueryReq {
    pub key: String,
    pub card_type_id: String,
    pub source: String,
    pub controls: Value,
}

#[derive(Debug, Serialize)]
pub struct QueryResult {
    pub key: String,
    pub status: String,
    pub data: Value,
    pub row_count: usize,
    pub query_ms: u64,
    pub error: Option<String>,
}

/// Fetch a batch of scene card data queries. Iterated against the query
/// registry; returns one result per request in the same order.
#[tauri::command]
pub async fn scene_data_fetch_batch(reqs: Vec<QueryReq>) -> Vec<QueryResult> {
    reqs.into_iter()
        .map(|req| {
            match query_registry::resolve(&req.card_type_id, &req.source, &req.controls) {
                Ok(output) => QueryResult {
                    key: req.key,
                    status: "ok".into(),
                    data: output.data,
                    row_count: output.row_count,
                    query_ms: output.query_ms,
                    error: None,
                },
                Err(e) => QueryResult {
                    key: req.key,
                    status: "error".into(),
                    data: Value::Null,
                    row_count: 0,
                    query_ms: 0,
                    error: Some(e),
                },
            }
        })
        .collect()
}
