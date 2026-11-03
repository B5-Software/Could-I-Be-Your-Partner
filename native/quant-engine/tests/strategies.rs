use cibyp_quant_engine::{
    book::{Book, Side as BookSide},
    decimal::Fixed,
    ledger::{Instrument, Ledger, Risk},
    matching::{Matcher, Trade, now_ns},
    strategy::{Definition, Maker, Mode, Phase, Run, Sides},
    strategy_runner::Runner,
};
use std::{
    collections::BTreeMap,
    fs,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
fn n(v: &str) -> Fixed {
    v.to_string().try_into().unwrap()
}
fn definition() -> Definition {
    Definition {
        id: "strategy:test".into(),
        owner: "workspace:test".into(),
        name: "Maker".into(),
        revision: 1,
        account: "paper".into(),
        instrument: "ETH-USD".into(),
        maker: Maker {
            quantity: n("0.5"),
            sides: Sides::Both,
            bid_offset_ticks: 0,
            ask_offset_ticks: 0,
            reprice_ticks: 1,
            refresh_ms: 100,
            ttl_ms: 1000,
            min_inventory: n("0"),
            max_inventory: n("10"),
            max_notional: n("1000"),
            max_fees: n("5"),
            max_decisions: 100,
        },
    }
}
fn book() -> Book {
    let mut b = Book::default();
    b.snapshot(
        "epoch".into(),
        1,
        vec![[n("99"), n("1")]],
        vec![[n("101"), n("1")]],
    )
    .unwrap();
    b
}
fn fixture(test: impl FnOnce(Ledger, BTreeMap<String, Book>, Matcher, Runner, &std::path::Path)) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let temp = std::env::temp_dir().canonicalize().unwrap();
    let path = temp.join(format!(
        "cibyp-strategies-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let mut ledger = Ledger::open(&path, 8 * 1024 * 1024).unwrap();
    ledger
        .instrument(Instrument {
            id: "ETH-USD".into(),
            base: "ETH".into(),
            quote: "USD".into(),
            tick: n("1"),
            lot: n("0.1"),
            min_notional: n("1"),
            fee_bps: 10,
        })
        .unwrap();
    ledger
        .account(
            "paper".into(),
            Risk {
                max_open_orders: 10,
                max_order_notional: BTreeMap::from([("USD".into(), n("1000"))]),
                max_asset_position: BTreeMap::from([("ETH".into(), n("10"))]),
            },
            BTreeMap::from([("USD".into(), n("10000")), ("ETH".into(), n("3"))]),
        )
        .unwrap();
    ledger.enable().unwrap();
    test(
        ledger,
        BTreeMap::from([("ETH-USD".into(), book())]),
        Matcher::default(),
        Runner::default(),
        &path,
    );
    assert_eq!(path.parent(), Some(temp.as_path()));
    assert!(
        path.file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("cibyp-strategies-")
    );
    fs::remove_dir_all(path).unwrap();
}
fn start(r: &mut Runner, l: &mut Ledger, b: &BTreeMap<String, Book>, id: &str, mode: Mode) {
    r.start(l, b, id.into(), "strategy:test".into(), 1, mode)
        .unwrap();
}
#[test]
fn immutable_revisions_and_shadow_decisions_have_no_orders_or_funds() {
    fixture(|mut l, b, mut m, mut r, _| {
        let d = definition();
        l.define_strategy(d.clone()).unwrap();
        l.define_strategy(d.clone()).unwrap();
        let mut conflicting = d.clone();
        conflicting.name = "Altered".into();
        assert!(l.define_strategy(conflicting).is_err());
        start(&mut r, &mut l, &b, "shadow", Mode::Shadow);
        r.drive(&mut l, &b, &mut m);
        assert_eq!(l.orders().count(), 0);
        assert_eq!(l.balance("paper", "USD").reserved, n("0"));
        let decision = l.strategy_decisions("shadow").next().unwrap().clone();
        assert_eq!(decision.outcomes.len(), 2);
        assert!(decision.outcomes.iter().all(|o| o.status == "shadow"));
        assert_eq!(
            l.submit(
                decision.intents[0].clone(),
                "ETH-USD",
                b.get("ETH-USD").unwrap(),
                1000
            )
            .err()
            .unwrap(),
            "SHADOW_ORDER_FORBIDDEN"
        );
        let mut v2 = d;
        v2.revision = 2;
        v2.maker.quantity = n("0.1");
        l.define_strategy(v2).unwrap();
        assert_eq!(l.strategy_run("shadow").unwrap().revision, 1);
        assert_eq!(l.strategy_stats("shadow").unwrap().orders, 0);
    });
}
#[test]
fn native_partial_fills_update_run_budgets_in_the_same_ledger() {
    fixture(|mut l, mut b, mut m, mut r, path| {
        l.define_strategy(definition()).unwrap();
        start(&mut r, &mut l, &b, "paper-run", Mode::Paper);
        r.drive(&mut l, &b, &mut m);
        assert_eq!(l.orders().count(), 2);
        assert_eq!(
            l.strategy_stats("paper-run").unwrap().open_notional,
            n("100")
        );
        std::thread::sleep(Duration::from_millis(550));
        b.get_mut("ETH-USD")
            .unwrap()
            .delta("epoch", 2, vec![])
            .unwrap();
        m.trade(
            &mut l,
            b.get("ETH-USD").unwrap(),
            Trade {
                instrument: "ETH-USD".into(),
                epoch: "epoch".into(),
                sequence: "1".into(),
                event_id: "100".into(),
                venue: "fixture".into(),
                time_ns: now_ns().to_string(),
                maker_side: BookSide::Bid,
                price: n("99"),
                quantity: n("1.2"),
                provider_time_ns: None,
                source_clock: None,
            },
            now_ns(),
        )
        .unwrap();
        let stats = l.strategy_stats("paper-run").unwrap();
        assert_eq!(stats.gross_filled, n("19.8"));
        assert_eq!(stats.fees, n("0.0198"));
        assert_eq!(stats.open_notional, n("80.2"));
        assert!(l.orders().all(|o| l.order_owner(o) == "workspace:test"));
        drop(l);
        let restored = Ledger::open(path, 8 * 1024 * 1024).unwrap();
        assert_eq!(
            restored.strategy_stats("paper-run").unwrap().gross_filled,
            n("19.8")
        );
        assert_eq!(
            Runner::default()
                .run_view(&restored, restored.strategy_run("paper-run").unwrap())
                .unwrap()["phase"],
            "paused"
        );
    });
}
#[test]
fn a_stale_book_pauses_even_when_the_repricing_interval_is_long() {
    fixture(|mut l, b, mut m, mut r, _| {
        let mut d = definition();
        d.maker.refresh_ms = 60000;
        d.maker.ttl_ms = 60000;
        l.define_strategy(d).unwrap();
        start(&mut r, &mut l, &b, "stale", Mode::Paper);
        r.drive(&mut l, &b, &mut m);
        assert_eq!(l.orders().count(), 2);
        std::thread::sleep(Duration::from_millis(1100));
        r.drive(&mut l, &b, &mut m);
        assert_eq!(l.strategy_run("stale").unwrap().phase, Phase::Paused);
        assert!(l.orders().all(|o| m.runtime(o)["held"] == true));
        assert!(l.balance("paper", "USD").reserved.0 > 0);
    });
}
#[test]
fn stopping_an_old_run_does_not_cancel_a_new_run() {
    fixture(|mut l, b, mut m, mut r, _| {
        l.define_strategy(definition()).unwrap();
        start(&mut r, &mut l, &b, "old", Mode::Paper);
        r.drive(&mut l, &b, &mut m);
        r.stop(&mut l, &mut m, "old", true, "USER_STOPPED").unwrap();
        start(&mut r, &mut l, &b, "new", Mode::Paper);
        r.drive(&mut l, &b, &mut m);
        r.stop(&mut l, &mut m, "old", true, "USER_STOPPED").unwrap();
        let active = l.orders().filter(|o| o.is_open()).collect::<Vec<_>>();
        assert_eq!(active.len(), 2);
        assert!(
            active
                .iter()
                .all(|o| l.order_run_id(&o.request.id) == Some("new")
                    && m.runtime(o)["attached"] == true)
        );
    });
}
#[test]
fn budgets_reject_a_whole_quote_plan_before_any_order_is_created() {
    fixture(|mut l, b, mut m, mut r, _| {
        let mut d = definition();
        d.maker.max_notional = n("99");
        l.define_strategy(d).unwrap();
        start(&mut r, &mut l, &b, "bounded", Mode::Paper);
        r.drive(&mut l, &b, &mut m);
        assert_eq!(l.orders().count(), 0);
        assert_eq!(
            l.strategy_run("bounded").unwrap().reason,
            "STRATEGY_NOTIONAL_BUDGET"
        );
        assert_eq!(l.strategy_decisions("bounded").count(), 0);
    });
}
#[test]
fn invalid_run_commands_do_not_poison_the_durable_journal() {
    fixture(|mut l, _, _, _, path| {
        let bad = Run {
            id: "invalid run".into(),
            strategy: "missing".into(),
            revision: 1,
            mode: Mode::Paper,
            phase: Phase::Running,
            reason: "USER_STARTED".into(),
            created_at_ns: "0".into(),
            updated_at_ns: "0".into(),
            decisions: 0,
        };
        assert!(l.start_strategy(bad).is_err());
        l.define_strategy(definition()).unwrap();
        drop(l);
        assert_eq!(
            Ledger::open(path, 8 * 1024 * 1024)
                .unwrap()
                .strategies()
                .count(),
            1
        );
    });
}
