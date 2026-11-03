//! Durable PAPER order ledger. No network, signer, keys, or real-money authority.
//! Strategies share one balance/reservation authority per account and asset.
//! Matching is deliberately separate: only the native matcher may supply fills.
pub mod execution;
mod safety;
mod strategies;
use crate::{
    book::Book,
    decimal::{Fixed, SCALE},
    journal::Journal,
};
use ethnum::U256;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};
fn utc_ns() -> String {
    crate::clock::now_ns().to_string()
}

type Result<T> = std::result::Result<T, String>;
fn check(ok: bool, code: &str) -> Result<()> {
    if ok { Ok(()) } else { Err(code.into()) }
}
pub(crate) fn id(value: &str) -> Result<()> {
    check(
        !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_:-.".contains(&b)),
        "INVALID_ID",
    )
}
fn fingerprint(value: &impl Serialize) -> Result<String> {
    Ok(
        Sha256::digest(serde_json::to_vec(value).map_err(|_| "ENCODING_ERROR")?)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    )
}
fn integer(value: U256) -> Result<Fixed> {
    Ok(Fixed(
        i128::try_from(u128::try_from(value).map_err(|_| "AMOUNT_OVERFLOW")?)
            .map_err(|_| "AMOUNT_OVERFLOW")?,
    ))
}
fn raw_notional(price: Fixed, quantity: Fixed) -> U256 {
    U256::from(price.0 as u128) * U256::from(quantity.0 as u128)
}
fn rounded(raw: U256, ceil: bool) -> Result<Fixed> {
    let scale = U256::from(SCALE as u128);
    integer(
        raw / scale
            + if ceil && raw % scale != U256::ZERO {
                U256::ONE
            } else {
                U256::ZERO
            },
    )
}
pub(crate) fn fee(notional: Fixed, bps: u16) -> Result<Fixed> {
    let numerator = U256::from(notional.0 as u128) * U256::from(bps);
    integer(
        numerator / U256::from(10000u32)
            + if numerator % U256::from(10000u32) != U256::ZERO {
                U256::ONE
            } else {
                U256::ZERO
            },
    )
}

#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Instrument {
    pub id: String,
    pub base: String,
    pub quote: String,
    pub tick: Fixed,
    pub lot: Fixed,
    pub min_notional: Fixed,
    pub fee_bps: u16,
}
impl Instrument {
    fn validate(&self) -> Result<()> {
        id(&self.id)?;
        id(&self.base)?;
        id(&self.quote)?;
        check(
            self.base != self.quote
                && self.tick.0 > 0
                && self.lot.0 > 0
                && self.min_notional.0 > 0
                && self.fee_bps <= 10000,
            "INVALID_INSTRUMENT",
        )
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Risk {
    pub max_open_orders: u32,
    pub max_order_notional: BTreeMap<String, Fixed>,
    pub max_asset_position: BTreeMap<String, Fixed>,
}
impl Risk {
    fn validate(&self) -> Result<()> {
        check(
            self.max_open_orders > 0
                && self.max_open_orders <= 10000
                && self.max_order_notional.len() <= 1000
                && self.max_asset_position.len() <= 1000,
            "INVALID_RISK",
        )?;
        for (asset, amount) in self
            .max_order_notional
            .iter()
            .chain(self.max_asset_position.iter())
        {
            id(asset)?;
            amount.positive()?;
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Balance {
    pub total: Fixed,
    pub reserved: Fixed,
}
impl Balance {
    pub fn available(&self) -> Result<Fixed> {
        self.total.checked_sub(self.reserved).map_err(Into::into)
    }
    fn validate(&self) -> Result<()> {
        check(
            self.reserved.0 >= 0 && self.total >= self.reserved,
            "BALANCE_INVARIANT",
        )
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Buy,
    Sell,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    Open,
    PartiallyFilled,
    Filled,
    Cancelled,
}
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Submit {
    pub id: String,
    pub account: String,
    pub strategy: String,
    pub instrument: String,
    pub side: Side,
    pub price: Fixed,
    pub quantity: Fixed,
    pub post_only: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Fill {
    pub id: String,
    pub order: String,
    pub price: Fixed,
    pub quantity: Fixed,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<ExecutionSource>,
}
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ExecutionSource {
    pub venue: String,
    pub event_id: String,
    pub epoch: String,
    pub sequence: String,
    pub time_ns: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_time_ns: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_clock: Option<crate::source_clock::SourceClock>,
}
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Order {
    pub request: Submit,
    pub version: u64,
    pub status: Status,
    pub filled: Fixed,
    pub notional: Fixed,
    pub fees: Fixed,
    pub reserved: Fixed,
    pub reserved_asset: String,
    pub market_epoch: String,
    pub market_sequence: u64,
    #[serde(default)]
    pub created_at_ns: String,
    #[serde(default)]
    pub updated_at_ns: String,
    #[serde(default)]
    pub last_execution: Option<Fill>,
    // Cumulative exact price*quantity in 36-place units. Round once, not once per
    // partial fill, so micro-fills cannot consume more than a reserved limit.
    exact_notional: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct Execution {
    pub fill: Fill,
    pub account: String,
    pub strategy: String,
    pub instrument: String,
    pub side: Side,
    pub recorded_at_ns: String,
    pub fees: Fixed,
    pub notional: Fixed,
}
impl Order {
    pub fn is_open(&self) -> bool {
        matches!(self.status, Status::Open | Status::PartiallyFilled)
    }
    pub fn remaining(&self) -> Result<Fixed> {
        Ok(self.request.quantity.checked_sub(self.filled)?)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    id: String,
    digest: String,
    order: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BalanceChange {
    account: String,
    asset: String,
    value: Balance,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PendingChange {
    account: String,
    asset: String,
    value: Fixed,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
enum Event {
    Execution {
        value: execution::Change,
    },
    Halt {
        account: String,
        operation: String,
        time: String,
    },
    ResetHalt {
        account: String,
        expected: String,
    },
    Strategy {
        value: strategies::Change,
    },
    Batch {
        events: Vec<Event>,
    },
    Instrument {
        value: Instrument,
    },
    Account {
        id: String,
        #[serde(default)]
        name: String,
        risk: Risk,
        balances: Vec<BalanceChange>,
    },
    Risk {
        account: String,
        value: Risk,
    },
    Orders {
        orders: Vec<Order>,
        balances: Vec<BalanceChange>,
        pending: Vec<PendingChange>,
        counts: Vec<(String, u32)>,
        receipt: Option<Receipt>,
    },
}
#[derive(Default)]
struct State {
    executions_outbox: execution::Store,
    halts: BTreeMap<String, safety::Halt>,
    halt_receipts: BTreeMap<(String, String), bool>,
    strategies: strategies::Store,
    instruments: BTreeMap<String, Instrument>,
    risk: BTreeMap<String, Risk>,
    balances: BTreeMap<(String, String), Balance>,
    pending: BTreeMap<(String, String), Fixed>,
    counts: BTreeMap<String, u32>,
    orders: BTreeMap<String, Order>,
    open_by_account: BTreeMap<String, BTreeSet<String>>,
    receipts: BTreeMap<String, Receipt>,
    names: BTreeMap<String, String>,
    account_definitions: BTreeMap<String, String>,
    executions: BTreeMap<(u128, String), Execution>,
    order_timeline: BTreeMap<u64, String>,
    order_sequence: u64,
}
impl State {
    fn apply(&mut self, event: Event) -> Result<()> {
        match event {
            Event::Execution { value } => self.executions_outbox.apply(value)?,
            Event::Halt {
                account,
                operation,
                time,
            } => self.apply_halt(account, operation, time)?,
            Event::ResetHalt { account, expected } => {
                check(
                    self.halts.get(&account).is_some_and(|h| h.id == expected),
                    "HALT_CHANGED",
                )?;
                self.halts.remove(&account);
                self.halt_receipts.insert((account, expected), true);
            }
            Event::Strategy { value } => self.strategies.apply(value)?,
            Event::Batch { events } => {
                check(
                    !events.is_empty()
                        && events.len() <= 10000
                        && events
                            .iter()
                            .all(|event| matches!(event, Event::Orders { .. })),
                    "BATCH_SCHEMA",
                )?;
                for event in events {
                    self.apply(event)?;
                }
            }
            Event::Instrument { value } => {
                value.validate()?;
                check(
                    !self.instruments.contains_key(&value.id),
                    "INSTRUMENT_EXISTS",
                )?;
                self.instruments.insert(value.id.clone(), value);
            }
            Event::Account {
                id,
                name,
                risk,
                balances,
            } => {
                check(!self.risk.contains_key(&id), "ACCOUNT_EXISTS")?;
                risk.validate()?;
                let totals = balances
                    .iter()
                    .map(|b| (b.asset.clone(), b.value.total))
                    .collect::<BTreeMap<_, _>>();
                self.account_definitions
                    .insert(id.clone(), fingerprint(&(&name, &risk, &totals))?);
                self.names.insert(id.clone(), name);
                for change in balances {
                    change.value.validate()?;
                    self.balances
                        .insert((change.account, change.asset), change.value);
                }
                self.risk.insert(id, risk);
            }
            Event::Risk { account, value } => {
                check(self.risk.contains_key(&account), "ACCOUNT_NOT_FOUND")?;
                value.validate()?;
                self.risk.insert(account, value);
            }
            Event::Orders {
                orders,
                balances,
                pending,
                counts,
                receipt,
            } => {
                for order in &orders {
                    let previous = self.orders.get(&order.request.id);
                    check(
                        order.version == previous.map_or(1, |o| o.version.saturating_add(1))
                            && previous.is_none_or(Order::is_open),
                        "ORDER_VERSION_INVARIANT",
                    )?;
                    check(
                        order.filled.0 >= 0
                            && order.filled <= order.request.quantity
                            && order.reserved.0 >= 0,
                        "ORDER_QUANTITY_INVARIANT",
                    )?;
                }
                for change in &balances {
                    change.value.validate()?;
                }
                for change in &pending {
                    check(change.value.0 >= 0, "PENDING_POSITION_INVARIANT")?;
                }
                if let Some(ref receipt) = receipt {
                    check(!self.receipts.contains_key(&receipt.id), "RECEIPT_EXISTS")?;
                }
                for order in orders {
                    let open = self
                        .open_by_account
                        .entry(order.request.account.clone())
                        .or_default();
                    if order.is_open() {
                        open.insert(order.request.id.clone());
                    } else {
                        open.remove(&order.request.id);
                    }
                    self.strategies.order_update(
                        self.orders.get(&order.request.id),
                        &order,
                        &self.instruments,
                    )?;
                    if !self.orders.contains_key(&order.request.id) {
                        self.order_sequence = self
                            .order_sequence
                            .checked_add(1)
                            .ok_or("ORDER_SEQUENCE_LIMIT")?;
                        self.order_timeline
                            .insert(self.order_sequence, order.request.id.clone());
                    }
                    if receipt
                        .as_ref()
                        .is_some_and(|r| r.id.starts_with("fill:") && r.order == order.request.id)
                        && let Some(fill) = order.last_execution.as_ref()
                    {
                        self.executions.insert(
                            (order.updated_at_ns.parse().unwrap_or(0), fill.id.clone()),
                            Execution {
                                fees: order.fees.checked_sub(
                                    self.orders
                                        .get(&order.request.id)
                                        .map_or(Fixed(0), |o| o.fees),
                                )?,
                                notional: order.notional.checked_sub(
                                    self.orders
                                        .get(&order.request.id)
                                        .map_or(Fixed(0), |o| o.notional),
                                )?,
                                fill: fill.clone(),
                                account: order.request.account.clone(),
                                strategy: order.request.strategy.clone(),
                                instrument: order.request.instrument.clone(),
                                side: order.request.side,
                                recorded_at_ns: order.updated_at_ns.clone(),
                            },
                        );
                    }
                    self.orders.insert(order.request.id.clone(), order);
                }
                for change in balances {
                    self.balances
                        .insert((change.account, change.asset), change.value);
                }
                for change in pending {
                    self.pending
                        .insert((change.account, change.asset), change.value);
                }
                for (account, count) in counts {
                    self.counts.insert(account, count);
                }
                if let Some(receipt) = receipt {
                    self.receipts.insert(receipt.id.clone(), receipt);
                }
            }
        }
        Ok(())
    }
    fn balance(&self, account: &str, asset: &str) -> Balance {
        self.balances
            .get(&(account.into(), asset.into()))
            .cloned()
            .unwrap_or_default()
    }
    fn pending(&self, account: &str, asset: &str) -> Fixed {
        *self
            .pending
            .get(&(account.into(), asset.into()))
            .unwrap_or(&Fixed(0))
    }
}
pub struct Ledger {
    state: State,
    journal: Journal,
    enabled: bool,
    faulted: bool,
    staging: Option<Vec<Event>>,
    active_accounts: BTreeSet<String>,
}
#[derive(Serialize)]
pub struct Outcome {
    pub duplicate: bool,
    pub order: Order,
}
impl Ledger {
    pub fn open(directory: &Path, quota: u64) -> Result<Self> {
        let mut state = State::default();
        let journal = Journal::open(directory, quota, |value| {
            let event: Event = serde_json::from_value(value).map_err(std::io::Error::other)?;
            state.apply(event).map_err(std::io::Error::other)
        })
        .map_err(|e| format!("LEDGER_OPEN: {e}"))?;
        // Recovery preserves reservations and history, never starts strategies or
        // invents offline fills. The controller must reconcile/rebuild its queues.
        Ok(Self {
            state,
            journal,
            enabled: false,
            faulted: false,
            staging: None,
            active_accounts: BTreeSet::new(),
        })
    }
    fn commit(&mut self, event: Event) -> Result<()> {
        check(!self.faulted, "LEDGER_RESTART_REQUIRED")?;
        if let Some(events) = self.staging.as_mut() {
            self.state.apply(event.clone())?;
            events.push(event);
            return Ok(());
        }
        if let Err(error) = self.journal.append(&event) {
            self.faulted = true;
            self.enabled = false;
            return Err(format!("DURABLE_COMMIT: {error}"));
        }
        if let Err(error) = self.state.apply(event) {
            self.faulted = true;
            self.enabled = false;
            return Err(error);
        }
        Ok(())
    }
    pub fn instrument(&mut self, value: Instrument) -> Result<()> {
        value.validate()?;
        if let Some(previous) = self.state.instruments.get(&value.id) {
            return check(previous == &value, "INSTRUMENT_CONFLICT");
        }
        self.commit(Event::Instrument { value })
    }
    pub fn account(
        &mut self,
        account: String,
        risk: Risk,
        assets: BTreeMap<String, Fixed>,
    ) -> Result<()> {
        self.account_named(account, String::new(), risk, assets)
    }
    pub fn account_named(
        &mut self,
        account: String,
        name: String,
        risk: Risk,
        assets: BTreeMap<String, Fixed>,
    ) -> Result<()> {
        id(&account)?;
        risk.validate()?;
        check(
            name.chars().count() <= 80 && !name.chars().any(char::is_control),
            "INVALID_ACCOUNT_NAME",
        )?;
        let digest = fingerprint(&(&name, &risk, &assets))?;
        if let Some(previous) = self.state.account_definitions.get(&account) {
            return check(previous == &digest, "ACCOUNT_CONFLICT");
        }
        check(self.state.risk.len() < 1000, "ACCOUNT_LIMIT")?;
        check(assets.len() <= 1000, "ASSET_LIMIT")?;
        let mut balances = Vec::new();
        for (asset, total) in assets {
            id(&asset)?;
            check(total.0 >= 0, "NEGATIVE_BALANCE")?;
            balances.push(BalanceChange {
                account: account.clone(),
                asset,
                value: Balance {
                    total,
                    reserved: Fixed(0),
                },
            });
        }
        self.commit(Event::Account {
            id: account,
            name,
            risk,
            balances,
        })
    }
    pub fn risk(&mut self, account: String, value: Risk) -> Result<()> {
        check(self.state.risk.contains_key(&account), "ACCOUNT_NOT_FOUND")?;
        value.validate()?;
        check(
            self.state.counts.get(&account).copied().unwrap_or(0) == 0,
            "ACCOUNT_HAS_OPEN_ORDERS",
        )?;
        self.commit(Event::Risk { account, value })
    }
    pub fn enable(&mut self) -> Result<()> {
        check(!self.faulted, "LEDGER_RESTART_REQUIRED")?;
        self.enabled = true;
        self.active_accounts = self
            .state
            .risk
            .keys()
            .filter(|id| !self.state.halts.contains_key(*id))
            .cloned()
            .collect();
        Ok(())
    }
    pub fn activate_account(&mut self, id: &str, active: bool) -> Result<()> {
        check(self.state.risk.contains_key(id), "ACCOUNT_NOT_FOUND")?;
        if active {
            check(!self.account_halted(id), "ACCOUNT_HALTED")?;
            check(!self.faulted, "LEDGER_RESTART_REQUIRED")?;
            self.enabled = true;
            self.active_accounts.insert(id.to_string());
        } else {
            self.active_accounts.remove(id);
        }
        Ok(())
    }
    pub fn pause(&mut self) {
        self.enabled = false;
        self.active_accounts.clear();
    }
    pub fn enabled(&self) -> bool {
        self.enabled && !self.faulted
    }
    pub fn faulted(&self) -> bool {
        self.faulted
    }
    pub fn balance(&self, account: &str, asset: &str) -> Balance {
        self.state.balance(account, asset)
    }
    pub fn order(&self, order: &str) -> Option<&Order> {
        self.state.orders.get(order)
    }
    pub fn orders(&self) -> impl Iterator<Item = &Order> {
        self.state
            .order_timeline
            .values()
            .rev()
            .filter_map(|id| self.state.orders.get(id))
    }
    pub fn account_ids(&self) -> impl Iterator<Item = &String> {
        self.state.risk.keys()
    }
    pub fn open_account_orders(&self, account: &str) -> impl Iterator<Item = &Order> {
        self.state
            .open_by_account
            .get(account)
            .into_iter()
            .flatten()
            .filter_map(|id| self.state.orders.get(id))
    }
    pub fn executions(&self) -> impl Iterator<Item = &Execution> {
        self.state.executions.values().rev()
    }
    pub fn instrument_value(&self, id: &str) -> Option<&Instrument> {
        self.state.instruments.get(id)
    }
    pub fn summary(&self) -> serde_json::Value {
        serde_json::json!({"enabled":self.enabled(),"faulted":self.faulted,"accounts":self.state.risk.len(),"instruments":self.state.instruments.len(),"orders":self.state.orders.len(),"openOrders":self.state.counts.values().map(|v|u64::from(*v)).sum::<u64>()})
    }
    pub fn account_view(&self, id: &str) -> Result<serde_json::Value> {
        let risk = self.state.risk.get(id).ok_or("ACCOUNT_NOT_FOUND")?;
        let assets = self
            .state
            .balances
            .iter()
            .filter(|((account, _), _)| account == id)
            .map(|((_, asset), value)|Ok((asset,serde_json::json!({"total":value.total,"reserved":value.reserved,"available":value.available()?}))))
            .collect::<Result<BTreeMap<_, _>>>()?;
        Ok(
            serde_json::json!({"id":id,"name":self.state.names.get(id).filter(|n|!n.is_empty()).map_or(id,String::as_str),"active":self.account_active(id),"halt":self.state.halts.get(id),"risk":risk,"assets":assets,"openOrders":self.state.counts.get(id).copied().unwrap_or(0)}),
        )
    }
    fn duplicate(&self, key: &str, digest: &str) -> Result<Option<Outcome>> {
        if let Some(receipt) = self.state.receipts.get(key) {
            check(receipt.digest == digest, "COMMAND_CONFLICT")?;
            return Ok(Some(Outcome {
                duplicate: true,
                order: self
                    .state
                    .orders
                    .get(&receipt.order)
                    .ok_or("ORDER_NOT_FOUND")?
                    .clone(),
            }));
        }
        Ok(None)
    }
    pub fn submit(
        &mut self,
        request: Submit,
        market_instrument: &str,
        book: &Book,
        stale_ms: u64,
    ) -> Result<Outcome> {
        for value in [
            &request.id,
            &request.account,
            &request.strategy,
            &request.instrument,
        ] {
            id(value)?;
        }
        let (key, digest) = (format!("submit:{}", request.id), fingerprint(&request)?);
        if let Some(result) = self.duplicate(&key, &digest)? {
            return Ok(result);
        }
        self.state.strategies.validate_order(&request)?;
        check(!self.account_halted(&request.account), "ACCOUNT_HALTED")?;
        check(self.enabled(), "LEDGER_PAUSED")?;
        check(
            self.active_accounts.contains(&request.account),
            "ACCOUNT_PAUSED",
        )?;
        check(
            request.instrument == market_instrument,
            "BOOK_INSTRUMENT_MISMATCH",
        )?;
        check(
            stale_ms > 0 && stale_ms <= 30000 && book.eligible(stale_ms),
            "FRESH_BOOK_REQUIRED",
        )?;
        let instrument = self
            .state
            .instruments
            .get(&request.instrument)
            .ok_or("INSTRUMENT_NOT_FOUND")?;
        let risk = self
            .state
            .risk
            .get(&request.account)
            .ok_or("ACCOUNT_NOT_FOUND")?;
        request.price.positive()?;
        request.quantity.positive()?;
        check(
            request.price.multiple_of(instrument.tick)
                && request.quantity.multiple_of(instrument.lot),
            "TICK_OR_LOT_MISMATCH",
        )?;
        let notional = request.price.multiply(request.quantity, true)?;
        check(notional >= instrument.min_notional, "MINIMUM_NOTIONAL")?;
        check(
            notional
                <= *risk
                    .max_order_notional
                    .get(&instrument.quote)
                    .ok_or("QUOTE_LIMIT_REQUIRED")?,
            "MAX_ORDER_NOTIONAL",
        )?;
        let count = self
            .state
            .counts
            .get(&request.account)
            .copied()
            .unwrap_or(0);
        check(count < risk.max_open_orders, "MAX_OPEN_ORDERS")?;
        if request.post_only {
            let crossing = match request.side {
                Side::Buy => book
                    .asks
                    .first_key_value()
                    .is_some_and(|(p, _)| request.price >= *p),
                Side::Sell => book
                    .bids
                    .last_key_value()
                    .is_some_and(|(p, _)| request.price <= *p),
            };
            check(!crossing, "POST_ONLY_WOULD_CROSS")?;
        }
        let mut pending = Vec::new();
        let (reserved_asset, reserved) = match request.side {
            Side::Buy => {
                let remaining = self
                    .state
                    .pending(&request.account, &instrument.base)
                    .checked_add(request.quantity)?;
                let position = self
                    .state
                    .balance(&request.account, &instrument.base)
                    .total
                    .checked_add(remaining)?;
                check(
                    position
                        <= *risk
                            .max_asset_position
                            .get(&instrument.base)
                            .ok_or("POSITION_LIMIT_REQUIRED")?,
                    "MAX_ASSET_POSITION",
                )?;
                pending.push(PendingChange {
                    account: request.account.clone(),
                    asset: instrument.base.clone(),
                    value: remaining,
                });
                (
                    instrument.quote.clone(),
                    notional.checked_add(fee(notional, instrument.fee_bps)?)?,
                )
            }
            Side::Sell => (instrument.base.clone(), request.quantity),
        };
        let mut balance = self.state.balance(&request.account, &reserved_asset);
        check(
            balance.available()? >= reserved,
            "INSUFFICIENT_AVAILABLE_BALANCE",
        )?;
        balance.reserved = balance.reserved.checked_add(reserved)?;
        let order = Order {
            request,
            version: 1,
            status: Status::Open,
            filled: Fixed(0),
            notional: Fixed(0),
            fees: Fixed(0),
            reserved,
            reserved_asset: reserved_asset.clone(),
            market_epoch: book.epoch.clone(),
            market_sequence: book.sequence,
            created_at_ns: utc_ns(),
            updated_at_ns: utc_ns(),
            last_execution: None,
            exact_notional: "0".into(),
        };
        self.commit(Event::Orders {
            balances: vec![BalanceChange {
                account: order.request.account.clone(),
                asset: reserved_asset,
                value: balance,
            }],
            orders: vec![order.clone()],
            pending,
            counts: vec![(order.request.account.clone(), count + 1)],
            receipt: Some(Receipt {
                id: key,
                digest,
                order: order.request.id.clone(),
            }),
        })?;
        Ok(Outcome {
            duplicate: false,
            order,
        })
    }
    /// Internal PAPER settlement. A matcher supplies independently deduplicated
    /// executions; this does not imply that an exchange or chain filled anything.
    pub fn fill(&mut self, execution: Fill) -> Result<Outcome> {
        id(&execution.id)?;
        id(&execution.order)?;
        let (key, digest) = (format!("fill:{}", execution.id), fingerprint(&execution)?);
        if let Some(result) = self.duplicate(&key, &digest)? {
            return Ok(result);
        }
        check(!self.faulted, "LEDGER_RESTART_REQUIRED")?;
        let mut order = self
            .state
            .orders
            .get(&execution.order)
            .ok_or("ORDER_NOT_FOUND")?
            .clone();
        check(order.is_open(), "ORDER_CLOSED")?;
        execution.quantity.positive()?;
        execution.price.positive()?;
        let instrument = self
            .state
            .instruments
            .get(&order.request.instrument)
            .ok_or("INSTRUMENT_NOT_FOUND")?;
        check(
            execution.price.multiple_of(instrument.tick),
            "FILL_PRICE_TICK_MISMATCH",
        )?;
        let remaining = order.remaining()?;
        check(execution.quantity <= remaining, "FILL_EXCEEDS_REMAINING")?;
        check(
            match order.request.side {
                Side::Buy => execution.price <= order.request.price,
                Side::Sell => execution.price >= order.request.price,
            },
            "LIMIT_PRICE_VIOLATION",
        )?;
        let old_exact = order
            .exact_notional
            .parse::<U256>()
            .map_err(|_| "NOTIONAL_INVARIANT")?;
        let exact = old_exact
            .checked_add(raw_notional(execution.price, execution.quantity))
            .ok_or("AMOUNT_OVERFLOW")?;
        let cumulative = rounded(exact, order.request.side == Side::Buy)?;
        let cumulative_fee = fee(cumulative, instrument.fee_bps)?;
        let (notional_delta, fee_delta) = (
            cumulative.checked_sub(order.notional)?,
            cumulative_fee.checked_sub(order.fees)?,
        );
        let remaining = remaining.checked_sub(execution.quantity)?;
        let new_reserved = match order.request.side {
            Side::Sell => remaining,
            Side::Buy => {
                let max = rounded(
                    exact
                        .checked_add(raw_notional(order.request.price, remaining))
                        .ok_or("AMOUNT_OVERFLOW")?,
                    true,
                )?;
                max.checked_sub(cumulative)?
                    .checked_add(fee(max, instrument.fee_bps)?.checked_sub(cumulative_fee)?)?
            }
        };
        let (mut base, mut quote) = (
            self.state.balance(&order.request.account, &instrument.base),
            self.state
                .balance(&order.request.account, &instrument.quote),
        );
        let mut pending = Vec::new();
        match order.request.side {
            Side::Buy => {
                quote.reserved = quote
                    .reserved
                    .checked_sub(order.reserved)?
                    .checked_add(new_reserved)?;
                quote.total = quote
                    .total
                    .checked_sub(notional_delta.checked_add(fee_delta)?)?;
                base.total = base.total.checked_add(execution.quantity)?;
                pending.push(PendingChange {
                    account: order.request.account.clone(),
                    asset: instrument.base.clone(),
                    value: self
                        .state
                        .pending(&order.request.account, &instrument.base)
                        .checked_sub(execution.quantity)?,
                });
            }
            Side::Sell => {
                base.reserved = base
                    .reserved
                    .checked_sub(order.reserved)?
                    .checked_add(new_reserved)?;
                base.total = base.total.checked_sub(execution.quantity)?;
                quote.total = quote
                    .total
                    .checked_add(notional_delta.checked_sub(fee_delta)?)?;
            }
        }
        base.validate()?;
        quote.validate()?;
        order.filled = order.filled.checked_add(execution.quantity)?;
        order.notional = cumulative;
        order.fees = cumulative_fee;
        order.exact_notional = exact.to_string();
        order.reserved = new_reserved;
        order.updated_at_ns = utc_ns();
        order.last_execution = Some(execution.clone());
        order.version = order.version.checked_add(1).ok_or("VERSION_LIMIT")?;
        order.status = if remaining.0 == 0 {
            Status::Filled
        } else {
            Status::PartiallyFilled
        };
        let mut counts = Vec::new();
        if !order.is_open() {
            let count = self
                .state
                .counts
                .get(&order.request.account)
                .copied()
                .unwrap_or(0)
                .checked_sub(1)
                .ok_or("ORDER_COUNT_INVARIANT")?;
            counts.push((order.request.account.clone(), count));
        }
        self.commit(Event::Orders {
            orders: vec![order.clone()],
            balances: vec![
                BalanceChange {
                    account: order.request.account.clone(),
                    asset: instrument.base.clone(),
                    value: base,
                },
                BalanceChange {
                    account: order.request.account.clone(),
                    asset: instrument.quote.clone(),
                    value: quote,
                },
            ],
            pending,
            counts,
            receipt: Some(Receipt {
                id: key,
                digest,
                order: order.request.id.clone(),
            }),
        })?;
        Ok(Outcome {
            duplicate: false,
            order,
        })
    }
    /// One market event becomes one durable transaction. Copy only the affected
    /// accounts/assets/orders; never clone the entire historical ledger per tick.
    pub fn fill_batch(&mut self, fills: Vec<Fill>) -> Result<Vec<Outcome>> {
        check(
            self.staging.is_none() && !fills.is_empty() && fills.len() <= 10000,
            "FILL_BATCH_LIMIT",
        )?;
        check(!self.faulted, "LEDGER_RESTART_REQUIRED")?;
        let mut overlay = State::default();
        for fill in &fills {
            id(&fill.id)?;
            id(&fill.order)?;
            let order = self
                .state
                .orders
                .get(&fill.order)
                .ok_or("ORDER_NOT_FOUND")?;
            let instrument = self
                .state
                .instruments
                .get(&order.request.instrument)
                .ok_or("INSTRUMENT_NOT_FOUND")?;
            overlay
                .orders
                .insert(order.request.id.clone(), order.clone());
            overlay
                .instruments
                .insert(instrument.id.clone(), instrument.clone());
            for asset in [&instrument.base, &instrument.quote] {
                overlay.balances.insert(
                    (order.request.account.clone(), asset.clone()),
                    self.state.balance(&order.request.account, asset),
                );
            }
            overlay.pending.insert(
                (order.request.account.clone(), instrument.base.clone()),
                self.state.pending(&order.request.account, &instrument.base),
            );
            overlay.counts.insert(
                order.request.account.clone(),
                self.state
                    .counts
                    .get(&order.request.account)
                    .copied()
                    .unwrap_or(0),
            );
            let receipt = format!("fill:{}", fill.id);
            if let Some(previous) = self.state.receipts.get(&receipt) {
                overlay.receipts.insert(receipt, previous.clone());
            }
        }
        let original = std::mem::replace(&mut self.state, overlay);
        self.staging = Some(Vec::new());
        let outcome = fills
            .into_iter()
            .map(|fill| self.fill(fill))
            .collect::<Result<Vec<_>>>();
        let events = self.staging.take();
        self.state = original;
        let events = events.ok_or("STAGING_INVARIANT")?;
        let outcomes = outcome?;
        if !events.is_empty() {
            self.commit(Event::Batch { events })?;
        }
        Ok(outcomes)
    }
    pub fn cancel(&mut self, order_id: &str) -> Result<Order> {
        let mut order = self
            .state
            .orders
            .get(order_id)
            .ok_or("ORDER_NOT_FOUND")?
            .clone();
        if order.status == Status::Cancelled {
            return Ok(order);
        }
        check(order.is_open(), "ORDER_CLOSED")?;
        let instrument = self
            .state
            .instruments
            .get(&order.request.instrument)
            .ok_or("INSTRUMENT_NOT_FOUND")?;
        let mut balance = self
            .state
            .balance(&order.request.account, &order.reserved_asset);
        balance.reserved = balance.reserved.checked_sub(order.reserved)?;
        balance.validate()?;
        let pending = if order.request.side == Side::Buy {
            vec![PendingChange {
                account: order.request.account.clone(),
                asset: instrument.base.clone(),
                value: self
                    .state
                    .pending(&order.request.account, &instrument.base)
                    .checked_sub(order.remaining()?)?,
            }]
        } else {
            vec![]
        };
        let count = self
            .state
            .counts
            .get(&order.request.account)
            .copied()
            .unwrap_or(0)
            .checked_sub(1)
            .ok_or("ORDER_COUNT_INVARIANT")?;
        order.status = Status::Cancelled;
        order.updated_at_ns = utc_ns();
        order.reserved = Fixed(0);
        order.version = order.version.checked_add(1).ok_or("VERSION_LIMIT")?;
        self.commit(Event::Orders {
            balances: vec![BalanceChange {
                account: order.request.account.clone(),
                asset: order.reserved_asset.clone(),
                value: balance,
            }],
            counts: vec![(order.request.account.clone(), count)],
            orders: vec![order.clone()],
            pending,
            receipt: None,
        })?;
        Ok(order)
    }
}
