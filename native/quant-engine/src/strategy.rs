//! Versioned, declarative PAPER / SHADOW strategies. No code loading or broker.
use crate::{
    decimal::Fixed,
    ledger::{Submit, id},
};
use serde::{Deserialize, Serialize};
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Paper,
    Shadow,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Sides {
    Both,
    Buy,
    Sell,
}
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Maker {
    pub quantity: Fixed,
    pub sides: Sides,
    pub bid_offset_ticks: u32,
    pub ask_offset_ticks: u32,
    pub reprice_ticks: u32,
    pub refresh_ms: u64,
    pub ttl_ms: u64,
    pub min_inventory: Fixed,
    pub max_inventory: Fixed,
    pub max_notional: Fixed,
    pub max_fees: Fixed,
    pub max_decisions: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Definition {
    pub id: String,
    pub owner: String,
    pub name: String,
    pub revision: u32,
    pub account: String,
    pub instrument: String,
    pub maker: Maker,
}
impl Definition {
    pub fn validate(&self) -> Result<(), String> {
        for v in [&self.id, &self.owner, &self.account, &self.instrument] {
            id(v)?;
        }
        let c = &self.maker;
        if !self.id.starts_with("strategy:")
            || self.name.is_empty()
            || self.name.chars().count() > 80
            || self.name.chars().any(char::is_control)
            || self.revision == 0
            || self.revision > 1000
            || c.quantity.0 <= 0
            || c.min_inventory.0 < 0
            || c.max_inventory <= c.min_inventory
            || c.quantity > c.max_inventory.checked_sub(c.min_inventory)?
            || c.max_notional.0 <= 0
            || c.max_fees.0 <= 0
            || c.reprice_ticks == 0
            || c.reprice_ticks > 100000
            || c.bid_offset_ticks > 100000
            || c.ask_offset_ticks > 100000
            || !(100..=60000).contains(&c.refresh_ms)
            || c.ttl_ms < c.refresh_ms.max(1000)
            || c.ttl_ms > 3600000
            || c.max_decisions == 0
            || c.max_decisions > 100000
        {
            return Err("INVALID_STRATEGY".into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Running,
    Paused,
    Stopped,
    Completed,
}
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Run {
    pub id: String,
    pub strategy: String,
    pub revision: u32,
    pub mode: Mode,
    pub phase: Phase,
    pub reason: String,
    pub created_at_ns: String,
    pub updated_at_ns: String,
    pub decisions: u64,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Stats {
    pub gross_filled: Fixed,
    pub fees: Fixed,
    pub open_notional: Fixed,
    pub pending_fees: Fixed,
    pub orders: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Outcome {
    pub order_id: String,
    pub status: String,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Decision {
    pub run: String,
    pub ordinal: u64,
    pub at_ns: String,
    pub observation: serde_json::Value,
    pub intents: Vec<Submit>,
    pub outcomes: Vec<Outcome>,
}
