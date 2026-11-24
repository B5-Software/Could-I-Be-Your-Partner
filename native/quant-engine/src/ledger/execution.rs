//! Wallet execution plans and outbox share the durable engine WAL. This module
//! owns allocated input budgets, not wallet balances, keys or broker authority.
use super::*;
use crate::clock;
use std::cmp::Ordering;

const FIXED_TEMPLATE: &str = "base-twap-fixed-v1";
const VWAP_TEMPLATE: &str = "base-vwap-fixed-v1";
pub const WINDOW_EXPIRED: &str = "EXECUTION_WINDOW_EXPIRED";

#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AgentScope {
    pub id: String,
    pub subject: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct VwapProfile {
    pub profile_id: String,
    pub weth_volume_atoms: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Plan {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_scope: Option<AgentScope>,
    pub template: String,
    pub id: String,
    pub owner: String,
    pub wallet: String,
    pub chain_id: u64,
    pub side: Side,
    /// Smallest input-token units: USDC (6) for buy, WETH (18) for sell.
    pub total_input_atoms: String,
    pub slices: u32,
    pub interval_ms: u64,
    pub slippage_bps: u16,
    pub pool_fee: u32,
    pub config_hash: String,
    /// Legacy, non-broadcasting prototype plans had no fee budget.
    #[serde(default)]
    pub max_fee_reserve_wei: Option<String>,
    /// Minimum output at the planned input size, in WETH (buy) or USDC (sell) atoms.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_total_output_atoms: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_arrival_cost_bps: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_trigger: Option<EntryTrigger>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protective_exit: Option<ProtectiveExit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vwap: Option<VwapProfile>,
}
impl Plan {
    fn total(&self) -> Result<u128> {
        let value = self
            .total_input_atoms
            .parse::<u128>()
            .map_err(|_| "EXECUTION_AMOUNT_RANGE")?;
        check(
            value > 0 && value.to_string() == self.total_input_atoms,
            "EXECUTION_AMOUNT_RANGE",
        )?;
        Ok(value)
    }
    fn validate(&self) -> Result<()> {
        if let Some(scope) = &self.agent_scope {
            check(
                scope.id.len() == 64 && scope.id.bytes().all(|c| c.is_ascii_hexdigit()),
                "INVALID_EXECUTION_PLAN",
            )?;
            id(&scope.subject)?;
        }
        if let Some(fee) = &self.max_fee_reserve_wei {
            let value = fee
                .parse::<u128>()
                .map_err(|_| "EXECUTION_FEE_BUDGET_REQUIRED")?;
            check(
                value > 0 && value.to_string() == *fee,
                "EXECUTION_FEE_BUDGET_REQUIRED",
            )?;
        }
        self.minimum_output()?;
        if let Some(trigger) = &self.entry_trigger {
            check(self.template == "base-twap-v1", "EXECUTION_ENTRY_INVALID")?;
            trigger_price(&trigger.price_atoms, "EXECUTION_ENTRY_INVALID")?;
        }
        if let Some(exit) = &self.protective_exit {
            check(
                self.template == "base-twap-v1"
                    && self.side == Side::Sell
                    && self.slices == 1
                    && self.entry_trigger.is_none(),
                "EXECUTION_EXIT_INVALID",
            )?;
            exit.thresholds()?;
        }
        check(
            self.max_arrival_cost_bps.is_none_or(|bps| bps < 10_000),
            "EXECUTION_ARRIVAL_LIMIT_RANGE",
        )?;
        id(&self.id)?;
        id(&self.owner)?;
        id(&self.wallet)?;
        check(
            matches!(
                self.template.as_str(),
                "base-twap-v1" | FIXED_TEMPLATE | VWAP_TEMPLATE
            ) && matches!(self.chain_id, 8453 | 84532)
                && (1..=1000).contains(&self.slices)
                && self.total()? >= u128::from(self.slices)
                && (1000..=86400000).contains(&self.interval_ms)
                && self.slippage_bps <= 500
                && (1..1000000).contains(&self.pool_fee)
                && self.config_hash.len() == 64
                && self
                    .config_hash
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
            "INVALID_EXECUTION_PLAN",
        )?;
        check(
            (self.template == VWAP_TEMPLATE) == self.vwap.is_some(),
            "EXECUTION_PROFILE_INVALID",
        )?;
        if let Some(profile) = &self.vwap {
            check(
                profile.profile_id.len() == 64
                    && profile
                        .profile_id
                        .bytes()
                        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                    && (2..=96).contains(&self.slices)
                    && self.interval_ms.is_multiple_of(1000)
                    && self.interval_ms * u64::from(self.slices) <= 7_200_000
                    && profile.weth_volume_atoms.len() == self.slices as usize,
                "EXECUTION_PROFILE_INVALID",
            )?;
            self.weighted_range(profile, 0, self.slices)?;
        }
        Ok(())
    }
    pub fn fixed(&self) -> bool {
        matches!(self.template.as_str(), FIXED_TEMPLATE | VWAP_TEMPLATE)
    }
    pub fn interval_ns(&self) -> u128 {
        u128::from(self.interval_ms) * 1_000_000
    }
    fn slice(&self, completed: u32) -> Result<String> {
        check(completed < self.slices, "EXECUTION_COMPLETE")?;
        let input = self.range_input(completed, completed + 1)?;
        check(input > 0, "EXECUTION_NO_ALLOCATED_INPUT")?;
        Ok(input.to_string())
    }
    pub fn range_input(&self, start: u32, end: u32) -> Result<u128> {
        check(start <= end && end <= self.slices, "EXECUTION_WINDOW_RANGE")?;
        if let Some(profile) = &self.vwap {
            return self.weighted_range(profile, start, end);
        }
        let total = self.total()?;
        let slices = u128::from(self.slices);
        let remainder = total % slices;
        Ok(
            total / slices * u128::from(end - start) + u128::from(end).min(remainder)
                - u128::from(start).min(remainder),
        )
    }
    fn weighted_range(&self, profile: &VwapProfile, start: u32, end: u32) -> Result<u128> {
        let mut sum = 0u128;
        let mut before = 0u128;
        let mut through = 0u128;
        for (index, text) in profile.weth_volume_atoms.iter().enumerate() {
            let weight = text
                .parse::<u128>()
                .map_err(|_| "EXECUTION_PROFILE_INVALID")?;
            check(weight.to_string() == *text, "EXECUTION_PROFILE_INVALID")?;
            sum = sum.checked_add(weight).ok_or("EXECUTION_PROFILE_INVALID")?;
            if index < start as usize {
                before = sum;
            }
            if index < end as usize {
                through = sum;
            }
        }
        check(sum > 0, "EXECUTION_PROFILE_INVALID")?;
        let total = U256::from(self.total()?);
        let allocated = |weight| total * U256::from(weight) / U256::from(sum);
        // Each cumulative allocation is at most total, which already fits in u128.
        Ok((allocated(through) - allocated(before)).as_u128())
    }
    fn minimum_output(&self) -> Result<Option<u128>> {
        self.min_total_output_atoms
            .as_ref()
            .map(|amount| {
                let value = amount
                    .parse::<u128>()
                    .map_err(|_| "EXECUTION_PRICE_LIMIT_RANGE")?;
                check(
                    value > 0 && value.to_string() == *amount,
                    "EXECUTION_PRICE_LIMIT_RANGE",
                )?;
                Ok(value)
            })
            .transpose()
    }
    fn slice_minimum(&self, input: &str) -> Result<Option<String>> {
        let Some(floor) = self.minimum_output()? else {
            return Ok(None);
        };
        let input = input
            .parse::<u128>()
            .map_err(|_| "EXECUTION_AMOUNT_RANGE")?;
        let numerator = U256::from(floor) * U256::from(input);
        let total = U256::from(self.total()?);
        let floor = numerator / total + U256::from(u8::from(numerator % total != U256::ZERO));
        Ok(Some(floor.to_string()))
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Running,
    Paused,
    Stopped,
    Completed,
    Expired,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Stage {
    Ready,
    Claimed,
    Submitted,
    Included,
    Safe,
    Uncertain,
    Finalized,
    Unsent,
    Reverted,
    /// Earlier steps (such as approval) settled, but no swap was broadcast.
    Aborted,
}
impl Stage {
    fn terminal(self) -> bool {
        matches!(
            self,
            Self::Finalized | Self::Unsent | Self::Reverted | Self::Aborted
        )
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Run {
    pub plan: Plan,
    pub phase: Phase,
    pub reason: String,
    pub generation: u32,
    pub completed_slices: u32,
    pub allocated_input_atoms: String,
    pub commands_created: u32,
    pub pending: Option<String>,
    pub policy_id: Option<String>,
    pub updated_at_ns: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fixed: Option<FixedSchedule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arrival: Option<Arrival>,
}
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Arrival {
    pub pool: String,
    pub block: String,
    pub block_hash: String,
    pub block_time: u64,
    pub sqrt_price_x96: String,
    pub weth_is_token0: bool,
}
impl Arrival {
    fn validate(&self, started: u128) -> Result<()> {
        let hex = |value: &str, len| {
            value.len() == len
                && value.starts_with("0x")
                && value[2..]
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        };
        let block = self
            .block
            .parse::<u64>()
            .map_err(|_| "EXECUTION_ARRIVAL_INVALID")?;
        let price = self
            .sqrt_price_x96
            .parse::<U256>()
            .map_err(|_| "EXECUTION_ARRIVAL_INVALID")?;
        check(
            hex(&self.pool, 42)
                && hex(&self.block_hash, 66)
                && block.to_string() == self.block
                && price > U256::ZERO
                && price < (U256::ONE << 160u32)
                && price.to_string() == self.sqrt_price_x96
                && started.abs_diff(u128::from(self.block_time) * 1_000_000_000) <= 30_000_000_000,
            "EXECUTION_ARRIVAL_INVALID",
        )
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum EntryRelation {
    AtOrBelow,
    AtOrAbove,
}

#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct EntryTrigger {
    pub relation: EntryRelation,
    /// USDC atoms per one WETH.
    pub price_atoms: String,
}
impl EntryTrigger {
    fn verify(&self, observed: &Arrival, arrival: &Arrival, claimed: u128) -> Result<()> {
        observed.validate_trigger(arrival, claimed, "EXECUTION_ENTRY_UNAVAILABLE")?;
        let order =
            observed.price_order(trigger_price(&self.price_atoms, "EXECUTION_ENTRY_INVALID")?)?;
        check(
            match self.relation {
                EntryRelation::AtOrBelow => order != Ordering::Greater,
                EntryRelation::AtOrAbove => order != Ordering::Less,
            },
            "EXECUTION_ENTRY_WAIT",
        )
    }
}

fn trigger_price(value: &str, invalid: &str) -> Result<U256> {
    let price = value.parse::<u64>().map_err(|_| invalid)?;
    check(
        (1..10u64.pow(18)).contains(&price) && price.to_string() == value,
        invalid,
    )?;
    Ok(U256::from(price))
}

impl Arrival {
    fn validate_trigger(&self, arrival: &Arrival, claimed: u128, invalid: &str) -> Result<()> {
        self.validate(claimed).map_err(|_| invalid)?;
        check(
            self.pool == arrival.pool && self.weth_is_token0 == arrival.weth_is_token0,
            invalid,
        )
    }
    fn price_order(&self, price: U256) -> Result<Ordering> {
        let sqrt = self
            .sqrt_price_x96
            .parse::<U256>()
            .map_err(|_| "EXECUTION_ARRIVAL_INVALID")?;
        let q192 = U256::ONE << 192u32;
        let weth_unit = U256::from(10u64.pow(18));
        // Divide before comparing so the square and price product need no 512-bit type.
        // The remainder distinguishes an exact boundary from a rounded display value.
        let (numerator, denominator) = if self.weth_is_token0 {
            (price * q192, weth_unit)
        } else {
            (q192 * weth_unit, price)
        };
        let order = match sqrt
            .checked_mul(sqrt)
            .map(|square| square.cmp(&(numerator / denominator)))
        {
            Some(Ordering::Equal) if numerator % denominator != U256::ZERO => Ordering::Less,
            Some(value) => value,
            None => Ordering::Greater,
        };
        Ok(if self.weth_is_token0 {
            order
        } else {
            order.reverse()
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ProtectiveExit {
    pub stop_loss_price_atoms: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub take_profit_price_atoms: Option<String>,
}
impl ProtectiveExit {
    fn thresholds(&self) -> Result<(U256, Option<U256>)> {
        let stop = trigger_price(&self.stop_loss_price_atoms, "EXECUTION_EXIT_INVALID")?;
        let profit = self
            .take_profit_price_atoms
            .as_ref()
            .map(|price| trigger_price(price, "EXECUTION_EXIT_INVALID"))
            .transpose()?;
        check(
            profit.is_none_or(|price| price > stop),
            "EXECUTION_EXIT_INVALID",
        )?;
        Ok((stop, profit))
    }
    fn verify(&self, observed: &Arrival, arrival: &Arrival, claimed: u128) -> Result<ExitCause> {
        observed.validate_trigger(arrival, claimed, "EXECUTION_EXIT_UNAVAILABLE")?;
        let (stop, profit) = self.thresholds()?;
        if observed.price_order(stop)? != Ordering::Greater {
            return Ok(ExitCause::StopLoss);
        }
        if let Some(profit) = profit
            && observed.price_order(profit)? != Ordering::Less
        {
            return Ok(ExitCause::TakeProfit);
        }
        Err("EXECUTION_EXIT_WAIT".into())
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ExitCause {
    StopLoss,
    TakeProfit,
}

#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ExitTrigger {
    pub cause: ExitCause,
    pub observation: Arrival,
}
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FixedSchedule {
    pub start_at_ns: String,
    pub end_at_ns: String,
    pub next_slot: u32,
    pub skipped_slices: u32,
    pub skipped_input_atoms: String,
    pub observed_at_ns: String,
}
impl Run {
    pub fn window(&self, slot: u32) -> Result<DispatchWindow> {
        let schedule = self.fixed.as_ref().ok_or("EXECUTION_WINDOW_REQUIRED")?;
        check(slot < self.plan.slices, "EXECUTION_WINDOW_RANGE")?;
        let start = execution_time(&schedule.start_at_ns)?;
        let interval = self.plan.interval_ns();
        let opens = start + interval * u128::from(slot);
        Ok(DispatchWindow {
            opens_at_ns: opens.to_string(),
            closes_at_ns: (opens + interval).to_string(),
        })
    }
    pub fn closed_windows(&self, now: u128) -> Result<u32> {
        let schedule = self.fixed.as_ref().ok_or("EXECUTION_WINDOW_REQUIRED")?;
        let start = execution_time(&schedule.start_at_ns)?;
        Ok(
            (now.saturating_sub(start) / self.plan.interval_ns()).min(u128::from(self.plan.slices))
                as u32,
        )
    }
    fn observe(&mut self, now: u128) -> Result<()> {
        if let Some(schedule) = &mut self.fixed {
            check(
                now >= execution_time(&schedule.observed_at_ns)?,
                "EXECUTION_CLOCK_REGRESSED",
            )?;
            schedule.observed_at_ns = now.to_string();
        }
        Ok(())
    }
    fn skip(&mut self, start: u32, end: u32) -> Result<()> {
        let amount = self.plan.range_input(start, end)?;
        let schedule = self.fixed.as_mut().ok_or("EXECUTION_WINDOW_REQUIRED")?;
        schedule.skipped_slices += end - start;
        schedule.skipped_input_atoms =
            (execution_time(&schedule.skipped_input_atoms)? + amount).to_string();
        Ok(())
    }
    fn finish_windows(&mut self) {
        if self.pending.is_none()
            && self
                .fixed
                .as_ref()
                .is_some_and(|s| s.next_slot == self.plan.slices)
        {
            if self.allocated_input_atoms == self.plan.total_input_atoms {
                self.phase = Phase::Completed;
                self.reason = "COMPLETED".into();
            } else {
                self.phase = Phase::Expired;
                if matches!(
                    self.reason.as_str(),
                    "STARTED" | "EXECUTION_WINDOW_MISSED" | "EXECUTION_NO_ALLOCATED_INPUT"
                ) {
                    self.reason = "EXECUTION_WINDOW_ENDED".into();
                }
            }
        }
    }
}
fn execution_time(value: &str) -> Result<u128> {
    value.parse().map_err(|_| "INVALID_EXECUTION_TIME".into())
}
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DispatchWindow {
    pub opens_at_ns: String,
    pub closes_at_ns: String,
}
impl DispatchWindow {
    pub fn remaining(&self, now: u128) -> Result<u128> {
        check(
            now >= execution_time(&self.opens_at_ns)?,
            "EXECUTION_WINDOW_NOT_OPEN",
        )?;
        Ok(execution_time(&self.closes_at_ns)?.saturating_sub(now))
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Command {
    pub id: String,
    pub run: String,
    pub ordinal: u32,
    pub generation: u32,
    pub input_atoms: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_output_atoms: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<DispatchWindow>,
    pub stage: Stage,
    pub lease: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_observation: Option<Arrival>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_trigger: Option<ExitTrigger>,
    pub intent_ids: Vec<String>,
    pub hashes: Vec<String>,
    pub reason: String,
    pub created_at_ns: String,
    pub updated_at_ns: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Report {
    pub command: String,
    pub lease: String,
    pub stage: Stage,
    pub intent_ids: Vec<String>,
    pub hashes: Vec<String>,
    pub reason: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "kebab-case", deny_unknown_fields)]
pub(super) enum Change {
    Create {
        plan: Box<Plan>,
        time: String,
    },
    Start {
        run: String,
        policy: String,
        time: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        arrival: Option<Arrival>,
    },
    Stop {
        run: String,
        time: String,
    },
    Recover {
        run: String,
        time: String,
        reason: String,
    },
    Plan {
        run: String,
        time: String,
    },
    SkipWindows {
        run: String,
        time: String,
    },
    SkipEmptyWindow {
        run: String,
        time: String,
    },
    Claim {
        command: String,
        lease: String,
        time: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        entry_observation: Option<Arrival>,
    },
    Report {
        report: Report,
        time: String,
    },
}
#[derive(Default)]
pub(super) struct Store {
    runs: BTreeMap<String, Run>,
    commands: BTreeMap<String, Command>,
    history: BTreeMap<(String, u32), String>,
}
struct Mutation {
    run: Run,
    command: Option<Command>,
}
impl Store {
    fn transition(&self, change: &Change) -> Result<Mutation> {
        let (run_id, time) = match change {
            Change::Create { plan, time } => {
                plan.validate()?;
                check(
                    self.runs.len() < 1000 && !self.runs.contains_key(&plan.id),
                    "EXECUTION_PLAN_CONFLICT",
                )?;
                return Ok(Mutation {
                    run: Run {
                        plan: plan.as_ref().clone(),
                        phase: Phase::Paused,
                        reason: "CREATED".into(),
                        generation: 0,
                        completed_slices: 0,
                        allocated_input_atoms: "0".into(),
                        commands_created: 0,
                        pending: None,
                        policy_id: None,
                        updated_at_ns: time.clone(),
                        fixed: None,
                        arrival: None,
                    },
                    command: None,
                });
            }
            Change::Start { run, time, .. }
            | Change::Stop { run, time }
            | Change::Recover { run, time, .. }
            | Change::SkipWindows { run, time }
            | Change::SkipEmptyWindow { run, time }
            | Change::Plan { run, time } => (run, time),
            Change::Claim { command, time, .. } => (
                &self
                    .commands
                    .get(command)
                    .ok_or("EXECUTION_COMMAND_NOT_FOUND")?
                    .run,
                time,
            ),
            Change::Report { report, time } => (
                &self
                    .commands
                    .get(&report.command)
                    .ok_or("EXECUTION_COMMAND_NOT_FOUND")?
                    .run,
                time,
            ),
        };
        let mut run = self.runs.get(run_id).ok_or("EXECUTION_NOT_FOUND")?.clone();
        let mut command = run
            .pending
            .as_ref()
            .and_then(|id| self.commands.get(id))
            .cloned();
        match change {
            Change::Start {
                policy, arrival, ..
            } => {
                id(policy)?;
                check(
                    run.completed_slices < run.plan.slices
                        && run.pending.is_none()
                        && !matches!(run.phase, Phase::Running | Phase::Expired)
                        && run.generation < 1000,
                    "EXECUTION_CANNOT_START",
                )?;
                if let Some(snapshot) = arrival {
                    check(run.generation == 0, "EXECUTION_ARRIVAL_IMMUTABLE")?;
                    snapshot.validate(execution_time(time)?)?;
                    run.arrival = Some(snapshot.clone());
                }
                check(
                    (run.plan.max_arrival_cost_bps.is_none()
                        && run.plan.entry_trigger.is_none()
                        && run.plan.protective_exit.is_none())
                        || run.arrival.is_some(),
                    "EXECUTION_ARRIVAL_REQUIRED",
                )?;
                if run.plan.fixed() {
                    let now = execution_time(time)?;
                    if run.fixed.is_none() {
                        run.fixed = Some(FixedSchedule {
                            start_at_ns: time.clone(),
                            end_at_ns: (now + run.plan.interval_ns() * u128::from(run.plan.slices))
                                .to_string(),
                            next_slot: 0,
                            skipped_slices: 0,
                            skipped_input_atoms: "0".into(),
                            observed_at_ns: time.clone(),
                        });
                    } else {
                        run.observe(now)?;
                    }
                }
                check(
                    !self.runs.values().any(|other| {
                        other.plan.id != run.plan.id
                            && other.plan.wallet == run.plan.wallet
                            && other.plan.chain_id == run.plan.chain_id
                            && (other.phase == Phase::Running || other.pending.is_some())
                    }),
                    "EXECUTION_WALLET_BUSY",
                )?;
                run.phase = Phase::Running;
                run.reason = "STARTED".into();
                run.policy_id = Some(policy.clone());
                run.generation += 1;
            }
            Change::Stop { .. } | Change::Recover { .. } => {
                let recovery = matches!(change, Change::Recover { .. });
                if run.phase != Phase::Completed && (!recovery || run.phase == Phase::Running) {
                    run.phase = if recovery {
                        Phase::Paused
                    } else {
                        Phase::Stopped
                    };
                    run.reason = if let Change::Recover { reason, .. } = change {
                        check(
                            reason.len() <= 80
                                && reason.bytes().all(|c| {
                                    c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_'
                                }),
                            "INVALID_EXECUTION_REASON",
                        )?;
                        reason.clone()
                    } else {
                        "STOPPED".into()
                    };
                }
                if let Some(value) = command.as_mut() {
                    if value.stage == Stage::Ready {
                        value.stage = Stage::Unsent;
                        value.reason = "NOT_DISPATCHED".into();
                        run.pending = None;
                        if value.window.is_some() {
                            run.skip(value.ordinal - 1, value.ordinal)?;
                        }
                    } else if value.stage == Stage::Claimed {
                        value.stage = Stage::Uncertain;
                        value.reason = "RECONCILE_REQUIRED".into();
                    }
                }
            }
            Change::Plan { .. } => {
                check(
                    run.phase == Phase::Running
                        && command.is_none()
                        && self.commands.len() < 100000,
                    "EXECUTION_NOT_READY",
                )?;
                let slot = run
                    .fixed
                    .as_ref()
                    .map_or(run.completed_slices, |s| s.next_slot);
                let ordinal = slot + 1;
                let window = if run.fixed.is_some() {
                    let now = execution_time(time)?;
                    run.observe(now)?;
                    let window = run.window(slot)?;
                    check(window.remaining(now)? > 0, WINDOW_EXPIRED)?;
                    run.fixed.as_mut().unwrap().next_slot = ordinal;
                    Some(window)
                } else {
                    None
                };
                let digest = fingerprint(&(&run.plan.id, ordinal, run.generation))?;
                let command_id = format!("live:{digest}");
                check(
                    !self.commands.contains_key(&command_id),
                    "EXECUTION_COMMAND_CONFLICT",
                )?;
                let input_atoms = run.plan.slice(slot)?;
                let min_output_atoms = run.plan.slice_minimum(&input_atoms)?;
                command = Some(Command {
                    id: command_id.clone(),
                    run: run.plan.id.clone(),
                    ordinal,
                    generation: run.generation,
                    input_atoms,
                    min_output_atoms,
                    window,
                    stage: Stage::Ready,
                    lease: None,
                    entry_observation: None,
                    exit_trigger: None,
                    intent_ids: Vec::new(),
                    hashes: Vec::new(),
                    reason: "PLANNED".into(),
                    created_at_ns: time.clone(),
                    updated_at_ns: time.clone(),
                });
                run.pending = Some(command_id);
                run.commands_created += 1;
            }
            Change::SkipWindows { .. } => {
                check(run.phase == Phase::Running, "EXECUTION_NOT_READY")?;
                let now = execution_time(time)?;
                run.observe(now)?;
                let closed = run.closed_windows(now)?;
                let next = run.fixed.as_ref().unwrap().next_slot;
                let expired_ready = command
                    .as_ref()
                    .is_some_and(|c| c.stage == Stage::Ready && c.ordinal <= closed);
                check(
                    closed > next || expired_ready,
                    "EXECUTION_WINDOW_NOT_CLOSED",
                )?;
                if expired_ready {
                    let value = command.as_mut().unwrap();
                    value.stage = Stage::Unsent;
                    value.reason = "EXECUTION_WINDOW_MISSED".into();
                    run.skip(value.ordinal - 1, value.ordinal)?;
                    run.pending = None;
                } else {
                    // A claimed or submitted command keeps its existing evidence.
                    command = None;
                }
                if closed > next {
                    run.skip(next, closed)?;
                    run.fixed.as_mut().unwrap().next_slot = closed;
                }
                run.reason = "EXECUTION_WINDOW_MISSED".into();
            }
            Change::SkipEmptyWindow { .. } => {
                check(
                    run.phase == Phase::Running && command.is_none(),
                    "EXECUTION_NOT_READY",
                )?;
                let now = execution_time(time)?;
                run.observe(now)?;
                let slot = run
                    .fixed
                    .as_ref()
                    .ok_or("EXECUTION_WINDOW_REQUIRED")?
                    .next_slot;
                check(run.window(slot)?.remaining(now)? > 0, WINDOW_EXPIRED)?;
                check(
                    run.plan.range_input(slot, slot + 1)? == 0,
                    "EXECUTION_PROFILE_INVALID",
                )?;
                run.skip(slot, slot + 1)?;
                run.fixed.as_mut().unwrap().next_slot += 1;
                run.reason = "EXECUTION_NO_ALLOCATED_INPUT".into();
            }
            Change::Claim {
                command: id,
                lease,
                entry_observation,
                ..
            } => {
                super::id(lease)?;
                let value = command.as_mut().ok_or("EXECUTION_COMMAND_NOT_PENDING")?;
                check(
                    run.phase == Phase::Running && value.id == *id && value.stage == Stage::Ready,
                    "EXECUTION_COMMAND_ALREADY_CLAIMED",
                )?;
                if let Some(window) = &value.window {
                    let now = execution_time(time)?;
                    run.observe(now)?;
                    check(window.remaining(now)? > 0, WINDOW_EXPIRED)?;
                }
                if let Some(exit) = &run.plan.protective_exit {
                    let observation = entry_observation
                        .as_ref()
                        .ok_or("EXECUTION_EXIT_REQUIRED")?;
                    let arrival = run.arrival.as_ref().ok_or("EXECUTION_ARRIVAL_REQUIRED")?;
                    let cause = exit.verify(observation, arrival, execution_time(time)?)?;
                    value.exit_trigger = Some(ExitTrigger {
                        cause,
                        observation: observation.clone(),
                    });
                } else if let Some(trigger) = run
                    .plan
                    .entry_trigger
                    .as_ref()
                    .filter(|_| value.ordinal == 1)
                {
                    let observed = entry_observation
                        .as_ref()
                        .ok_or("EXECUTION_ENTRY_REQUIRED")?;
                    let arrival = run.arrival.as_ref().ok_or("EXECUTION_ARRIVAL_REQUIRED")?;
                    trigger.verify(observed, arrival, execution_time(time)?)?;
                    value.entry_observation = Some(observed.clone());
                } else {
                    check(entry_observation.is_none(), "EXECUTION_ENTRY_INVALID")?;
                }
                value.stage = Stage::Claimed;
                value.lease = Some(lease.clone());
                value.reason = "DISPATCH_RESERVED".into();
            }
            Change::Report { report, .. } => {
                let value = command.as_mut().ok_or("EXECUTION_COMMAND_NOT_PENDING")?;
                check(
                    value.id == report.command
                        && value.lease.as_ref() == Some(&report.lease)
                        && value.stage != Stage::Ready
                        && !value.stage.terminal()
                        && !matches!(report.stage, Stage::Ready | Stage::Claimed),
                    "EXECUTION_REPORT_CONFLICT",
                )?;
                check(
                    report.reason.len() <= 80
                        && report
                            .reason
                            .bytes()
                            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
                        && report.intent_ids.len() <= 4
                        && report.hashes.len() <= 4,
                    "INVALID_EXECUTION_REPORT",
                )?;
                for value in &report.intent_ids {
                    id(value)?;
                }
                for hash in &report.hashes {
                    check(
                        hash.len() == 66
                            && hash.starts_with("0x")
                            && hash[2..].bytes().all(|b| b.is_ascii_hexdigit()),
                        "INVALID_EXECUTION_REPORT",
                    )?;
                }
                if matches!(
                    report.stage,
                    Stage::Submitted | Stage::Included | Stage::Safe | Stage::Finalized
                ) {
                    check(
                        !report.hashes.is_empty() && !report.intent_ids.is_empty(),
                        "EXECUTION_PROOF_REQUIRED",
                    )?;
                }
                // Once a wallet transaction is known, subsequent reports cannot
                // erase its evidence or turn a possible broadcast into "unsent".
                check(
                    value
                        .intent_ids
                        .iter()
                        .all(|id| report.intent_ids.contains(id))
                        && value.hashes.iter().all(|hash| report.hashes.contains(hash))
                        && (report.stage != Stage::Unsent || value.hashes.is_empty()),
                    "EXECUTION_EVIDENCE_REGRESSED",
                )?;
                value.stage = report.stage;
                value.intent_ids = report.intent_ids.clone();
                value.hashes = report.hashes.clone();
                value.reason = report.reason.clone();
                if report.stage == Stage::Finalized {
                    let allocated = run
                        .allocated_input_atoms
                        .parse::<u128>()
                        .map_err(|_| "EXECUTION_AMOUNT_RANGE")?;
                    let input = value
                        .input_atoms
                        .parse::<u128>()
                        .map_err(|_| "EXECUTION_AMOUNT_RANGE")?;
                    let allocated = allocated
                        .checked_add(input)
                        .ok_or("EXECUTION_AMOUNT_RANGE")?;
                    check(allocated <= run.plan.total()?, "EXECUTION_BUDGET_EXCEEDED")?;
                    run.allocated_input_atoms = allocated.to_string();
                    run.completed_slices += 1;
                    run.pending = None;
                    if run.completed_slices == run.plan.slices {
                        run.phase = Phase::Completed;
                        run.reason = "COMPLETED".into();
                    }
                } else if matches!(
                    report.stage,
                    Stage::Uncertain | Stage::Unsent | Stage::Reverted | Stage::Aborted
                ) {
                    if report.stage.terminal() {
                        run.pending = None;
                    }
                    let expired_unsent = value.window.is_some()
                        && report.reason == WINDOW_EXPIRED
                        && matches!(report.stage, Stage::Unsent | Stage::Aborted);
                    if expired_unsent {
                        run.skip(value.ordinal - 1, value.ordinal)?;
                    } else if run.phase == Phase::Running {
                        run.phase = Phase::Paused;
                    }
                    run.reason = report.reason.clone();
                }
            }
            Change::Create { .. } => unreachable!(),
        }
        run.finish_windows();
        run.updated_at_ns = time.clone();
        if let Some(value) = command.as_mut() {
            value.updated_at_ns = time.clone();
        }
        Ok(Mutation { run, command })
    }
    pub(super) fn apply(&mut self, change: Change) -> Result<()> {
        let mutation = self.transition(&change)?;
        if let Some(command) = mutation.command {
            if !self.commands.contains_key(&command.id) {
                self.history.insert(
                    (command.run.clone(), mutation.run.commands_created),
                    command.id.clone(),
                );
            }
            self.commands.insert(command.id.clone(), command);
        }
        self.runs.insert(mutation.run.plan.id.clone(), mutation.run);
        Ok(())
    }
}
impl Ledger {
    fn execution_commit(&mut self, change: Change) -> Result<()> {
        self.state.executions_outbox.transition(&change)?;
        self.commit(Event::Execution { value: change })
    }
    pub fn execution_run(&self, id: &str) -> Option<&Run> {
        self.state.executions_outbox.runs.get(id)
    }
    pub fn execution_runs(&self) -> impl Iterator<Item = &Run> {
        self.state.executions_outbox.runs.values()
    }
    pub fn execution_command(&self, id: &str) -> Option<&Command> {
        self.state.executions_outbox.commands.get(id)
    }
    pub fn execution_history(&self, run: &str) -> Vec<&Command> {
        self.state
            .executions_outbox
            .history
            .range((run.into(), 0)..=(run.into(), u32::MAX))
            .filter_map(|(_, id)| self.execution_command(id))
            .collect()
    }
    pub fn execution_create(&mut self, plan: Plan) -> Result<Run> {
        if let Some(old) = self.execution_run(&plan.id) {
            check(old.plan == plan, "EXECUTION_PLAN_CONFLICT")?;
            return Ok(old.clone());
        }
        let id = plan.id.clone();
        self.execution_commit(Change::Create {
            plan: Box::new(plan),
            time: utc_ns(),
        })?;
        Ok(self.execution_run(&id).unwrap().clone())
    }
    pub fn execution_start(&mut self, run: &str, policy: &str) -> Result<Run> {
        self.execution_start_with_arrival(run, policy, None)
    }
    pub fn execution_start_with_arrival(
        &mut self,
        run: &str,
        policy: &str,
        arrival: Option<Arrival>,
    ) -> Result<Run> {
        check(!self.faulted, "LEDGER_RESTART_REQUIRED")?;
        if let Some(value) = self.execution_run(run)
            && value.phase == Phase::Running
            && value.policy_id.as_deref() == Some(policy)
        {
            check(
                arrival.is_none() || value.arrival == arrival,
                "EXECUTION_ARRIVAL_IMMUTABLE",
            )?;
            return Ok(value.clone());
        }
        self.execution_commit(Change::Start {
            run: run.into(),
            policy: policy.into(),
            time: utc_ns(),
            arrival,
        })?;
        Ok(self.execution_run(run).unwrap().clone())
    }
    pub fn execution_stop(&mut self, run: &str) -> Result<Run> {
        let old = self.execution_run(run).ok_or("EXECUTION_NOT_FOUND")?;
        if matches!(
            old.phase,
            Phase::Stopped | Phase::Completed | Phase::Expired
        ) {
            return Ok(old.clone());
        }
        self.execution_commit(Change::Stop {
            run: run.into(),
            time: utc_ns(),
        })?;
        Ok(self.execution_run(run).unwrap().clone())
    }
    pub fn execution_plan(&mut self, run: &str) -> Result<Command> {
        self.execution_plan_at(run, clock::now_ns())
    }
    pub fn execution_plan_at(&mut self, run: &str, now: u128) -> Result<Command> {
        self.execution_commit(Change::Plan {
            run: run.into(),
            time: now.to_string(),
        })?;
        Ok(self
            .execution_command(self.execution_run(run).unwrap().pending.as_ref().unwrap())
            .unwrap()
            .clone())
    }
    pub fn execution_skip_windows(&mut self, run: &str, now: u128) -> Result<()> {
        self.execution_commit(Change::SkipWindows {
            run: run.into(),
            time: now.to_string(),
        })
    }
    pub fn execution_skip_empty_window(&mut self, run: &str, now: u128) -> Result<()> {
        self.execution_commit(Change::SkipEmptyWindow {
            run: run.into(),
            time: now.to_string(),
        })
    }
    pub fn execution_claim(&mut self, command: &str, lease: &str) -> Result<Command> {
        self.execution_claim_at(command, lease, clock::now_ns(), None)
    }
    pub fn execution_claim_at(
        &mut self,
        command: &str,
        lease: &str,
        now: u128,
        entry_observation: Option<Arrival>,
    ) -> Result<Command> {
        check(!self.faulted, "LEDGER_RESTART_REQUIRED")?;
        let old = self
            .execution_command(command)
            .ok_or("EXECUTION_COMMAND_NOT_FOUND")?;
        let run = self.execution_run(&old.run).ok_or("EXECUTION_NOT_FOUND")?;
        if let Some(window) = &old.window {
            check(window.remaining(now)? > 0, WINDOW_EXPIRED)?;
        }
        if old.stage == Stage::Claimed
            && old.lease.as_deref() == Some(lease)
            && run.phase == Phase::Running
        {
            check(
                old.entry_observation.as_ref().or(old
                    .exit_trigger
                    .as_ref()
                    .map(|trigger| &trigger.observation))
                    == entry_observation.as_ref(),
                if old.exit_trigger.is_some() {
                    "EXECUTION_EXIT_INVALID"
                } else {
                    "EXECUTION_ENTRY_INVALID"
                },
            )?;
            return Ok(old.clone());
        }
        self.execution_commit(Change::Claim {
            command: command.into(),
            lease: lease.into(),
            time: now.to_string(),
            entry_observation,
        })?;
        Ok(self.execution_command(command).unwrap().clone())
    }
    pub fn execution_report(&mut self, report: Report) -> Result<Run> {
        let old = self
            .execution_command(&report.command)
            .ok_or("EXECUTION_COMMAND_NOT_FOUND")?;
        let run = old.run.clone();
        if old.lease.as_ref() == Some(&report.lease)
            && old.stage == report.stage
            && old.reason == report.reason
            && old.intent_ids == report.intent_ids
            && old.hashes == report.hashes
        {
            return Ok(self.execution_run(&run).unwrap().clone());
        }
        self.execution_commit(Change::Report {
            report,
            time: utc_ns(),
        })?;
        Ok(self.execution_run(&run).unwrap().clone())
    }
    pub fn recover_executions(&mut self) -> Result<()> {
        self.hold_executions("RECOVERY_PAUSED")
    }
    pub fn hold_executions(&mut self, reason: &str) -> Result<()> {
        let runs = self
            .execution_runs()
            .filter(|run| {
                run.phase == Phase::Running
                    || run
                        .pending
                        .as_ref()
                        .and_then(|id| self.execution_command(id))
                        .is_some_and(|c| c.stage == Stage::Claimed)
            })
            .map(|run| run.plan.id.clone())
            .collect::<Vec<_>>();
        for run in runs {
            self.execution_commit(Change::Recover {
                run,
                time: utc_ns(),
                reason: reason.into(),
            })?;
        }
        Ok(())
    }
}
