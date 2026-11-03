//! Single-owner scheduler: deterministic plans on verified books, never an LLM.
use crate::clock;
use crate::{
    book::Book,
    decimal::Fixed,
    ledger::{Ledger, Side, Submit, fee, id},
    matching::{Matcher, now_ns},
    strategy::{Decision, Definition, Mode, Outcome, Phase, Run, Sides},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
type Result<T> = std::result::Result<T, String>;
struct Live {
    run: String,
    definition: Definition,
    opened: Vec<(String, u128)>,
    last_eval: Option<u128>,
    last_plan: Option<u128>,
    last_shadow: Vec<(Side, Fixed)>,
}
#[derive(Default)]
pub struct Runner {
    active: BTreeMap<String, Live>,
    pub generation: u64,
}
fn intent_id(run: &str, ordinal: u64, side: Side) -> String {
    let bytes = Sha256::digest(format!("{run}:{ordinal}:{side:?}").as_bytes());
    "intent:".to_string() + &bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
}
fn sanitize(error: &str) -> String {
    if error.len() <= 80
        && error
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
    {
        error.into()
    } else {
        "STRATEGY_EXECUTION_FAILED".into()
    }
}
impl Runner {
    pub fn hold_all(&mut self, ledger: &mut Ledger, matcher: &mut Matcher, reason: &str) {
        for (_, live) in std::mem::take(&mut self.active) {
            for (id, _) in live.opened {
                matcher.cancelled(&id);
            }
            let _ = ledger.strategy_phase(&live.run, Phase::Paused, reason);
        }
        self.generation = self.generation.saturating_add(1);
    }
    pub fn run_view(&self, ledger: &Ledger, run: &Run) -> Result<Value> {
        let active = self
            .active
            .get(&run.strategy)
            .is_some_and(|v| v.run == run.id);
        let phase = if run.phase == Phase::Running && !active {
            "paused"
        } else if active {
            "running"
        } else {
            match run.phase {
                Phase::Running => "paused",
                Phase::Paused => "paused",
                Phase::Stopped => "stopped",
                Phase::Completed => "completed",
            }
        };
        let definition = ledger
            .strategy(&run.strategy, run.revision)
            .ok_or("STRATEGY_NOT_FOUND")?;
        Ok(
            json!({"run":run,"phase":phase,"reason":if run.phase==Phase::Running&&!active{"RECOVERY_PAUSED"}else{run.reason.as_str()},"owner":definition.owner,"account":definition.account,"instrument":definition.instrument,"stats":ledger.strategy_stats(&run.id)?}),
        )
    }
    pub fn start(
        &mut self,
        ledger: &mut Ledger,
        books: &BTreeMap<String, Book>,
        run_id: String,
        strategy: String,
        revision: u32,
        mode: Mode,
    ) -> Result<Value> {
        id(&run_id)?;
        let definition = ledger
            .strategy(&strategy, revision)
            .ok_or("STRATEGY_NOT_FOUND")?
            .clone();
        if let Some(run) = ledger.strategy_run(&run_id) {
            if run.strategy != strategy || run.revision != definition.revision || run.mode != mode {
                return Err("STRATEGY_RUN_CONFLICT".into());
            }
            let mut value = self.run_view(ledger, run)?;
            value["duplicate"] = json!(true);
            return Ok(value);
        }
        if self.active.contains_key(&strategy) {
            return Err("STRATEGY_ALREADY_RUNNING".into());
        }
        if self.active.len() >= 16 {
            return Err("ACTIVE_STRATEGY_LIMIT".into());
        }
        if ledger.account_halted(&definition.account) {
            return Err("ACCOUNT_HALTED".into());
        }
        if mode == Mode::Paper && !ledger.account_active(&definition.account) {
            return Err("ACCOUNT_PAUSED".into());
        }
        if !books
            .get(&definition.instrument)
            .is_some_and(|b| b.eligible(1000))
        {
            return Err("FRESH_BOOK_REQUIRED".into());
        }
        if ledger
            .orders()
            .any(|o| o.request.strategy == strategy && o.is_open())
        {
            return Err("STRATEGY_HAS_OPEN_ORDERS".into());
        }
        let time = now_ns().to_string();
        let run = Run {
            id: run_id.clone(),
            strategy: strategy.clone(),
            revision: definition.revision,
            mode,
            phase: Phase::Running,
            reason: "USER_STARTED".into(),
            created_at_ns: time.clone(),
            updated_at_ns: time,
            decisions: 0,
        };
        ledger.start_strategy(run)?;
        self.active.insert(
            strategy,
            Live {
                run: run_id.clone(),
                definition,
                opened: Vec::new(),
                last_eval: None,
                last_plan: None,
                last_shadow: Vec::new(),
            },
        );
        self.generation = self.generation.saturating_add(1);
        self.run_view(
            ledger,
            ledger
                .strategy_run(&run_id)
                .ok_or("STRATEGY_RUN_NOT_FOUND")?,
        )
    }
    pub fn stop(
        &mut self,
        ledger: &mut Ledger,
        matcher: &mut Matcher,
        run_id: &str,
        cancel: bool,
        reason: &str,
    ) -> Result<Value> {
        let run = ledger
            .strategy_run(run_id)
            .ok_or("STRATEGY_RUN_NOT_FOUND")?
            .clone();
        if self
            .active
            .get(&run.strategy)
            .is_some_and(|v| v.run == run_id)
        {
            self.active.remove(&run.strategy);
        }
        let ids = ledger
            .orders()
            .filter(|o| ledger.order_run_id(&o.request.id) == Some(run_id) && o.is_open())
            .map(|o| o.request.id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            if cancel {
                ledger.cancel(&id)?;
            }
            matcher.cancelled(&id);
        }
        ledger.strategy_phase(run_id, Phase::Stopped, reason)?;
        self.generation = self.generation.saturating_add(1);
        self.run_view(
            ledger,
            ledger
                .strategy_run(run_id)
                .ok_or("STRATEGY_RUN_NOT_FOUND")?,
        )
    }
    pub fn drive(
        &mut self,
        ledger: &mut Ledger,
        books: &BTreeMap<String, Book>,
        matcher: &mut Matcher,
    ) {
        let mut changed = 0u64;
        self.active.retain(|_, live| {
            if !ledger
                .strategy_run(&live.run)
                .is_some_and(|r| r.phase == Phase::Running)
            {
                for (id, _) in &live.opened {
                    matcher.cancelled(id);
                }
                changed += 1;
                return false;
            }
            let ready = books
                .get(&live.definition.instrument)
                .is_some_and(|b| b.eligible(1000));
            let account_ready = ledger
                .strategy_run(&live.run)
                .is_some_and(|r| r.mode == Mode::Shadow)
                || ledger.account_active(&live.definition.account);
            if !ready || !account_ready {
                for (id, _) in &live.opened {
                    matcher.cancelled(id);
                }
                let _ = ledger.strategy_phase(
                    &live.run,
                    Phase::Paused,
                    if !ready {
                        "FRESH_BOOK_REQUIRED"
                    } else {
                        "ACCOUNT_PAUSED"
                    },
                );
                changed += 1;
                return false;
            }
            if live.last_eval.is_some_and(|mark| {
                clock::elapsed_ns(mark) < u128::from(live.definition.maker.refresh_ms) * 1_000_000
            }) {
                return true;
            }
            live.last_eval = Some(clock::mono_ns());
            let result = Self::step(live, ledger, books, matcher);
            match result {
                Ok(did_change) => {
                    if did_change {
                        changed += 1;
                    }
                    true
                }
                Err(error) => {
                    for (id, _) in &live.opened {
                        matcher.cancelled(id);
                    }
                    let _ = ledger.strategy_phase(&live.run, Phase::Paused, &sanitize(&error));
                    changed += 1;
                    false
                }
            }
        });
        self.generation = self.generation.saturating_add(changed);
    }
    fn step(
        live: &mut Live,
        ledger: &mut Ledger,
        books: &BTreeMap<String, Book>,
        matcher: &mut Matcher,
    ) -> Result<bool> {
        let definition = &live.definition;
        let config = &definition.maker;
        let run = ledger
            .strategy_run(&live.run)
            .ok_or("STRATEGY_RUN_NOT_FOUND")?
            .clone();
        if run.mode == Mode::Paper && !ledger.account_active(&definition.account) {
            return Err("ACCOUNT_PAUSED".into());
        }
        let book = books
            .get(&definition.instrument)
            .filter(|b| b.eligible(1000))
            .ok_or("FRESH_BOOK_REQUIRED")?;
        let instrument = ledger
            .instrument_value(&definition.instrument)
            .ok_or("INSTRUMENT_NOT_FOUND")?
            .clone();
        if run.decisions >= u64::from(config.max_decisions) {
            return Err("STRATEGY_DECISION_BUDGET".into());
        }
        let bid = book
            .bids
            .last_key_value()
            .ok_or("EMPTY_BOOK")?
            .0
            .checked_sub(Fixed(
                instrument
                    .tick
                    .0
                    .checked_mul(i128::from(config.bid_offset_ticks))
                    .ok_or("AMOUNT_OVERFLOW")?,
            ))?;
        let ask = book
            .asks
            .first_key_value()
            .ok_or("EMPTY_BOOK")?
            .0
            .checked_add(Fixed(
                instrument
                    .tick
                    .0
                    .checked_mul(i128::from(config.ask_offset_ticks))
                    .ok_or("AMOUNT_OVERFLOW")?,
            ))?;
        let targets = [(Side::Buy, bid), (Side::Sell, ask)];
        let mut opened = Vec::new();
        let mut occupied = Vec::new();
        let mut changed = false;
        for (id, created) in &live.opened {
            let order = ledger.order(id).ok_or("ORDER_NOT_FOUND")?;
            if !order.is_open() {
                continue;
            }
            if matcher.runtime(order)["held"] == true {
                return Err("STRATEGY_QUEUE_HELD".into());
            }
            let target = if order.request.side == Side::Buy {
                bid
            } else {
                ask
            };
            let distance = order.request.price.0.abs_diff(target.0);
            let expired = clock::elapsed_ns(*created) >= u128::from(config.ttl_ms) * 1_000_000;
            if expired
                || distance
                    >= instrument
                        .tick
                        .0
                        .unsigned_abs()
                        .checked_mul(u128::from(config.reprice_ticks))
                        .ok_or("AMOUNT_OVERFLOW")?
            {
                ledger.cancel(id)?;
                matcher.cancelled(id);
                changed = true;
            } else {
                occupied.push(order.request.side);
                opened.push((id.clone(), *created));
            }
        }
        live.opened = opened;
        let mut proposals = Vec::new();
        for (side, price) in targets {
            if occupied.contains(&side)
                || (side == Side::Buy && config.sides == Sides::Sell)
                || (side == Side::Sell && config.sides == Sides::Buy)
            {
                continue;
            }
            price.positive()?;
            let base = ledger.balance(&definition.account, &instrument.base);
            if side == Side::Buy {
                if base
                    .total
                    .checked_add(ledger.pending_position(&definition.account, &instrument.base))?
                    .checked_add(config.quantity)?
                    > config.max_inventory
                {
                    continue;
                }
                let n = price.multiply(config.quantity, true)?;
                if ledger
                    .balance(&definition.account, &instrument.quote)
                    .available()?
                    < n.checked_add(fee(n, instrument.fee_bps)?)?
                {
                    continue;
                }
            } else if base.available()?.checked_sub(config.quantity)? < config.min_inventory {
                continue;
            }
            proposals.push(Submit {
                id: intent_id(&live.run, run.decisions + 1, side),
                account: definition.account.clone(),
                strategy: definition.id.clone(),
                instrument: definition.instrument.clone(),
                side,
                price,
                quantity: config.quantity,
                post_only: true,
            });
        }
        let shadow = proposals
            .iter()
            .map(|i| (i.side, i.price))
            .collect::<Vec<_>>();
        if proposals.is_empty()
            || (run.mode == Mode::Shadow
                && shadow == live.last_shadow
                && live.last_plan.is_some_and(|mark| {
                    clock::elapsed_ns(mark) < u128::from(config.ttl_ms) * 1_000_000
                }))
        {
            return Ok(changed);
        }
        let decision = Decision {
            run: live.run.clone(),
            ordinal: run.decisions + 1,
            at_ns: now_ns().to_string(),
            observation: book.status(1000, 1),
            intents: proposals.clone(),
            outcomes: Vec::new(),
        };
        ledger.plan_strategy(decision)?;
        let mut outcomes = Vec::new();
        let mut failure = None;
        for request in proposals {
            let id = request.id.clone();
            if run.mode == Mode::Shadow {
                outcomes.push(Outcome {
                    order_id: id,
                    status: "shadow".into(),
                    error: None,
                });
                continue;
            }
            match matcher
                .prepare(&request, book, now_ns(), 500)
                .and_then(|ticket| {
                    ledger
                        .submit(request.clone(), &definition.instrument, book, 1000)
                        .map(|_| ticket)
                }) {
                Ok(ticket) => {
                    matcher.attach(ticket);
                    live.opened.push((id.clone(), clock::mono_ns()));
                    outcomes.push(Outcome {
                        order_id: id,
                        status: "accepted".into(),
                        error: None,
                    });
                }
                Err(error) => {
                    let code = sanitize(&error);
                    failure = Some(code.clone());
                    outcomes.push(Outcome {
                        order_id: id,
                        status: "rejected".into(),
                        error: Some(code),
                    });
                }
            }
        }
        ledger.strategy_outcomes(&live.run, run.decisions + 1, outcomes)?;
        live.last_plan = Some(clock::mono_ns());
        live.last_shadow = shadow;
        if let Some(error) = failure {
            return Err(error);
        }
        Ok(true)
    }
}
