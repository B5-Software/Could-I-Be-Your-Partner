use cibyp_quant_engine::{
    clock::ReplayClock,
    execution_runner::ExecutionRunner,
    ledger::{
        Ledger, Side,
        execution::{
            Arrival, Command, EntryRelation, EntryTrigger, ExitCause, Phase, Plan, ProtectiveExit,
            Report, Stage, VwapProfile,
        },
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
        max_arrival_cost_bps: None,
        entry_trigger: None,
        protective_exit: None,
        vwap: None,
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
        min_total_output_atoms: None,
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
        if total == "10" {
            definition.min_total_output_atoms = Some("11".into());
        }
        ledger.execution_create(definition).unwrap();
        runner.start(&mut ledger, "twap:test", "policy:1").unwrap();
        let mut sum = 0u128;
        for ordinal in 1..=3 {
            runner.drive(&mut ledger).unwrap();
            let command = pending(&ledger);
            assert_eq!(command.ordinal, ordinal);
            if total == "10" {
                assert_eq!(
                    command.min_output_atoms.as_deref(),
                    Some(if ordinal == 1 { "5" } else { "4" })
                );
            } else {
                assert!(
                    serde_json::to_value(&command)
                        .unwrap()
                        .get("min_output_atoms")
                        .is_none()
                );
            }
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
fn protected_plan_keeps_its_floor_and_exact_wide_product_after_reopening() {
    let (folder, mut ledger, mut runner) = fixture();
    let mut definition = plan();
    definition.slices = 1;
    definition.total_input_atoms = u128::MAX.to_string();
    definition.min_total_output_atoms = Some(u128::MAX.to_string());
    ledger.execution_create(definition.clone()).unwrap();
    let mut changed = definition.clone();
    changed.min_total_output_atoms = Some("1".into());
    assert!(ledger.execution_create(changed).is_err());
    runner
        .start(&mut ledger, &definition.id, "policy:1")
        .unwrap();
    runner.drive(&mut ledger).unwrap();
    let command = pending(&ledger);
    assert_eq!(command.min_output_atoms, definition.min_total_output_atoms);
    drop(ledger);
    let replay = Ledger::open(&folder.0, 8 * 1024 * 1024).unwrap();
    assert_eq!(
        replay.execution_run(&definition.id).unwrap().plan,
        definition
    );
    assert_eq!(
        replay
            .execution_command(&command.id)
            .unwrap()
            .min_output_atoms,
        command.min_output_atoms
    );
}
#[test]
fn fixed_windows_skip_missed_budget_without_sliding_after_finality() {
    let clock = ReplayClock::enter().unwrap();
    let start = 1_700_000_000_000_000_000;
    let second = 1_000_000_000;
    clock.advance(start, 0).unwrap();
    let (folder, mut ledger, mut runner) = fixture();
    let mut definition = plan();
    definition.template = "base-twap-fixed-v1".into();
    definition.slices = 4;
    definition.total_input_atoms = "11".into();
    definition.min_total_output_atoms = Some("10".into());
    let id = definition.id.clone();
    ledger.execution_create(definition).unwrap();
    runner.start(&mut ledger, &id, "policy:1").unwrap();
    runner.drive(&mut ledger).unwrap();
    let first = pending(&ledger);
    assert_eq!(first.ordinal, 1);
    assert_eq!(first.input_atoms, "3");
    let (first, remaining) = runner
        .claim(&mut ledger, &first.id, "lease:1", None)
        .unwrap();
    assert_eq!(remaining, Some(1000));
    runner
        .report(&mut ledger, report(&first, Stage::Submitted))
        .unwrap();

    // Finality has not arrived at the opening of the second slot.
    // Moving wall time backwards cannot reopen it.
    clock.advance(start - second, 2 * second).unwrap();
    runner.drive(&mut ledger).unwrap();
    let active = ledger.execution_run(&id).unwrap();
    assert_eq!(active.pending.as_deref(), Some(first.id.as_str()));
    assert_eq!(active.fixed.as_ref().unwrap().skipped_input_atoms, "3");
    runner
        .report(&mut ledger, report(&first, Stage::Finalized))
        .unwrap();
    runner.drive(&mut ledger).unwrap();
    let third = pending(&ledger);
    assert_eq!(third.ordinal, 3);
    assert_eq!(third.input_atoms, "3");
    assert_eq!(third.min_output_atoms.as_deref(), Some("3"));
    assert_eq!(
        third.window.as_ref().unwrap().closes_at_ns,
        (start + 3 * second).to_string()
    );

    clock.advance(start - second, 3 * second).unwrap();
    assert_eq!(
        runner
            .claim(&mut ledger, &third.id, "lease:late", None)
            .unwrap_err(),
        "EXECUTION_WINDOW_EXPIRED"
    );
    runner.drive(&mut ledger).unwrap();
    let fourth = pending(&ledger);
    assert_eq!(fourth.ordinal, 4);
    assert_eq!(fourth.input_atoms, "2");
    assert_eq!(
        ledger.execution_command(&third.id).unwrap().stage,
        Stage::Unsent
    );
    clock.advance(start + 4 * second, 4 * second).unwrap();
    runner.drive(&mut ledger).unwrap();
    let expired = ledger.execution_run(&id).unwrap().clone();
    assert_eq!(expired.phase, Phase::Expired);
    assert_eq!(expired.completed_slices, 1);
    assert_eq!(expired.allocated_input_atoms, "3");
    assert_eq!(expired.fixed.as_ref().unwrap().skipped_input_atoms, "8");
    assert!(runner.start(&mut ledger, &id, "policy:1").is_err());
    drop(ledger);
    let replay = Ledger::open(&folder.0, 8 * 1024 * 1024).unwrap();
    assert_eq!(replay.execution_run(&id).unwrap(), &expired);
}

#[test]
fn historical_vwap_conserves_input_and_skips_unfunded_windows() {
    let clock = ReplayClock::enter().unwrap();
    let start = 1_700_000_000_000_000_000;
    let second = 1_000_000_000;
    clock.advance(start, 0).unwrap();
    let (folder, mut ledger, mut runner) = fixture();
    let mut definition = plan();
    definition.template = "base-vwap-fixed-v1".into();
    definition.total_input_atoms = u128::MAX.to_string();
    definition.vwap = Some(VwapProfile {
        profile_id: "a".repeat(64),
        weth_volume_atoms: vec![(u128::MAX - 3).to_string(), "0".into(), "3".into()],
    });
    let id = definition.id.clone();
    ledger.execution_create(definition.clone()).unwrap();
    runner.start(&mut ledger, &id, "policy:1").unwrap();
    runner.drive(&mut ledger).unwrap();
    let first = pending(&ledger);
    assert_eq!(first.input_atoms, (u128::MAX - 3).to_string());
    let (first, _) = runner
        .claim(&mut ledger, &first.id, "lease:1", None)
        .unwrap();
    runner
        .report(&mut ledger, report(&first, Stage::Finalized))
        .unwrap();
    clock.advance(start + second, second).unwrap();
    runner.drive(&mut ledger).unwrap();
    let between = ledger.execution_run(&id).unwrap();
    assert_eq!(between.phase, Phase::Running);
    assert!(between.pending.is_none());
    assert_eq!(between.fixed.as_ref().unwrap().skipped_slices, 1);
    clock.advance(start + 2 * second, 2 * second).unwrap();
    runner.drive(&mut ledger).unwrap();
    let third = pending(&ledger);
    assert_eq!(third.ordinal, 3);
    assert_eq!(third.input_atoms, "3");
    let (third, _) = runner
        .claim(&mut ledger, &third.id, "lease:2", None)
        .unwrap();
    runner
        .report(&mut ledger, report(&third, Stage::Finalized))
        .unwrap();
    let run = ledger.execution_run(&id).unwrap().clone();
    assert_eq!(run.phase, Phase::Completed);
    assert_eq!(run.allocated_input_atoms, definition.total_input_atoms);
    assert_eq!(run.fixed.as_ref().unwrap().skipped_input_atoms, "0");
    assert_eq!(run.commands_created, 2);
    drop(ledger);
    let replay = Ledger::open(&folder.0, 8 * 1024 * 1024).unwrap();
    assert_eq!(replay.execution_run(&id).unwrap(), &run);
}

#[test]
fn arrival_price_is_bound_to_the_first_start_and_survives_restart() {
    let clock = ReplayClock::enter().unwrap();
    let second = 1_000_000_000;
    let start = 1_700_000_000;
    clock.advance(start * second, 0).unwrap();
    let (folder, mut ledger, mut runner) = fixture();
    let mut definition = plan();
    definition.max_arrival_cost_bps = Some(10_000);
    assert_eq!(
        ledger.execution_create(definition.clone()).unwrap_err(),
        "EXECUTION_ARRIVAL_LIMIT_RANGE",
    );
    definition.max_arrival_cost_bps = Some(0);
    let id = definition.id.clone();
    ledger.execution_create(definition).unwrap();
    assert_eq!(
        runner.start(&mut ledger, &id, "policy:1").unwrap_err(),
        "EXECUTION_ARRIVAL_REQUIRED",
    );
    let arrival = Arrival {
        pool: format!("0x{}", "1".repeat(40)),
        block: "12345".into(),
        block_hash: format!("0x{}", "2".repeat(64)),
        block_time: start as u64,
        sqrt_price_x96: "3520976558767282464819376".into(),
        weth_is_token0: true,
    };
    let mut stale = arrival.clone();
    stale.block_time -= 31;
    assert_eq!(
        runner
            .start_with_arrival(&mut ledger, &id, "policy:1", Some(stale))
            .unwrap_err(),
        "EXECUTION_ARRIVAL_INVALID",
    );
    assert_eq!(ledger.execution_run(&id).unwrap().generation, 0);
    runner
        .start_with_arrival(&mut ledger, &id, "policy:1", Some(arrival.clone()))
        .unwrap();
    runner.stop(&mut ledger, &id).unwrap();
    drop(ledger);
    let mut ledger = Ledger::open(&folder.0, 8 * 1024 * 1024).unwrap();
    let mut runner = ExecutionRunner::default();
    clock.advance((start + 60) * second, 60 * second).unwrap();
    let mut replacement = arrival.clone();
    replacement.block_time += 60;
    assert_eq!(
        runner
            .start_with_arrival(&mut ledger, &id, "policy:2", Some(replacement))
            .unwrap_err(),
        "EXECUTION_ARRIVAL_IMMUTABLE",
    );
    assert_eq!(
        runner.start(&mut ledger, &id, "policy:2").unwrap().arrival,
        Some(arrival)
    );
}

#[test]
fn entry_claim_requires_a_fresh_same_pool_price_and_keeps_the_exact_boundary() {
    use ethnum::U256;
    let clock = ReplayClock::enter().unwrap();
    let start = 1_700_000_000u128;
    clock.advance(start * 1_000_000_000, 0).unwrap();
    for weth_is_token0 in [true, false] {
        let (folder, mut ledger, mut runner) = fixture();
        let boundary = U256::ONE << if weth_is_token0 { 95u32 } else { 97u32 };
        let above = if weth_is_token0 {
            boundary + U256::ONE
        } else {
            boundary - U256::ONE
        };
        let mut definition = plan();
        definition.entry_trigger = Some(EntryTrigger {
            relation: EntryRelation::AtOrBelow,
            price_atoms: "250000000000000000".into(),
        });
        let mut incompatible = definition.clone();
        incompatible.template = "base-twap-fixed-v1".into();
        assert_eq!(
            ledger.execution_create(incompatible).unwrap_err(),
            "EXECUTION_ENTRY_INVALID"
        );
        let id = definition.id.clone();
        ledger.execution_create(definition.clone()).unwrap();
        let at_threshold = Arrival {
            pool: format!("0x{}", "1".repeat(40)),
            block: "12345".into(),
            block_hash: format!("0x{}", "2".repeat(64)),
            block_time: start as u64,
            sqrt_price_x96: boundary.to_string(),
            weth_is_token0,
        };
        let mut before = at_threshold.clone();
        before.sqrt_price_x96 = above.to_string();
        runner
            .start_with_arrival(&mut ledger, &id, "policy:1", Some(before.clone()))
            .unwrap();
        runner.drive(&mut ledger).unwrap();
        let first = pending(&ledger);
        let mut stale = at_threshold.clone();
        stale.block_time -= 31;
        let mut other_pool = at_threshold.clone();
        other_pool.pool = format!("0x{}", "3".repeat(40));
        let length = fs::metadata(folder.0.join("events.jsonl")).unwrap().len();
        for (evidence, reason) in [
            (None, "EXECUTION_ENTRY_REQUIRED"),
            (Some(stale), "EXECUTION_ENTRY_UNAVAILABLE"),
            (Some(other_pool), "EXECUTION_ENTRY_UNAVAILABLE"),
            (Some(before), "EXECUTION_ENTRY_WAIT"),
        ] {
            assert_eq!(
                runner
                    .claim(&mut ledger, &first.id, "lease:1", evidence)
                    .unwrap_err(),
                reason
            );
            assert_eq!(pending(&ledger), first);
        }
        assert_eq!(
            fs::metadata(folder.0.join("events.jsonl")).unwrap().len(),
            length
        );
        let (claimed, _) = runner
            .claim(
                &mut ledger,
                &first.id,
                "lease:1",
                Some(at_threshold.clone()),
            )
            .unwrap();
        assert_eq!(claimed.entry_observation, Some(at_threshold.clone()));
        assert_eq!(claimed.stage, Stage::Claimed);
        assert!(
            runner
                .claim(&mut ledger, &first.id, "lease:1", None)
                .is_err()
        );
        drop(ledger);
        let mut reloaded = Ledger::open(&folder.0, 8 * 1024 * 1024).unwrap();
        reloaded.recover_executions().unwrap();
        assert_eq!(reloaded.execution_run(&id).unwrap().plan, definition);
        assert_eq!(
            reloaded
                .execution_command(&first.id)
                .unwrap()
                .entry_observation,
            Some(at_threshold)
        );
    }
}

#[test]
fn protective_exit_claims_exactly_one_sell_and_persists_its_cause() {
    use ethnum::U256;
    let clock = ReplayClock::enter().unwrap();
    let start = 1_700_000_000u128;
    clock.advance(start * 1_000_000_000, 0).unwrap();
    let stop_price = U256::ONE << 94u32;
    let profit_price = U256::ONE << 95u32;
    for (cause, observed_price, opposite) in [
        (ExitCause::StopLoss, stop_price, profit_price),
        (ExitCause::TakeProfit, profit_price, stop_price),
    ] {
        let (folder, mut ledger, mut runner) = fixture();
        let mut definition = plan();
        definition.protective_exit = Some(ProtectiveExit {
            stop_loss_price_atoms: "62500000000000000".into(),
            take_profit_price_atoms: Some("250000000000000000".into()),
        });
        assert_eq!(
            ledger.execution_create(definition.clone()).unwrap_err(),
            "EXECUTION_EXIT_INVALID"
        );
        definition.side = Side::Sell;
        definition.slices = 1;
        let mut invalid = definition.clone();
        let thresholds = invalid.protective_exit.as_mut().unwrap();
        thresholds.take_profit_price_atoms = Some(thresholds.stop_loss_price_atoms.clone());
        assert_eq!(
            ledger.execution_create(invalid).unwrap_err(),
            "EXECUTION_EXIT_INVALID"
        );
        let id = definition.id.clone();
        ledger.execution_create(definition.clone()).unwrap();
        let middle = Arrival {
            pool: format!("0x{}", "1".repeat(40)),
            block: "12345".into(),
            block_hash: format!("0x{}", "2".repeat(64)),
            block_time: start as u64,
            sqrt_price_x96: (stop_price + (U256::ONE << 93u32)).to_string(),
            weth_is_token0: true,
        };
        assert!(runner.start(&mut ledger, &id, "policy:1").is_err());
        runner
            .start_with_arrival(&mut ledger, &id, "policy:1", Some(middle.clone()))
            .unwrap();
        runner.drive(&mut ledger).unwrap();
        let command = pending(&ledger);
        assert_eq!(
            runner
                .claim(&mut ledger, &command.id, "lease:1", Some(middle.clone()))
                .unwrap_err(),
            "EXECUTION_EXIT_WAIT"
        );
        let mut observed = middle.clone();
        observed.sqrt_price_x96 = observed_price.to_string();
        let mut other = middle;
        other.sqrt_price_x96 = opposite.to_string();
        let (claimed, _) = runner
            .claim(&mut ledger, &command.id, "lease:1", Some(observed.clone()))
            .unwrap();
        let receipt = claimed.exit_trigger.as_ref().unwrap();
        assert_eq!(receipt.cause, cause);
        assert_eq!(receipt.observation, observed);
        assert_eq!(
            runner
                .claim(&mut ledger, &command.id, "lease:1", Some(other.clone()))
                .unwrap_err(),
            "EXECUTION_EXIT_INVALID"
        );
        assert!(
            runner
                .claim(&mut ledger, &command.id, "lease:other", Some(other))
                .is_err()
        );
        runner
            .report(&mut ledger, report(&claimed, Stage::Finalized))
            .unwrap();
        drop(ledger);
        let mut ledger = Ledger::open(&folder.0, 8 * 1024 * 1024).unwrap();
        ledger.recover_executions().unwrap();
        let run = ledger.execution_run(&id).unwrap();
        assert_eq!(run.phase, Phase::Completed);
        assert_eq!(run.completed_slices, 1);
        assert_eq!(ledger.execution_history(&id).len(), 1);
        assert_eq!(
            ledger
                .execution_command(&command.id)
                .unwrap()
                .exit_trigger
                .as_ref(),
            Some(receipt)
        );
    }
}

#[test]
fn fixed_window_recovery_keeps_the_original_anchor_and_requires_an_explicit_start() {
    let clock = ReplayClock::enter().unwrap();
    let start = 1_700_000_000_000_000_000;
    let second = 1_000_000_000;
    clock.advance(start, 0).unwrap();
    let (folder, mut ledger, mut runner) = fixture();
    let mut definition = plan();
    definition.template = "base-twap-fixed-v1".into();
    let id = definition.id.clone();
    ledger.execution_create(definition).unwrap();
    runner.start(&mut ledger, &id, "policy:1").unwrap();
    runner.drive(&mut ledger).unwrap();
    let first = pending(&ledger);
    drop(ledger);
    let mut ledger = Ledger::open(&folder.0, 8 * 1024 * 1024).unwrap();
    ledger.recover_executions().unwrap();
    let mut runner = ExecutionRunner::default();
    clock.advance(start + 2 * second, 2 * second).unwrap();
    runner.drive(&mut ledger).unwrap();
    assert_eq!(ledger.execution_run(&id).unwrap().phase, Phase::Paused);
    assert_eq!(ledger.execution_history(&id).len(), 1);
    assert_eq!(
        ledger.execution_command(&first.id).unwrap().stage,
        Stage::Unsent
    );
    clock.advance(start - second, 2 * second).unwrap();
    assert_eq!(
        runner.start(&mut ledger, &id, "policy:2").unwrap_err(),
        "EXECUTION_CLOCK_REGRESSED"
    );
    clock.advance(start + 2 * second, 2 * second).unwrap();
    runner.start(&mut ledger, &id, "policy:2").unwrap();
    runner.drive(&mut ledger).unwrap();
    let third = pending(&ledger);
    assert_eq!(third.ordinal, 3);
    let fixed = ledger.execution_run(&id).unwrap().fixed.as_ref().unwrap();
    assert_eq!(fixed.start_at_ns, start.to_string());
    assert_eq!(fixed.skipped_slices, 2);
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
