//! Strategy metadata and execution budgets share the order ledger's WAL.
use super::*;
use crate::strategy::{Decision, Definition, Mode, Outcome as StrategyOutcome, Phase, Run, Stats};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "kebab-case", deny_unknown_fields)]
pub(super) enum Change {
    Define {
        value: Definition,
    },
    Start {
        value: Run,
    },
    Phase {
        run: String,
        phase: Phase,
        reason: String,
        time: String,
    },
    Plan {
        value: Decision,
    },
    Result {
        run: String,
        ordinal: u64,
        outcomes: Vec<StrategyOutcome>,
    },
}
#[derive(Default)]
pub(super) struct Store {
    definitions: BTreeMap<(String, u32), Definition>,
    runs: BTreeMap<String, Run>,
    stats: BTreeMap<String, Stats>,
    decisions: BTreeMap<(String, u64), Decision>,
    order_runs: BTreeMap<String, String>,
    run_timeline: BTreeMap<u64, String>,
}
impl Store {
    pub(super) fn halt_account(&mut self, account: &str, time: &str) {
        for run in self.runs.values_mut() {
            if self
                .definitions
                .get(&(run.strategy.clone(), run.revision))
                .is_some_and(|d| d.account == account)
                && matches!(run.phase, Phase::Running | Phase::Paused)
            {
                run.phase = Phase::Stopped;
                run.reason = "ACCOUNT_HALTED".into();
                run.updated_at_ns = time.into();
            }
        }
    }
    fn validate_change(&self, change: &Change) -> Result<()> {
        match change {
            Change::Define { value } => {
                value.validate()?;
                let p = self.latest(&value.id);
                check(
                    value.revision == p.map_or(1, |p| p.revision + 1)
                        && p.is_none_or(|p| p.owner == value.owner),
                    "STRATEGY_REVISION_CONFLICT",
                )
            }
            Change::Start { value } => {
                id(&value.id)?;
                check(
                    self.definitions
                        .contains_key(&(value.strategy.clone(), value.revision))
                        && !self.runs.contains_key(&value.id)
                        && value.phase == Phase::Running
                        && value.decisions == 0,
                    "STRATEGY_RUN_CONFLICT",
                )
            }
            Change::Phase { run, reason, .. } => check(
                self.runs.contains_key(run)
                    && reason.len() <= 80
                    && reason
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_'),
                "STRATEGY_RUN_NOT_FOUND",
            ),
            Change::Plan { value } => {
                let r = self.runs.get(&value.run).ok_or("STRATEGY_RUN_NOT_FOUND")?;
                let definition = self
                    .definitions
                    .get(&(r.strategy.clone(), r.revision))
                    .ok_or("STRATEGY_NOT_FOUND")?;
                check(
                    r.phase == Phase::Running
                        && value.ordinal == r.decisions + 1
                        && value.ordinal <= u64::from(definition.maker.max_decisions)
                        && value.intents.len() <= 2
                        && value.outcomes.is_empty(),
                    "STRATEGY_DECISION_CONFLICT",
                )?;
                let mut seen = BTreeSet::new();
                for i in &value.intents {
                    check(
                        i.strategy == r.strategy
                            && i.account == definition.account
                            && i.instrument == definition.instrument
                            && i.post_only
                            && !self.order_runs.contains_key(&i.id)
                            && seen.insert(&i.id),
                        "STRATEGY_INTENT_CONFLICT",
                    )?;
                    id(&i.id)?;
                    i.price.positive()?;
                    i.quantity.positive()?;
                }
                Ok(())
            }
            Change::Result {
                run,
                ordinal,
                outcomes,
            } => {
                let d = self
                    .decisions
                    .get(&(run.clone(), *ordinal))
                    .ok_or("STRATEGY_DECISION_NOT_FOUND")?;
                check(
                    d.outcomes.is_empty()
                        && outcomes.len() == d.intents.len()
                        && outcomes
                            .iter()
                            .zip(&d.intents)
                            .all(|(r, i)| r.order_id == i.id),
                    "STRATEGY_RESULT_CONFLICT",
                )
            }
        }
    }
    pub(super) fn apply(&mut self, change: Change) -> Result<()> {
        match change {
            Change::Define { value } => {
                value.validate()?;
                let previous = self.latest(&value.id);
                check(
                    value.revision == previous.map_or(1, |p| p.revision + 1)
                        && previous.is_none_or(|p| p.owner == value.owner),
                    "STRATEGY_REVISION_CONFLICT",
                )?;
                self.definitions
                    .insert((value.id.clone(), value.revision), value);
            }
            Change::Start { value } => {
                id(&value.id)?;
                check(
                    self.definitions
                        .contains_key(&(value.strategy.clone(), value.revision))
                        && !self.runs.contains_key(&value.id)
                        && value.phase == Phase::Running
                        && value.decisions == 0,
                    "STRATEGY_RUN_CONFLICT",
                )?;
                self.stats.insert(value.id.clone(), Stats::default());
                self.run_timeline
                    .insert(self.runs.len() as u64 + 1, value.id.clone());
                self.runs.insert(value.id.clone(), value);
            }
            Change::Phase {
                run,
                phase,
                reason,
                time,
            } => {
                let r = self.runs.get_mut(&run).ok_or("STRATEGY_RUN_NOT_FOUND")?;
                r.phase = phase;
                r.reason = reason;
                r.updated_at_ns = time;
            }
            Change::Plan { value } => {
                let r = self
                    .runs
                    .get_mut(&value.run)
                    .ok_or("STRATEGY_RUN_NOT_FOUND")?;
                let definition = self
                    .definitions
                    .get(&(r.strategy.clone(), r.revision))
                    .ok_or("STRATEGY_NOT_FOUND")?;
                check(
                    r.phase == Phase::Running
                        && value.ordinal == r.decisions + 1
                        && value.ordinal <= u64::from(definition.maker.max_decisions)
                        && value.intents.len() <= 2
                        && value.outcomes.is_empty(),
                    "STRATEGY_DECISION_CONFLICT",
                )?;
                let mut seen = BTreeSet::new();
                for intent in &value.intents {
                    check(
                        intent.strategy == r.strategy
                            && intent.account == definition.account
                            && intent.instrument == definition.instrument
                            && intent.post_only
                            && !self.order_runs.contains_key(&intent.id)
                            && seen.insert(intent.id.clone()),
                        "STRATEGY_INTENT_CONFLICT",
                    )?;
                    id(&intent.id)?;
                    intent.price.positive()?;
                    intent.quantity.positive()?;
                }
                r.decisions = value.ordinal;
                r.updated_at_ns = value.at_ns.clone();
                for intent in &value.intents {
                    self.order_runs.insert(intent.id.clone(), value.run.clone());
                }
                self.decisions
                    .insert((value.run.clone(), value.ordinal), value);
            }
            Change::Result {
                run,
                ordinal,
                outcomes,
            } => {
                let d = self
                    .decisions
                    .get_mut(&(run, ordinal))
                    .ok_or("STRATEGY_DECISION_NOT_FOUND")?;
                check(
                    d.outcomes.is_empty() && outcomes.len() == d.intents.len(),
                    "STRATEGY_RESULT_CONFLICT",
                )?;
                for (r, intent) in outcomes.iter().zip(&d.intents) {
                    check(r.order_id == intent.id, "STRATEGY_RESULT_CONFLICT")?;
                }
                d.outcomes = outcomes;
            }
        }
        Ok(())
    }
    fn latest(&self, id: &str) -> Option<&Definition> {
        self.definitions
            .range((id.to_string(), 0)..=(id.to_string(), u32::MAX))
            .next_back()
            .map(|(_, v)| v)
    }
    pub(super) fn owned_by(&self, strategy: &str, owner: &str) -> bool {
        strategy == owner || self.latest(strategy).is_some_and(|d| d.owner == owner)
    }
    pub(super) fn owner<'a>(&'a self, strategy: &'a str) -> &'a str {
        self.latest(strategy).map_or(strategy, |d| d.owner.as_str())
    }
    pub(super) fn order_update(
        &mut self,
        old: Option<&Order>,
        new: &Order,
        instruments: &BTreeMap<String, Instrument>,
    ) -> Result<()> {
        let Some(run) = self.order_runs.get(&new.request.id) else {
            return Ok(());
        };
        let instrument = instruments
            .get(&new.request.instrument)
            .ok_or("INSTRUMENT_NOT_FOUND")?;
        let reserved = |o: &Order| -> Result<(Fixed, Fixed)> {
            if !o.is_open() {
                return Ok((Fixed(0), Fixed(0)));
            }
            Ok((
                o.request.price.multiply(o.remaining()?, true)?,
                fee(
                    o.request.price.multiply(o.request.quantity, true)?,
                    instrument.fee_bps,
                )?,
            ))
        };
        let (previous, previous_fees) = old.map(reserved).transpose()?.unwrap_or_default();
        let (next, next_fees) = reserved(new)?;
        let stats = self.stats.get_mut(run).ok_or("STRATEGY_RUN_NOT_FOUND")?;
        stats.gross_filled = stats.gross_filled.checked_add(
            new.notional
                .checked_sub(old.map_or(Fixed(0), |o| o.notional))?,
        )?;
        stats.fees = stats
            .fees
            .checked_add(new.fees.checked_sub(old.map_or(Fixed(0), |o| o.fees))?)?;
        stats.open_notional = stats
            .open_notional
            .checked_sub(previous)?
            .checked_add(next)?;
        stats.pending_fees = stats
            .pending_fees
            .checked_sub(previous_fees)?
            .checked_add(next_fees)?;
        if old.is_none() {
            stats.orders = stats.orders.checked_add(1).ok_or("COUNTER_LIMIT")?;
        }
        Ok(())
    }
    pub(super) fn validate_order(&self, request: &Submit) -> Result<()> {
        if self.latest(&request.strategy).is_none() {
            return Ok(());
        }
        let run = self
            .order_runs
            .get(&request.id)
            .and_then(|r| self.runs.get(r))
            .ok_or("STRATEGY_PLAN_REQUIRED")?;
        check(run.mode == Mode::Paper, "SHADOW_ORDER_FORBIDDEN")?;
        let planned = self
            .decisions
            .range((run.id.clone(), 0)..=(run.id.clone(), u64::MAX))
            .rev()
            .find_map(|(_, d)| d.intents.iter().find(|i| i.id == request.id));
        check(planned == Some(request), "STRATEGY_INTENT_CONFLICT")
    }
}
impl Ledger {
    pub fn order_run_id(&self, id: &str) -> Option<&str> {
        self.state.strategies.order_runs.get(id).map(String::as_str)
    }
    fn strategy_commit(&mut self, value: Change) -> Result<()> {
        self.state.strategies.validate_change(&value)?;
        self.commit(Event::Strategy { value })
    }
    pub fn define_strategy(&mut self, value: Definition) -> Result<()> {
        value.validate()?;
        let instrument = self
            .instrument_value(&value.instrument)
            .ok_or("INSTRUMENT_NOT_FOUND")?;
        check(
            self.state.risk.contains_key(&value.account),
            "ACCOUNT_NOT_FOUND",
        )?;
        check(
            value.maker.quantity.multiple_of(instrument.lot),
            "QUANTITY_LOT_MISMATCH",
        )?;
        if let Some(old) = self
            .state
            .strategies
            .definitions
            .get(&(value.id.clone(), value.revision))
        {
            return check(old == &value, "STRATEGY_REVISION_CONFLICT");
        }
        check(
            self.state.strategies.definitions.len() < 10000,
            "STRATEGY_LIMIT",
        )?;
        let old = self.state.strategies.latest(&value.id);
        check(
            value.revision == old.map_or(1, |v| v.revision + 1)
                && old.is_none_or(|v| v.owner == value.owner),
            "STRATEGY_REVISION_CONFLICT",
        )?;
        self.strategy_commit(Change::Define { value })
    }
    pub fn strategy(&self, id: &str, revision: u32) -> Option<&Definition> {
        if revision == 0 {
            self.state.strategies.latest(id)
        } else {
            self.state
                .strategies
                .definitions
                .get(&(id.into(), revision))
        }
    }
    pub fn strategies(&self) -> impl Iterator<Item = &Definition> {
        self.state.strategies.definitions.values()
    }
    pub fn strategy_owned_by(&self, id: &str, owner: &str) -> bool {
        self.state.strategies.owned_by(id, owner)
    }
    pub fn order_owner<'a>(&'a self, order: &'a Order) -> &'a str {
        self.state.strategies.owner(&order.request.strategy)
    }
    pub fn strategy_runs(&self) -> impl Iterator<Item = &Run> {
        self.state
            .strategies
            .run_timeline
            .values()
            .rev()
            .filter_map(|id| self.state.strategies.runs.get(id))
    }
    pub fn strategy_run(&self, id: &str) -> Option<&Run> {
        self.state.strategies.runs.get(id)
    }
    pub fn strategy_stats(&self, id: &str) -> Result<Stats> {
        self.state
            .strategies
            .stats
            .get(id)
            .cloned()
            .ok_or("STRATEGY_RUN_NOT_FOUND".into())
    }
    pub fn strategy_decisions(&self, run: &str) -> impl Iterator<Item = &Decision> {
        self.state
            .strategies
            .decisions
            .range((run.to_string(), 0)..=(run.to_string(), u64::MAX))
            .rev()
            .map(|(_, d)| d)
    }
    pub fn account_active(&self, id: &str) -> bool {
        self.enabled() && !self.account_halted(id) && self.active_accounts.contains(id)
    }
    pub fn pending_position(&self, account: &str, asset: &str) -> Fixed {
        self.state.pending(account, asset)
    }
    pub fn start_strategy(&mut self, run: Run) -> Result<bool> {
        if let Some(old) = self.strategy_run(&run.id) {
            check(
                old.strategy == run.strategy
                    && old.revision == run.revision
                    && old.mode == run.mode,
                "STRATEGY_RUN_CONFLICT",
            )?;
            return Ok(false);
        }
        check(
            self.state.strategies.runs.len() < 10000,
            "STRATEGY_RUN_LIMIT",
        )?;
        let definition = self
            .strategy(&run.strategy, run.revision)
            .ok_or("STRATEGY_NOT_FOUND")?;
        check(!self.account_halted(&definition.account), "ACCOUNT_HALTED")?;
        self.strategy_commit(Change::Start { value: run })?;
        Ok(true)
    }
    pub fn strategy_phase(&mut self, run: &str, phase: Phase, reason: &str) -> Result<()> {
        let old = self.strategy_run(run).ok_or("STRATEGY_RUN_NOT_FOUND")?;
        if old.phase == phase && old.reason == reason {
            return Ok(());
        }
        self.strategy_commit(Change::Phase {
            run: run.into(),
            phase,
            reason: reason.into(),
            time: utc_ns(),
        })
    }
    pub fn plan_strategy(&mut self, value: Decision) -> Result<()> {
        let run = self
            .strategy_run(&value.run)
            .ok_or("STRATEGY_RUN_NOT_FOUND")?;
        let definition = self
            .strategy(&run.strategy, run.revision)
            .ok_or("STRATEGY_NOT_FOUND")?;
        let instrument = self
            .instrument_value(&definition.instrument)
            .ok_or("INSTRUMENT_NOT_FOUND")?;
        let stats = self.strategy_stats(&value.run)?;
        let mut notional = Fixed(0);
        let mut fees = Fixed(0);
        for intent in &value.intents {
            let n = intent.price.multiply(intent.quantity, true)?;
            notional = notional.checked_add(n)?;
            fees = fees.checked_add(fee(n, instrument.fee_bps)?)?;
        }
        check(
            stats
                .gross_filled
                .checked_add(stats.open_notional)?
                .checked_add(notional)?
                <= definition.maker.max_notional,
            "STRATEGY_NOTIONAL_BUDGET",
        )?;
        check(
            stats
                .fees
                .checked_add(stats.pending_fees)?
                .checked_add(fees)?
                <= definition.maker.max_fees,
            "STRATEGY_FEE_BUDGET",
        )?;
        self.strategy_commit(Change::Plan { value })
    }
    pub fn strategy_outcomes(
        &mut self,
        run: &str,
        ordinal: u64,
        outcomes: Vec<StrategyOutcome>,
    ) -> Result<()> {
        self.strategy_commit(Change::Result {
            run: run.into(),
            ordinal,
            outcomes,
        })
    }
}
