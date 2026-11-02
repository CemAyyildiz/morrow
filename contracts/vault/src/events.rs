//! The event log: the only integration feed (`events_since`), mirrored as NEP-297 logs.

use near_sdk::json_types::U64;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::{env, near};

pub const EVENT_STANDARD: &str = "morrow";
pub const EVENT_VERSION: &str = "1.0.0";
pub const EVENTS_SINCE_MAX_LIMIT: u32 = 100;

/// Stored event; `data` is kept as JSON text so new kinds never change the storage layout.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct StoredEvent {
    pub block_timestamp: u64,
    pub vault_id: u64,
    pub kind: String,
    pub data: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct EventView {
    pub seq: U64,
    pub block_timestamp: U64,
    pub vault_id: U64,
    pub kind: String,
    pub data: Value,
}

impl StoredEvent {
    pub fn view(&self, seq: u64) -> EventView {
        EventView {
            seq: U64(seq),
            block_timestamp: U64(self.block_timestamp),
            vault_id: U64(self.vault_id),
            kind: self.kind.clone(),
            data: serde_json::from_str(&self.data).unwrap_or(Value::Null),
        }
    }
}

/// Builds the event for the current block and writes its NEP-297 log line.
pub fn record(vault_id: u64, kind: &str, data: Value) -> StoredEvent {
    let log = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": kind,
        "data": [{ "vault_id": U64(vault_id), "payload": data.clone() }],
    });
    env::log_str(&format!("EVENT_JSON:{log}"));
    StoredEvent {
        block_timestamp: env::block_timestamp(),
        vault_id,
        kind: kind.to_string(),
        data: data.to_string(),
    }
}
