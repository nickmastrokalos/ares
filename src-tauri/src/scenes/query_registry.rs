use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Serialize, Deserialize)]
pub struct QueryOutput {
    pub data: Value,
    pub row_count: usize,
    pub query_ms: u64,
}

impl QueryOutput {
    pub fn empty() -> Self {
        Self {
            data: Value::Null,
            row_count: 0,
            query_ms: 0,
        }
    }
}

/// Resolve a scene card data query to a `QueryOutput`.
///
/// Phase 1: all card types return empty data — connectors are not yet wired.
/// Phase 2: add match arms for each vendor card type (e.g. "starlink-status").
pub fn resolve(
    _card_type_id: &str,
    _source: &str,
    _controls: &Value,
) -> Result<QueryOutput, String> {
    Ok(QueryOutput::empty())
}
