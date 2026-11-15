//! Monotonic TWAP scheduling. No networking, wallet secrets or per-tick LLM.
use crate::{
    clock,
    ledger::{
        Ledger,
        execution::{Arrival, Command, Phase, Report, Run, Stage},
    },
};
use std::collections::BTreeMap;
type Result<T> = std::result::Result<T, String>;
enum Timing {
    Settlement {
        due: u128,
    },
    Fixed {
        wall: u128,
        mono: u128,
        observed: u128,
    },
}
impl Timing {
    fn now(&mut self) -> u128 {
        match self {
            Self::Settlement { .. } => clock::now_ns(),
            Self::Fixed {
                wall,
                mono,
                observed,
            } => {
                *observed = (*observed)
                    .max(clock::now_ns())
                    .max(*wall + clock::mono_ns().saturating_sub(*mono));
                *observed
            }
        }
    }
}
#[derive(Default)]
pub struct ExecutionRunner {
    timing: BTreeMap<String, Timing>,
    pub generation: u64,
}
impl ExecutionRunner {
    pub fn hold_all(&mut self, ledger: &mut Ledger, reason: &str) -> Result<()> {
        self.timing.clear();
        self.generation = self.generation.saturating_add(1);
        ledger.hold_executions(reason)
    }
    pub fn start(&mut self, ledger: &mut Ledger, run: &str, policy: &str) -> Result<Run> {
        self.start_with_arrival(ledger, run, policy, None)
    }
    pub fn start_with_arrival(
        &mut self,
        ledger: &mut Ledger,
        run: &str,
        policy: &str,
        arrival: Option<Arrival>,
    ) -> Result<Run> {
        if !self.timing.contains_key(run) && self.timing.len() >= 16 {
            return Err("ACTIVE_EXECUTION_LIMIT".into());
        }
        let result = ledger.execution_start_with_arrival(run, policy, arrival)?;
        if !self.timing.contains_key(run) {
            let timing = if let Some(schedule) = &result.fixed {
                let wall = schedule
                    .observed_at_ns
                    .parse()
                    .map_err(|_| "INVALID_EXECUTION_TIME")?;
                Timing::Fixed {
                    wall,
                    mono: clock::mono_ns(),
                    observed: wall,
                }
            } else {
                Timing::Settlement {
                    due: clock::mono_ns(),
                }
            };
            self.timing.insert(run.into(), timing);
        }
        self.generation = self.generation.saturating_add(1);
        Ok(result)
    }
    pub fn stop(&mut self, ledger: &mut Ledger, run: &str) -> Result<Run> {
        let result = ledger.execution_stop(run)?;
        self.timing.remove(run);
        self.generation = self.generation.saturating_add(1);
        Ok(result)
    }
    pub fn report(&mut self, ledger: &mut Ledger, report: Report) -> Result<Run> {
        let was_pending = ledger
            .execution_command(&report.command)
            .and_then(|command| ledger.execution_run(&command.run))
            .is_some_and(|run| run.pending.as_deref() == Some(&report.command));
        let result = ledger.execution_report(report)?;
        if result.phase != Phase::Running {
            self.timing.remove(&result.plan.id);
        } else if was_pending
            && result.pending.is_none()
            && let Some(Timing::Settlement { due }) = self.timing.get_mut(&result.plan.id)
        {
            *due = clock::mono_ns() + result.plan.interval_ns();
        }
        self.generation = self.generation.saturating_add(1);
        Ok(result)
    }
    pub fn claim(
        &mut self,
        ledger: &mut Ledger,
        id: &str,
        lease: &str,
    ) -> Result<(Command, Option<u64>)> {
        let command = ledger
            .execution_command(id)
            .ok_or("EXECUTION_COMMAND_NOT_FOUND")?;
        let mut timing = self.timing.get_mut(&command.run);
        let now = timing
            .as_deref_mut()
            .map_or_else(clock::now_ns, Timing::now);
        let command = ledger.execution_claim_at(id, lease, now)?;
        let remaining = if let Some(window) = &command.window {
            let now = timing.map_or_else(clock::now_ns, Timing::now);
            Some((window.remaining(now)? / 1_000_000) as u64)
        } else {
            None
        };
        self.generation = self.generation.saturating_add(1);
        Ok((command, remaining))
    }
    pub fn drive(&mut self, ledger: &mut Ledger) -> Result<()> {
        let active = self.timing.keys().cloned().collect::<Vec<_>>();
        for id in active {
            let run = ledger.execution_run(&id).ok_or("EXECUTION_NOT_FOUND")?;
            if run.phase != Phase::Running {
                self.timing.remove(&id);
                continue;
            }
            let timing = self.timing.get_mut(&id).unwrap();
            match timing {
                Timing::Settlement { due } => {
                    if run.pending.is_none() && *due <= clock::mono_ns() {
                        ledger.execution_plan(&id)?;
                        self.generation = self.generation.saturating_add(1);
                    }
                }
                Timing::Fixed { .. } => {
                    let now = timing.now();
                    let closed = run.closed_windows(now)?;
                    let next = run
                        .fixed
                        .as_ref()
                        .ok_or("EXECUTION_WINDOW_REQUIRED")?
                        .next_slot;
                    let expired_ready = run
                        .pending
                        .as_ref()
                        .and_then(|id| ledger.execution_command(id))
                        .is_some_and(|command| {
                            command.stage == Stage::Ready && command.ordinal <= closed
                        });
                    if closed > next || expired_ready {
                        ledger.execution_skip_windows(&id, now)?;
                        self.generation = self.generation.saturating_add(1);
                    }
                    let run = ledger.execution_run(&id).ok_or("EXECUTION_NOT_FOUND")?;
                    if run.phase == Phase::Running
                        && run.pending.is_none()
                        && run.fixed.as_ref().is_some_and(|s| s.next_slot == closed)
                        && closed < run.plan.slices
                    {
                        if run.plan.range_input(closed, closed + 1)? == 0 {
                            ledger.execution_skip_empty_window(&id, now)?;
                        } else {
                            ledger.execution_plan_at(&id, now)?;
                        }
                        self.generation = self.generation.saturating_add(1);
                    }
                    if ledger
                        .execution_run(&id)
                        .is_some_and(|r| r.phase != Phase::Running)
                    {
                        self.timing.remove(&id);
                    }
                }
            }
        }
        Ok(())
    }
}
