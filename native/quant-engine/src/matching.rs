//! Conservative L2 PAPER FIFO model: same-price public maker trades only.
//! Cancellations of external liquidity do not improve queue position. Latency
//! and active queue state are explicit; lost state never manufactures fills.
use crate::{
    book::{Book, Side as BookSide},
    decimal::Fixed,
    ledger::{ExecutionSource, Fill, Ledger, Order, Side, Submit},
    source_clock::{self, SourceClock},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, VecDeque};
type Result<T> = std::result::Result<T, String>;
const MAX_QUEUED: usize = 10000;
const MAX_SEEN: usize = 65536;
const MAX_AGE: u128 = 2_000_000_000;
const FUTURE_SKEW: u128 = 250_000_000;
pub use crate::clock::now_ns;

fn digest(value: &impl Serialize) -> Result<String> {
    Ok(
        Sha256::digest(serde_json::to_vec(value).map_err(|_| "ENCODING_ERROR")?)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    )
}
fn numeric(value: &str) -> Result<u128> {
    if value.is_empty() || value.len() > 39 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err("INVALID_EVENT_TIME".into());
    }
    value.parse().map_err(|_| "INVALID_EVENT_TIME".into())
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Trade {
    pub instrument: String,
    pub epoch: String,
    pub sequence: String,
    pub event_id: String,
    pub venue: String,
    pub time_ns: String,
    pub maker_side: BookSide,
    pub price: Fixed,
    pub quantity: Fixed,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_time_ns: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_clock: Option<SourceClock>,
}
#[derive(Clone)]
struct Queued {
    id: String,
    remaining: Fixed,
    ahead: Fixed,
    activate_at: u128,
    active: bool,
}
#[derive(Default)]
struct Market {
    epoch: String,
    sequence: Option<u64>,
    time: Option<u128>,
    levels: BTreeMap<(BookSide, Fixed), VecDeque<Queued>>,
}
pub struct Ticket {
    instrument: String,
    key: (BookSide, Fixed),
    epoch: String,
    entry: Queued,
}
#[derive(Default)]
pub struct Matcher {
    markets: BTreeMap<String, Market>,
    index: BTreeMap<String, (String, BookSide, Fixed)>,
    seen: BTreeMap<String, String>,
    expiry: VecDeque<(u128, String)>,
    queued: usize,
}
#[derive(Serialize, Default)]
pub struct Matched {
    pub duplicate: bool,
    pub filled_orders: usize,
    pub quantity: Fixed,
    pub inactive_orders: usize,
}
impl Matcher {
    pub fn prepare(
        &self,
        request: &Submit,
        book: &Book,
        now: u128,
        latency_ms: u64,
    ) -> Result<Ticket> {
        if self.queued >= MAX_QUEUED {
            return Err("MATCHING_ORDER_LIMIT".into());
        }
        if latency_ms > 10000 {
            return Err("LATENCY_RANGE".into());
        }
        if !book.eligible(1000) {
            return Err("FRESH_BOOK_REQUIRED".into());
        }
        let side = if request.side == Side::Buy {
            BookSide::Bid
        } else {
            BookSide::Ask
        };
        if !book.price_known(side, request.price) {
            return Err("PRICE_OUTSIDE_KNOWN_DEPTH".into());
        }
        let crossing = if side == BookSide::Bid {
            book.asks
                .first_key_value()
                .is_some_and(|(price, _)| request.price >= *price)
        } else {
            book.bids
                .last_key_value()
                .is_some_and(|(price, _)| request.price <= *price)
        };
        if crossing {
            return Err(if request.post_only {
                "POST_ONLY_WOULD_CROSS"
            } else {
                "PAPER_TAKER_MODEL_UNAVAILABLE"
            }
            .into());
        }
        let key = (side, request.price);
        let mut activation = now
            .checked_add(u128::from(latency_ms) * 1_000_000)
            .ok_or("TIME_OVERFLOW")?;
        let mut ahead = if side == BookSide::Bid {
            book.bids.get(&request.price)
        } else {
            book.asks.get(&request.price)
        }
        .copied()
        .unwrap_or_default();
        if let Some(market) = self.markets.get(&request.instrument) {
            if market.epoch != book.epoch {
                return Err("MATCHER_EPOCH_MISMATCH".into());
            }
            if let Some(level) = market.levels.get(&key) {
                if let Some(last) = level.back() {
                    activation = activation.max(last.activate_at);
                }
                for row in level {
                    ahead = ahead.checked_add(row.remaining)?;
                }
            }
        }
        Ok(Ticket {
            instrument: request.instrument.clone(),
            key,
            epoch: book.epoch.clone(),
            entry: Queued {
                id: request.id.clone(),
                remaining: request.quantity,
                ahead,
                activate_at: activation,
                active: false,
            },
        })
    }
    pub fn attach(&mut self, ticket: Ticket) {
        let market = self.markets.entry(ticket.instrument.clone()).or_default();
        market.epoch = ticket.epoch;
        self.index.insert(
            ticket.entry.id.clone(),
            (ticket.instrument, ticket.key.0, ticket.key.1),
        );
        market
            .levels
            .entry(ticket.key)
            .or_default()
            .push_back(ticket.entry);
        self.queued += 1;
    }
    pub fn detach(&mut self, instrument: &str) {
        if let Some(market) = self.markets.remove(instrument) {
            for rows in market.levels.into_values() {
                for row in rows {
                    self.index.remove(&row.id);
                    self.queued -= 1;
                }
            }
        }
    }
    pub fn detach_all(&mut self) {
        self.markets.clear();
        self.index.clear();
        self.queued = 0;
    }
    pub fn cancelled(&mut self, id: &str) {
        let Some((instrument, side, price)) = self.index.remove(id) else {
            return;
        };
        if let Some(level) = self
            .markets
            .get_mut(&instrument)
            .and_then(|m| m.levels.get_mut(&(side, price)))
            && let Some(index) = level.iter().position(|row| row.id == id)
        {
            let removed = level.remove(index).expect("index exists");
            self.queued -= 1;
            for later in level.iter_mut().skip(index) {
                later.ahead = Fixed((later.ahead.0 - removed.remaining.0).max(0));
            }
        }
        if let Some(market) = self.markets.get_mut(&instrument)
            && market
                .levels
                .get(&(side, price))
                .is_some_and(VecDeque::is_empty)
        {
            market.levels.remove(&(side, price));
        }
    }
    pub fn observe(&mut self, instrument: &str, book: &Book) -> Result<()> {
        if let Some(market) = self.markets.get_mut(instrument) {
            for ((side, price), rows) in &mut market.levels {
                let mut ahead = if *side == BookSide::Bid {
                    book.bids.get(price)
                } else {
                    book.asks.get(price)
                }
                .copied()
                .unwrap_or_default();
                for row in rows {
                    if !row.active {
                        row.ahead = row.ahead.max(ahead);
                    }
                    ahead = ahead.checked_add(row.remaining)?;
                }
            }
        }
        Ok(())
    }
    pub fn runtime(&self, order: &Order) -> serde_json::Value {
        let row = self
            .index
            .get(&order.request.id)
            .and_then(|(instrument, side, price)| {
                self.markets
                    .get(instrument)?
                    .levels
                    .get(&(*side, *price))?
                    .iter()
                    .find(|row| row.id == order.request.id)
            });
        serde_json::json!({"attached":row.is_some(),"held":order.is_open()&&row.is_none(),"ahead":row.map(|r|r.ahead),"activationTimeNs":row.map(|r|r.activate_at.to_string())})
    }
    pub fn trade(
        &mut self,
        ledger: &mut Ledger,
        book: &Book,
        trade: Trade,
        now: u128,
    ) -> Result<Matched> {
        if !book.eligible(1000) || book.epoch != trade.epoch {
            return Err("FRESH_BOOK_REQUIRED".into());
        }
        if trade.event_id.is_empty()
            || trade.event_id.len() > 128
            || trade.venue.len() > 80
            || trade.epoch.len() > 128
        {
            return Err("TRADE_ID_LIMIT".into());
        }
        trade.price.positive()?;
        trade.quantity.positive()?;
        let time = numeric(&trade.time_ns)?;
        source_clock::validate(
            time,
            trade.provider_time_ns.as_deref(),
            trade.source_clock.as_ref(),
            now,
        )
        .map_err(str::to_owned)?;
        let identity_time = trade.provider_time_ns.as_ref().unwrap_or(&trade.time_ns);
        let ordered_time = numeric(identity_time)?;
        if time > now.saturating_add(FUTURE_SKEW) || now.saturating_sub(time) > MAX_AGE {
            return Err("TRADE_CLOCK_OR_AGE".into());
        }
        if trade.sequence.is_empty()
            || trade.sequence.len() > 20
            || !trade.sequence.bytes().all(|b| b.is_ascii_digit())
        {
            return Err("INVALID_SEQUENCE".into());
        }
        let sequence = trade
            .sequence
            .parse::<u64>()
            .map_err(|_| "INVALID_SEQUENCE")?;
        let key = digest(&(&trade.instrument, &trade.epoch, &trade.event_id))?;
        let meaning = digest(&(
            &trade.instrument,
            &trade.epoch,
            &trade.event_id,
            &trade.venue,
            identity_time,
            trade.maker_side,
            trade.price,
            trade.quantity,
        ))?;
        let market = self.markets.entry(trade.instrument.clone()).or_default();
        if market.epoch.is_empty() {
            market.epoch = trade.epoch.clone();
        }
        if market.epoch != trade.epoch {
            return Err("MATCHER_EPOCH_MISMATCH".into());
        }
        if let Some(previous) = market.sequence {
            if sequence <= previous {
                if self.seen.get(&key) == Some(&meaning) {
                    return Ok(Matched {
                        duplicate: true,
                        ..Default::default()
                    });
                }
                return Err("TRADE_SEQUENCE_CONFLICT".into());
            }
            if previous.checked_add(1) != Some(sequence) {
                return Err("TRADE_SEQUENCE_GAP".into());
            }
        }
        if let Some(previous) = self.seen.get(&key) {
            if *previous != meaning {
                return Err("TRADE_EVENT_CONFLICT".into());
            }
            market.sequence = Some(sequence);
            return Ok(Matched {
                duplicate: true,
                ..Default::default()
            });
        }
        if market.time.is_some_and(|previous| ordered_time < previous) {
            return Err("TRADE_TIME_REGRESSED".into());
        }
        while self
            .expiry
            .front()
            .is_some_and(|(at, _)| now.saturating_sub(*at) > 4_000_000_000)
        {
            let (_, expired) = self.expiry.pop_front().expect("front exists");
            self.seen.remove(&expired);
        }
        if self.seen.len() >= MAX_SEEN {
            return Err("TRADE_BUFFER_LIMIT".into());
        }
        let price_key = (trade.maker_side, trade.price);
        let rows = market.levels.get(&price_key).cloned().unwrap_or_default();
        let mut updated = VecDeque::new();
        let mut executions = Vec::new();
        let mut completed = Vec::new();
        let mut result = Matched::default();
        for mut row in rows {
            let order = ledger.order(&row.id).ok_or("ORDER_NOT_FOUND")?;
            if !order.is_open() || order.remaining()? != row.remaining {
                return Err("MATCHER_LEDGER_DIVERGED".into());
            }
            if time <= row.activate_at {
                result.inactive_orders += 1;
                updated.push_back(row);
                continue;
            }
            row.active = true;
            let available = Fixed((trade.quantity.0 - row.ahead.0).max(0));
            let quantity = available.min(row.remaining);
            row.ahead = Fixed((row.ahead.0 - trade.quantity.0).max(0));
            if quantity.0 > 0 {
                executions.push(Fill {
                    id: digest(&(&trade.instrument, &trade.epoch, &trade.event_id, &row.id))?,
                    order: row.id.clone(),
                    price: trade.price,
                    quantity,
                    source: Some(ExecutionSource {
                        venue: trade.venue.clone(),
                        event_id: trade.event_id.clone(),
                        epoch: trade.epoch.clone(),
                        sequence: trade.sequence.clone(),
                        time_ns: trade.time_ns.clone(),
                        provider_time_ns: trade.provider_time_ns.clone(),
                        source_clock: trade.source_clock.clone(),
                    }),
                });
                row.remaining = row.remaining.checked_sub(quantity)?;
                result.quantity = result.quantity.checked_add(quantity)?;
                result.filled_orders += 1;
            }
            if row.remaining.0 > 0 {
                updated.push_back(row);
            } else {
                completed.push(row.id);
            }
        }
        if result.quantity > trade.quantity {
            return Err("MATCHING_VOLUME_INVARIANT".into());
        }
        if !executions.is_empty() {
            ledger.fill_batch(executions)?;
        }
        if updated.is_empty() {
            market.levels.remove(&price_key);
        } else {
            market.levels.insert(price_key, updated);
        }
        market.sequence = Some(sequence);
        market.time = Some(ordered_time);
        for id in completed {
            self.index.remove(&id);
            self.queued -= 1;
        }
        self.seen.insert(key.clone(), meaning);
        self.expiry.push_back((now, key));
        Ok(result)
    }
}
