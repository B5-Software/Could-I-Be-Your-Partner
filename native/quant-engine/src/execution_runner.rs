//! Monotonic TWAP scheduling. No networking, wallet secrets or per-tick LLM.
use crate::{
    clock,
    ledger::{
        Ledger,
        execution::{Phase, Run},
    },
};
use std::collections::BTreeMap;
type Result<T> = std::result::Result<T, String>;
#[derive(Default)]
pub struct ExecutionRunner {
    due: BTreeMap<String, u128>,
    pub generation: u64,
}
impl ExecutionRunner {
    pub fn hold_all(&mut self, ledger: &mut Ledger, reason: &str) -> Result<()> {
        self.due.clear();
        self.generation = self.generation.saturating_add(1);
        ledger.hold_executions(reason)
    }
    pub fn start(&mut self, ledger: &mut Ledger, run: &str, policy: &str) -> Result<Run> {
        if !self.due.contains_key(run) && self.due.len() >= 16 {
            return Err("ACTIVE_EXECUTION_LIMIT".into());
        }
        let result = ledger.execution_start(run, policy)?;
        self.due.entry(run.into()).or_insert_with(clock::mono_ns);
        self.generation = self.generation.saturating_add(1);
        Ok(result)
    }
    pub fn stop(&mut self, ledger: &mut Ledger, run: &str) -> Result<Run> {
        let result = ledger.execution_stop(run)?;
        self.due.remove(run);
        self.generation = self.generation.saturating_add(1);
        Ok(result)
    }
    pub fn report(
        &mut self,
        ledger: &mut Ledger,
        report: crate::ledger::execution::Report,
    ) -> Result<Run> {
        let was_pending = ledger
            .execution_command(&report.command)
            .and_then(|command| ledger.execution_run(&command.run))
            .is_some_and(|run| run.pending.as_deref() == Some(&report.command));
        let result = ledger.execution_report(report)?;
        if result.phase != Phase::Running {
            self.due.remove(&result.plan.id);
        } else if was_pending && result.pending.is_none() {
            // No catch-up burst: the next interval starts after settlement.
            self.due.insert(
                result.plan.id.clone(),
                clock::mono_ns() + u128::from(result.plan.interval_ms) * 1_000_000,
            );
        }
        self.generation = self.generation.saturating_add(1);
        Ok(result)
    }
    pub fn drive(&mut self, ledger: &mut Ledger) -> Result<()> {
        let now = clock::mono_ns();
        let active = self.due.keys().cloned().collect::<Vec<_>>();
        for id in active {
            let run = ledger.execution_run(&id).ok_or("EXECUTION_NOT_FOUND")?;
            if run.phase != Phase::Running {
                self.due.remove(&id);
            } else if run.pending.is_none() && self.due[&id] <= now {
                ledger.execution_plan(&id)?;
                self.generation = self.generation.saturating_add(1);
            }
        }
        Ok(())
    }
}
