//! Wallet execution plans and outbox share the durable engine WAL. This module
//! owns allocated input budgets, not wallet balances, keys or broker authority.
use super::*;

#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AgentScope {
    pub id: String,
    pub subject: String,
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
        id(&self.id)?;
        id(&self.owner)?;
        id(&self.wallet)?;
        check(
            self.template == "base-twap-v1"
                && matches!(self.chain_id, 8453 | 84532)
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
        )
    }
    fn slice(&self, completed: u32) -> Result<String> {
        check(completed < self.slices, "EXECUTION_COMPLETE")?;
        let total = self.total()?;
        Ok((total / u128::from(self.slices)
            + u128::from(u128::from(completed) < total % u128::from(self.slices)))
        .to_string())
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Running,
    Paused,
    Stopped,
    Completed,
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
}
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Command {
    pub id: String,
    pub run: String,
    pub ordinal: u32,
    pub generation: u32,
    pub input_atoms: String,
    pub stage: Stage,
    pub lease: Option<String>,
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
        plan: Plan,
        time: String,
    },
    Start {
        run: String,
        policy: String,
        time: String,
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
    Claim {
        command: String,
        lease: String,
        time: String,
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
                        plan: plan.clone(),
                        phase: Phase::Paused,
                        reason: "CREATED".into(),
                        generation: 0,
                        completed_slices: 0,
                        allocated_input_atoms: "0".into(),
                        commands_created: 0,
                        pending: None,
                        policy_id: None,
                        updated_at_ns: time.clone(),
                    },
                    command: None,
                });
            }
            Change::Start { run, time, .. }
            | Change::Stop { run, time }
            | Change::Recover { run, time, .. }
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
            Change::Start { policy, .. } => {
                id(policy)?;
                check(
                    run.completed_slices < run.plan.slices
                        && run.pending.is_none()
                        && run.phase != Phase::Running
                        && run.generation < 1000,
                    "EXECUTION_CANNOT_START",
                )?;
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
                let ordinal = run.completed_slices + 1;
                let digest = fingerprint(&(&run.plan.id, ordinal, run.generation))?;
                let command_id = format!("live:{digest}");
                check(
                    !self.commands.contains_key(&command_id),
                    "EXECUTION_COMMAND_CONFLICT",
                )?;
                command = Some(Command {
                    id: command_id.clone(),
                    run: run.plan.id.clone(),
                    ordinal,
                    generation: run.generation,
                    input_atoms: run.plan.slice(run.completed_slices)?,
                    stage: Stage::Ready,
                    lease: None,
                    intent_ids: Vec::new(),
                    hashes: Vec::new(),
                    reason: "PLANNED".into(),
                    created_at_ns: time.clone(),
                    updated_at_ns: time.clone(),
                });
                run.pending = Some(command_id);
                run.commands_created += 1;
            }
            Change::Claim {
                command: id, lease, ..
            } => {
                super::id(lease)?;
                let value = command.as_mut().ok_or("EXECUTION_COMMAND_NOT_PENDING")?;
                check(
                    run.phase == Phase::Running && value.id == *id && value.stage == Stage::Ready,
                    "EXECUTION_COMMAND_ALREADY_CLAIMED",
                )?;
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
                    if run.phase == Phase::Running {
                        run.phase = Phase::Paused;
                    }
                    run.reason = report.reason.clone();
                }
            }
            Change::Create { .. } => unreachable!(),
        }
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
            plan,
            time: utc_ns(),
        })?;
        Ok(self.execution_run(&id).unwrap().clone())
    }
    pub fn execution_start(&mut self, run: &str, policy: &str) -> Result<Run> {
        check(!self.faulted, "LEDGER_RESTART_REQUIRED")?;
        if let Some(value) = self.execution_run(run)
            && value.phase == Phase::Running
            && value.policy_id.as_deref() == Some(policy)
        {
            return Ok(value.clone());
        }
        self.execution_commit(Change::Start {
            run: run.into(),
            policy: policy.into(),
            time: utc_ns(),
        })?;
        Ok(self.execution_run(run).unwrap().clone())
    }
    pub fn execution_stop(&mut self, run: &str) -> Result<Run> {
        let old = self.execution_run(run).ok_or("EXECUTION_NOT_FOUND")?;
        if matches!(old.phase, Phase::Stopped | Phase::Completed) {
            return Ok(old.clone());
        }
        self.execution_commit(Change::Stop {
            run: run.into(),
            time: utc_ns(),
        })?;
        Ok(self.execution_run(run).unwrap().clone())
    }
    pub fn execution_plan(&mut self, run: &str) -> Result<Command> {
        self.execution_commit(Change::Plan {
            run: run.into(),
            time: utc_ns(),
        })?;
        Ok(self
            .execution_command(self.execution_run(run).unwrap().pending.as_ref().unwrap())
            .unwrap()
            .clone())
    }
    pub fn execution_claim(&mut self, command: &str, lease: &str) -> Result<Command> {
        check(!self.faulted, "LEDGER_RESTART_REQUIRED")?;
        let old = self
            .execution_command(command)
            .ok_or("EXECUTION_COMMAND_NOT_FOUND")?;
        let run = self.execution_run(&old.run).ok_or("EXECUTION_NOT_FOUND")?;
        if old.stage == Stage::Claimed
            && old.lease.as_deref() == Some(lease)
            && run.phase == Phase::Running
        {
            return Ok(old.clone());
        }
        self.execution_commit(Change::Claim {
            command: command.into(),
            lease: lease.into(),
            time: utc_ns(),
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
