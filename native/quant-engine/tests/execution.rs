use cibyp_quant_engine::{
    clock::ReplayClock,
    execution_runner::ExecutionRunner,
    ledger::{
        Ledger, Side,
        execution::{Command, Phase, Plan, Report, Stage},
    },
};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
struct Folder(PathBuf);
impl Drop for Folder {
    fn drop(&mut self) {
        let temp = std::env::temp_dir().canonicalize().unwrap();
        assert_eq!(self.0.parent(), Some(temp.as_path()));
        assert!(
            self.0
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("cibyp-execution-")
        );
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn fixture() -> (Folder, Ledger, ExecutionRunner) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir().canonicalize().unwrap().join(format!(
        "cibyp-execution-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let ledger = Ledger::open(&path, 8 * 1024 * 1024).unwrap();
    (Folder(path), ledger, ExecutionRunner::default())
}
fn plan() -> Plan {
    Plan {
        agent_scope: None,
        template: "base-twap-v1".into(),
        id: "twap:test".into(),
        owner: "workspace:test".into(),
        wallet: "wallet:test".into(),
        chain_id: 8453,
        side: Side::Buy,
        total_input_atoms: "10".into(),
        slices: 3,
        interval_ms: 1000,
        slippage_bps: 50,
        pool_fee: 500,
        config_hash: "a".repeat(64),
        max_fee_reserve_wei: Some("10000000000000000".into()),
    }
}
fn pending(ledger: &Ledger) -> Command {
    ledger
        .execution_command(
            ledger
                .execution_run("twap:test")
                .unwrap()
                .pending
                .as_ref()
                .unwrap(),
        )
        .unwrap()
        .clone()
}
fn report(command: &Command, stage: Stage) -> Report {
    Report {
        command: command.id.clone(),
        lease: command.lease.clone().unwrap(),
        stage,
        intent_ids: vec![format!("intent:{}", command.ordinal)],
        hashes: vec![format!("0x{:064x}", command.ordinal)],
        reason: "CHAIN_RESULT".into(),
    }
}
#[test]
fn exact_budget_slices_and_finality_gate_no_catchup_or_duplicate_postponement() {
    for total in ["10", "10000003", "340282366920938463463374607431768211455"] {
        let clock = ReplayClock::enter().unwrap();
        clock.advance(1000000000000, 0).unwrap();
        let (_folder, mut ledger, mut runner) = fixture();
        let mut definition = plan();
        definition.total_input_atoms = total.into();
        ledger.execution_create(definition).unwrap();
        runner.start(&mut ledger, "twap:test", "policy:1").unwrap();
        let mut sum = 0u128;
        for ordinal in 1..=3 {
            runner.drive(&mut ledger).unwrap();
            let command = pending(&ledger);
            assert_eq!(command.ordinal, ordinal);
            sum += command.input_atoms.parse::<u128>().unwrap();
            let claimed = ledger.execution_claim(&command.id, "lease:1").unwrap();
            runner
                .report(&mut ledger, report(&claimed, Stage::Included))
                .unwrap();
            runner
                .report(&mut ledger, report(&claimed, Stage::Safe))
                .unwrap();
            assert_eq!(
                ledger.execution_run("twap:test").unwrap().completed_slices,
                ordinal - 1
            );
            runner.drive(&mut ledger).unwrap();
            assert_eq!(
                ledger.execution_history("twap:test").len(),
                ordinal as usize
            );
            let finality = report(&claimed, Stage::Finalized);
            runner.report(&mut ledger, finality.clone()).unwrap();
            let mono = ordinal as u128 * 1000000000;
            clock.advance(0, mono - 1).unwrap(); // Wall-clock rollback cannot advance the schedule.
            runner.report(&mut ledger, finality).unwrap(); // Duplicate cannot reset the interval.
            runner.drive(&mut ledger).unwrap();
            assert!(ledger.execution_run("twap:test").unwrap().pending.is_none());
            clock.advance(0, mono).unwrap();
        }
        assert_eq!(sum, total.parse::<u128>().unwrap());
        let run = ledger.execution_run("twap:test").unwrap();
        assert_eq!(run.allocated_input_atoms, total);
        assert_eq!(run.phase, Phase::Completed);
        assert!(runner.start(&mut ledger, "twap:test", "policy:1").is_err());
        clock.advance(0, 100000000000000).unwrap();
        runner.drive(&mut ledger).unwrap();
        assert_eq!(ledger.execution_history("twap:test").len(), 3);
    }
}
#[test]
fn claim_leases_stop_races_and_late_reports_preserve_financial_evidence() {
    let (_folder, mut ledger, mut runner) = fixture();
    ledger.execution_create(plan()).unwrap();
    runner.start(&mut ledger, "twap:test", "policy:1").unwrap();
    runner.drive(&mut ledger).unwrap();
    let command = pending(&ledger);
    let first = ledger.execution_claim(&command.id, "lease:a").unwrap();
    assert_eq!(
        ledger.execution_claim(&command.id, "lease:a").unwrap(),
        first
    );
    assert!(ledger.execution_claim(&command.id, "lease:b").is_err());
    runner.stop(&mut ledger, "twap:test").unwrap();
    assert_eq!(pending(&ledger).stage, Stage::Uncertain);
    assert!(ledger.execution_claim(&command.id, "lease:a").is_err());
    assert!(
        runner
            .start(&mut ledger, "twap:test", "policy:new")
            .is_err()
    );
    runner
        .report(&mut ledger, report(&first, Stage::Submitted))
        .unwrap();
    assert_eq!(
        ledger.execution_run("twap:test").unwrap().phase,
        Phase::Stopped
    );
    let mut erased = report(&first, Stage::Unsent);
    erased.hashes.clear();
    assert!(runner.report(&mut ledger, erased).is_err());
    runner
        .report(&mut ledger, report(&first, Stage::Finalized))
        .unwrap();
    assert_eq!(
        ledger.execution_run("twap:test").unwrap().phase,
        Phase::Stopped
    );
    assert_eq!(
        ledger
            .execution_run("twap:test")
            .unwrap()
            .allocated_input_atoms,
        "4"
    );
    runner
        .start(&mut ledger, "twap:test", "policy:new")
        .unwrap();
    runner.drive(&mut ledger).unwrap();
    assert_eq!(pending(&ledger).input_atoms, "3");
}
#[test]
fn only_unclaimed_commands_can_be_cancelled_without_an_unknown_outcome() {
    let (_folder, mut ledger, mut runner) = fixture();
    ledger.execution_create(plan()).unwrap();
    runner.start(&mut ledger, "twap:test", "policy:1").unwrap();
    runner.drive(&mut ledger).unwrap();
    let first = pending(&ledger);
    runner.stop(&mut ledger, "twap:test").unwrap();
    assert_eq!(
        ledger.execution_command(&first.id).unwrap().stage,
        Stage::Unsent
    );
    assert!(ledger.execution_claim(&first.id, "lease:late").is_err());
    runner.start(&mut ledger, "twap:test", "policy:2").unwrap();
    runner.drive(&mut ledger).unwrap();
    let next = pending(&ledger);
    assert_ne!(first.id, next.id);
    assert_eq!(first.ordinal, next.ordinal);
    assert_eq!(first.input_atoms, next.input_atoms);
    assert_eq!(next.generation, 2);
}
#[test]
fn unresolved_wallet_allocations_block_other_runs_and_recovery_never_dispatches() {
    let (folder, mut ledger, mut runner) = fixture();
    let definition = plan();
    ledger.execution_create(definition.clone()).unwrap();
    let mut other = definition.clone();
    other.id = "twap:other".into();
    other.owner = "workspace:other".into();
    ledger.execution_create(other).unwrap();
    runner.start(&mut ledger, "twap:test", "policy:1").unwrap();
    assert!(runner.start(&mut ledger, "twap:other", "policy:1").is_err());
    runner.drive(&mut ledger).unwrap();
    let command = ledger
        .execution_claim(&pending(&ledger).id, "lease:original")
        .unwrap();
    drop(ledger);
    let mut recovered = Ledger::open(&folder.0, 8 * 1024 * 1024).unwrap();
    recovered.recover_executions().unwrap();
    assert_eq!(pending(&recovered).stage, Stage::Uncertain);
    assert_eq!(
        recovered.execution_run("twap:test").unwrap().phase,
        Phase::Paused
    );
    assert!(recovered.execution_start("twap:other", "policy:1").is_err());
    ExecutionRunner::default().drive(&mut recovered).unwrap();
    assert_eq!(recovered.execution_history("twap:test").len(), 1);
    recovered
        .execution_report(report(&command, Stage::Finalized))
        .unwrap();
    assert_eq!(
        recovered.execution_run("twap:test").unwrap().phase,
        Phase::Paused
    );
    assert!(recovered.execution_start("twap:other", "policy:1").is_ok());
}
#[test]
fn recovery_abandons_only_provably_undispatched_plans_and_keeps_history() {
    let (folder, mut ledger, mut runner) = fixture();
    ledger.execution_create(plan()).unwrap();
    runner.start(&mut ledger, "twap:test", "policy:1").unwrap();
    runner.drive(&mut ledger).unwrap();
    let ready = pending(&ledger);
    drop(ledger);
    let mut recovered = Ledger::open(&folder.0, 8 * 1024 * 1024).unwrap();
    recovered.recover_executions().unwrap();
    assert_eq!(
        recovered.execution_command(&ready.id).unwrap().stage,
        Stage::Unsent
    );
    assert_eq!(
        recovered.execution_run("twap:test").unwrap().phase,
        Phase::Paused
    );
    assert!(
        recovered
            .execution_run("twap:test")
            .unwrap()
            .pending
            .is_none()
    );
    recovered.execution_start("twap:test", "policy:2").unwrap();
    let next = recovered.execution_plan("twap:test").unwrap();
    assert_ne!(next.id, ready.id);
    assert_eq!(next.input_atoms, ready.input_atoms);
}
#[test]
fn immutable_plans_strict_receipts_and_idempotent_terminal_reports() {
    let (folder, mut ledger, mut runner) = fixture();
    let definition = plan();
    ledger.execution_create(definition.clone()).unwrap();
    let mut conflict = definition.clone();
    conflict.total_input_atoms = "11".into();
    assert!(ledger.execution_create(conflict).is_err());
    let before = fs::metadata(folder.0.join("events.jsonl")).unwrap().len();
    ledger.execution_create(definition).unwrap();
    assert_eq!(
        fs::metadata(folder.0.join("events.jsonl")).unwrap().len(),
        before
    );
    runner.start(&mut ledger, "twap:test", "policy:1").unwrap();
    runner.drive(&mut ledger).unwrap();
    let command = ledger
        .execution_claim(&pending(&ledger).id, "lease:1")
        .unwrap();
    let valid = report(&command, Stage::Finalized);
    for case in 0..3 {
        let mut invalid = valid.clone();
        match case {
            0 => invalid.hashes.clear(),
            1 => invalid.intent_ids.clear(),
            _ => invalid.reason = "untrusted free text".into(),
        }
        assert!(ledger.execution_report(invalid).is_err());
    }
    let mut invalid = valid.clone();
    invalid.lease = "lease:other".into();
    assert!(ledger.execution_report(invalid).is_err());
    ledger.execution_report(valid.clone()).unwrap();
    let before = fs::metadata(folder.0.join("events.jsonl")).unwrap().len();
    ledger.execution_report(valid).unwrap();
    assert_eq!(
        fs::metadata(folder.0.join("events.jsonl")).unwrap().len(),
        before
    );
    assert_eq!(
        ledger.execution_run("twap:test").unwrap().completed_slices,
        1
    );
}

#[test]
fn agent_scope_is_immutable_and_survives_durable_recovery() {
    use cibyp_quant_engine::ledger::execution::AgentScope;
    let (folder, mut ledger, _) = fixture();
    let mut definition = plan();
    assert!(
        !serde_json::to_value(&definition)
            .unwrap()
            .as_object()
            .unwrap()
            .contains_key("agent_scope")
    );
    definition.agent_scope = Some(AgentScope {
        id: "a".repeat(64),
        subject: "native-sub-fixture".into(),
    });
    ledger.execution_create(definition.clone()).unwrap();
    let mut conflict = definition.clone();
    conflict.agent_scope = None;
    assert!(ledger.execution_create(conflict).is_err());
    drop(ledger);
    let ledger = Ledger::open(&folder.0, 8 * 1024 * 1024).unwrap();
    assert_eq!(
        ledger.execution_run(&definition.id).unwrap().plan,
        definition
    );
}
#[test]
fn malformed_limits_never_create_plans() {
    let (_folder, mut ledger, _runner) = fixture();
    for case in 0..8 {
        let mut p = plan();
        match case {
            0 => p.total_input_atoms = "00010".into(),
            1 => p.total_input_atoms = "0".into(),
            2 => p.slices = 1001,
            3 => p.slices = 11,
            4 => p.interval_ms = 999,
            5 => p.chain_id = 1,
            6 => p.slippage_bps = 501,
            _ => p.config_hash = "z".repeat(64),
        }
        assert!(ledger.execution_create(p).is_err());
    }
    assert_eq!(ledger.execution_runs().count(), 0);
}
#[test]
fn failed_durable_start_or_claim_cannot_create_a_dispatch_reservation() {
    let (folder, mut ledger, _runner) = fixture();
    ledger.execution_create(plan()).unwrap();
    let length = fs::metadata(folder.0.join("events.jsonl")).unwrap().len();
    drop(ledger);
    let mut limited = Ledger::open(&folder.0, length + 16).unwrap();
    assert!(
        ExecutionRunner::default()
            .start(&mut limited, "twap:test", "policy:1")
            .is_err()
    );
    assert_eq!(
        limited.execution_run("twap:test").unwrap().phase,
        Phase::Paused
    );
    assert!(limited.faulted());
    assert_eq!(
        fs::metadata(folder.0.join("events.jsonl")).unwrap().len(),
        length
    );
    drop(limited);
    let mut normal = Ledger::open(&folder.0, 8 * 1024 * 1024).unwrap();
    normal.execution_start("twap:test", "policy:1").unwrap();
    let command = normal.execution_plan("twap:test").unwrap();
    let length = fs::metadata(folder.0.join("events.jsonl")).unwrap().len();
    drop(normal);
    let mut limited = Ledger::open(&folder.0, length + 16).unwrap();
    assert!(limited.execution_claim(&command.id, "lease:1").is_err());
    assert_eq!(
        limited.execution_command(&command.id).unwrap().stage,
        Stage::Ready
    );
}
