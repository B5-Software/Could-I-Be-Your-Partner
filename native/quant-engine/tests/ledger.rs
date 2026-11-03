use cibyp_quant_engine::{
    book::Book,
    decimal::Fixed,
    ledger::{Fill, Instrument, Ledger, Risk, Side, Status, Submit},
};
use std::{
    collections::BTreeMap,
    fs,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
fn n(value: &str) -> Fixed {
    Fixed::try_from(value.to_string()).unwrap()
}
fn risk() -> Risk {
    Risk {
        max_open_orders: 10,
        max_order_notional: BTreeMap::from([("USD".into(), n("1000"))]),
        max_asset_position: BTreeMap::from([("ETH".into(), n("100"))]),
    }
}
fn instrument() -> Instrument {
    Instrument {
        id: "ETH-USD".into(),
        base: "ETH".into(),
        quote: "USD".into(),
        tick: n("0.5"),
        lot: n("0.000000000000000001"),
        min_notional: n("0.000000000000000001"),
        fee_bps: 100,
    }
}
fn book() -> Book {
    let mut book = Book::default();
    book.snapshot(
        "live-feed".into(),
        5,
        vec![[n("99"), n("100")]],
        vec![[n("101"), n("100")]],
    )
    .unwrap();
    book
}
fn order(id: &str, side: Side, quantity: &str) -> Submit {
    Submit {
        id: id.into(),
        account: "paper".into(),
        strategy: "alpha".into(),
        instrument: "ETH-USD".into(),
        side,
        price: n("100"),
        quantity: n(quantity),
        post_only: true,
    }
}
fn fill(id: &str, order: &str, price: &str, quantity: &str) -> Fill {
    Fill {
        id: id.into(),
        order: order.into(),
        price: n(price),
        quantity: n(quantity),
        source: None,
    }
}
fn run(test: impl FnOnce(Ledger, &Path)) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let parent = std::env::temp_dir().canonicalize().unwrap();
    let path = parent.join(format!(
        "cibyp-ledger-{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let mut ledger = Ledger::open(&path, 8 * 1024 * 1024).unwrap();
    ledger.instrument(instrument()).unwrap();
    ledger
        .account(
            "paper".into(),
            risk(),
            BTreeMap::from([("USD".into(), n("1000")), ("ETH".into(), n("3"))]),
        )
        .unwrap();
    ledger.enable().unwrap();
    test(ledger, &path);
    assert!(
        path.is_absolute()
            && path.starts_with(&parent)
            && path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("cibyp-ledger-")
    );
    fs::remove_dir_all(path).unwrap();
}
#[test]
fn account_creation_retries_do_not_reset_funds_and_each_fill_survives_recovery() {
    run(|mut ledger, path| {
        let original = BTreeMap::from([("USD".into(), n("1000")), ("ETH".into(), n("3"))]);
        ledger
            .submit(order("history", Side::Buy, "1"), "ETH-USD", &book(), 30000)
            .unwrap();
        ledger
            .fill(fill("first", "history", "100", "0.25"))
            .unwrap();
        ledger
            .fill(fill("second", "history", "100", "0.25"))
            .unwrap();
        ledger
            .account("paper".into(), risk(), original.clone())
            .unwrap();
        assert_eq!(ledger.balance("paper", "ETH").total, n("3.5"));
        assert_eq!(ledger.executions().count(), 2);
        assert_eq!(
            ledger
                .account_named("paper".into(), "different".into(), risk(), original)
                .unwrap_err(),
            "ACCOUNT_CONFLICT"
        );
        drop(ledger);
        let restored = Ledger::open(path, 8 * 1024 * 1024).unwrap();
        assert_eq!(restored.executions().count(), 2);
        assert_eq!(restored.account_view("paper").unwrap()["active"], false);
        assert_eq!(restored.balance("paper", "ETH").total, n("3.5"));
    });
}

#[test]
fn account_emergency_cancels_all_owners_retains_fills_and_survives_reset_and_restart() {
    run(|mut ledger, path| {
        ledger
            .account(
                "other".into(),
                risk(),
                BTreeMap::from([("USD".into(), n("1000"))]),
            )
            .unwrap();
        ledger.activate_account("other", true).unwrap();
        ledger
            .submit(order("buy", Side::Buy, "1"), "ETH-USD", &book(), 30000)
            .unwrap();
        let mut sell = order("sell", Side::Sell, "1");
        sell.strategy = "different_owner".into();
        ledger.submit(sell, "ETH-USD", &book(), 30000).unwrap();
        let mut other = order("other-order", Side::Buy, "1");
        other.account = "other".into();
        ledger.submit(other, "ETH-USD", &book(), 30000).unwrap();
        ledger.fill(fill("settled", "buy", "100", "0.25")).unwrap();
        let total = ledger.balance("paper", "USD").total;
        let records = fs::read_to_string(path.join("events.jsonl"))
            .unwrap()
            .lines()
            .count();
        ledger.halt_account("paper", "stop-one").unwrap();
        assert_eq!(
            fs::read_to_string(path.join("events.jsonl"))
                .unwrap()
                .lines()
                .count(),
            records + 1
        );
        assert_eq!(ledger.order("buy").unwrap().status, Status::Cancelled);
        assert_eq!(ledger.order("buy").unwrap().filled, n("0.25"));
        assert_eq!(ledger.order("sell").unwrap().status, Status::Cancelled);
        assert_eq!(ledger.balance("paper", "USD").total, total);
        assert_eq!(ledger.balance("paper", "USD").reserved, n("0"));
        assert_eq!(ledger.balance("paper", "ETH").reserved, n("0"));
        assert_eq!(ledger.pending_position("paper", "ETH"), n("0"));
        assert!(ledger.open_account_orders("paper").next().is_none());
        assert_eq!(ledger.order("other-order").unwrap().status, Status::Open);
        assert!(ledger.account_active("other"));
        ledger.enable().unwrap();
        assert!(!ledger.account_active("paper"));
        assert_eq!(
            ledger.activate_account("paper", true).unwrap_err(),
            "ACCOUNT_HALTED"
        );
        drop(ledger);
        let mut ledger = Ledger::open(path, 8 * 1024 * 1024).unwrap();
        assert!(ledger.account_halted("paper"));
        ledger.halt_account("paper", "stop-two").unwrap();
        assert_eq!(
            ledger.reset_halt("paper", "stop-one").unwrap_err(),
            "HALT_CHANGED"
        );
        ledger.reset_halt("paper", "stop-two").unwrap();
        assert!(!ledger.account_active("paper"));
        ledger.halt_account("paper", "stop-one").unwrap();
        assert!(
            !ledger.account_halted("paper"),
            "old retried command must not re-latch"
        );
        ledger.activate_account("paper", true).unwrap();
        ledger
            .submit(
                order("after-reset", Side::Buy, "1"),
                "ETH-USD",
                &book(),
                30000,
            )
            .unwrap();
        drop(ledger);
        let mut ledger = Ledger::open(path, 8 * 1024 * 1024).unwrap();
        ledger.halt_account("paper", "stop-two").unwrap();
        assert!(!ledger.account_halted("paper"));
        assert_eq!(ledger.order("after-reset").unwrap().status, Status::Open);
    });
}

#[test]
fn failed_emergency_commit_never_claims_cancelled_orders_or_releases_reservations() {
    run(|mut ledger, path| {
        ledger
            .submit(order("held", Side::Buy, "1"), "ETH-USD", &book(), 30000)
            .unwrap();
        drop(ledger);
        let size = fs::metadata(path.join("events.jsonl")).unwrap().len();
        let mut ledger = Ledger::open(path, size).unwrap();
        let reserved = ledger.balance("paper", "USD").reserved;
        assert!(
            ledger
                .halt_account("paper", "same-stop")
                .unwrap_err()
                .starts_with("DURABLE_COMMIT:")
        );
        assert!(ledger.faulted());
        assert!(!ledger.enabled());
        assert_eq!(ledger.balance("paper", "USD").reserved, reserved);
        assert_eq!(ledger.order("held").unwrap().status, Status::Open);
        drop(ledger);
        let mut ledger = Ledger::open(path, 8 * 1024 * 1024).unwrap();
        ledger.halt_account("paper", "same-stop").unwrap();
        assert_eq!(ledger.order("held").unwrap().status, Status::Cancelled);
        assert!(ledger.account_halted("paper"));
    });
}
#[test]
fn activation_is_per_account_and_new_accounts_are_paused() {
    run(|mut ledger, _| {
        ledger
            .account_named(
                "other".into(),
                "Other".into(),
                risk(),
                BTreeMap::from([("USD".into(), n("1000"))]),
            )
            .unwrap();
        let mut second = order("other-order", Side::Buy, "1");
        second.account = "other".into();
        assert_eq!(
            ledger
                .submit(second.clone(), "ETH-USD", &book(), 30000)
                .err()
                .unwrap(),
            "ACCOUNT_PAUSED"
        );
        ledger.activate_account("other", true).unwrap();
        ledger.activate_account("paper", false).unwrap();
        ledger.submit(second, "ETH-USD", &book(), 30000).unwrap();
        assert_eq!(
            ledger
                .submit(order("paused", Side::Buy, "1"), "ETH-USD", &book(), 30000)
                .err()
                .unwrap(),
            "ACCOUNT_PAUSED"
        );
        assert_eq!(ledger.account_view("other").unwrap()["active"], true);
    });
}
#[test]
fn strategies_cannot_reserve_the_same_quote_or_base_twice() {
    run(|mut ledger, _| {
        let b = book();
        let mut first = order("one", Side::Buy, "6");
        first.strategy = "maker-a".into();
        ledger.submit(first, "ETH-USD", &b, 30000).unwrap();
        let mut second = order("two", Side::Buy, "5");
        second.strategy = "maker-b".into();
        assert_eq!(
            ledger.submit(second, "ETH-USD", &b, 30000).err().unwrap(),
            "INSUFFICIENT_AVAILABLE_BALANCE"
        );
        assert_eq!(ledger.balance("paper", "USD").reserved, n("606"));
        ledger.cancel("one").unwrap();
        assert_eq!(ledger.balance("paper", "USD").reserved, n("0"));
        ledger
            .submit(order("sell-one", Side::Sell, "2"), "ETH-USD", &b, 30000)
            .unwrap();
        assert_eq!(
            ledger
                .submit(order("sell-two", Side::Sell, "2"), "ETH-USD", &b, 30000)
                .err()
                .unwrap(),
            "INSUFFICIENT_AVAILABLE_BALANCE"
        );
        assert_eq!(ledger.balance("paper", "ETH").reserved, n("2"));
    });
}
#[test]
fn position_limits_include_all_pending_buys_and_count_limits_are_global() {
    run(|mut ledger, _| {
        let mut limits = risk();
        limits.max_asset_position.insert("ETH".into(), n("5"));
        limits.max_open_orders = 2;
        ledger.risk("paper".into(), limits).unwrap();
        let b = book();
        ledger
            .submit(order("first", Side::Buy, "1.5"), "ETH-USD", &b, 30000)
            .unwrap();
        assert_eq!(
            ledger
                .submit(order("too-much", Side::Buy, "1"), "ETH-USD", &b, 30000)
                .err()
                .unwrap(),
            "MAX_ASSET_POSITION"
        );
        ledger
            .submit(order("second", Side::Sell, "1"), "ETH-USD", &b, 30000)
            .unwrap();
        assert_eq!(
            ledger
                .submit(order("third", Side::Sell, "1"), "ETH-USD", &b, 30000)
                .err()
                .unwrap(),
            "MAX_OPEN_ORDERS"
        );
        assert_eq!(
            ledger.risk("paper".into(), risk()).err().unwrap(),
            "ACCOUNT_HAS_OPEN_ORDERS"
        );
    });
}
#[test]
fn partial_buy_fee_and_reservation_release_preserve_exact_balances() {
    run(|mut ledger, _| {
        ledger
            .submit(order("buy", Side::Buy, "2"), "ETH-USD", &book(), 30000)
            .unwrap();
        let result = ledger.fill(fill("trade-a", "buy", "99", "0.5")).unwrap();
        assert_eq!(result.order.status, Status::PartiallyFilled);
        assert_eq!(result.order.fees, n("0.495"));
        assert_eq!(ledger.balance("paper", "USD").total, n("950.005"));
        assert_eq!(ledger.balance("paper", "USD").reserved, n("151.5"));
        assert_eq!(ledger.balance("paper", "ETH").total, n("3.5"));
        let cancelled = ledger.cancel("buy").unwrap();
        assert_eq!(cancelled.status, Status::Cancelled);
        assert_eq!(ledger.balance("paper", "USD").reserved, n("0"));
        assert_eq!(ledger.cancel("buy").unwrap(), cancelled);
        assert_eq!(
            ledger.fill(fill("late", "buy", "99", "0.5")).err().unwrap(),
            "ORDER_CLOSED"
        );
    });
}
#[test]
fn partial_sells_never_mint_base_and_credits_are_net_of_cumulative_fees() {
    run(|mut ledger, _| {
        ledger
            .submit(order("sell", Side::Sell, "1"), "ETH-USD", &book(), 30000)
            .unwrap();
        ledger.fill(fill("one", "sell", "110", "0.4")).unwrap();
        assert_eq!(ledger.balance("paper", "ETH").total, n("2.6"));
        assert_eq!(ledger.balance("paper", "ETH").reserved, n("0.6"));
        assert_eq!(ledger.balance("paper", "USD").total, n("1043.56"));
        ledger.fill(fill("two", "sell", "100", "0.6")).unwrap();
        assert_eq!(ledger.order("sell").unwrap().status, Status::Filled);
        assert_eq!(ledger.balance("paper", "ETH").reserved, n("0"));
        assert_eq!(ledger.balance("paper", "USD").total, n("1102.96"));
    });
}
#[test]
fn fractional_atom_notional_is_rounded_cumulatively_not_per_fill() {
    run(|mut ledger, _| {
        let mut request = order("dust", Side::Buy, "0.000000000000000002");
        request.price = n("0.5");
        ledger.submit(request, "ETH-USD", &book(), 30000).unwrap();
        ledger
            .fill(fill("one", "dust", "0.5", "0.000000000000000001"))
            .unwrap();
        assert_eq!(ledger.order("dust").unwrap().reserved, n("0"));
        ledger
            .fill(fill("two", "dust", "0.5", "0.000000000000000001"))
            .unwrap();
        let order = ledger.order("dust").unwrap();
        assert_eq!(order.notional, n("0.000000000000000001"));
        assert_eq!(order.fees, n("0.000000000000000001"));
        assert_eq!(order.status, Status::Filled);
        assert_eq!(
            ledger.balance("paper", "USD").total,
            n("999.999999999999999998")
        );
    });
}
#[test]
fn durable_ids_cannot_be_changed_and_duplicates_do_not_pay_again() {
    run(|mut ledger, _| {
        let (request, b) = (order("repeat", Side::Buy, "1"), book());
        ledger
            .submit(request.clone(), "ETH-USD", &b, 30000)
            .unwrap();
        ledger.pause();
        assert!(
            ledger
                .submit(request.clone(), "ETH-USD", &b, 30000)
                .unwrap()
                .duplicate
        );
        let mut changed = request.clone();
        changed.strategy = "other".into();
        assert_eq!(
            ledger.submit(changed, "ETH-USD", &b, 30000).err().unwrap(),
            "COMMAND_CONFLICT"
        );
        let execution = fill("same-execution", "repeat", "99", "0.5");
        ledger.fill(execution.clone()).unwrap();
        let before = ledger.balance("paper", "USD");
        assert!(ledger.fill(execution).unwrap().duplicate);
        assert_eq!(ledger.balance("paper", "USD"), before);
        assert_eq!(
            ledger
                .fill(fill("same-execution", "repeat", "99", "0.1"))
                .err()
                .unwrap(),
            "COMMAND_CONFLICT"
        );
    });
}
#[test]
fn stale_wrong_instrument_and_crossing_post_only_books_do_not_reserve_funds() {
    run(|mut ledger, _| {
        let mut b = book();
        assert_eq!(
            ledger
                .submit(order("wrong", Side::Buy, "1"), "BTC-USD", &b, 30000)
                .err()
                .unwrap(),
            "BOOK_INSTRUMENT_MISMATCH"
        );
        let mut crossing = order("cross", Side::Buy, "1");
        crossing.price = n("101");
        assert_eq!(
            ledger.submit(crossing, "ETH-USD", &b, 30000).err().unwrap(),
            "POST_ONLY_WOULD_CROSS"
        );
        assert!(b.delta("live-feed", 7, vec![]).is_err());
        assert_eq!(
            ledger
                .submit(order("gap", Side::Buy, "1"), "ETH-USD", &b, 30000)
                .err()
                .unwrap(),
            "FRESH_BOOK_REQUIRED"
        );
        assert_eq!(ledger.balance("paper", "USD").reserved, n("0"));
    });
}
#[test]
fn invalid_fills_cannot_exceed_remaining_price_or_lot_and_leave_state_unchanged() {
    run(|mut ledger, _| {
        ledger
            .submit(order("bounded", Side::Buy, "1"), "ETH-USD", &book(), 30000)
            .unwrap();
        let before = ledger.balance("paper", "USD");
        assert_eq!(
            ledger
                .fill(fill("too-much", "bounded", "99", "2"))
                .err()
                .unwrap(),
            "FILL_EXCEEDS_REMAINING"
        );
        assert_eq!(
            ledger
                .fill(fill("price", "bounded", "101", "1"))
                .err()
                .unwrap(),
            "LIMIT_PRICE_VIOLATION"
        );
        assert_eq!(ledger.balance("paper", "USD"), before);
        assert_eq!(ledger.order("bounded").unwrap().filled, n("0"));
    });
}
#[test]
fn restart_preserves_partial_fills_reservations_and_ids_but_never_auto_enables() {
    run(|mut ledger, path| {
        let request = order("resume", Side::Buy, "2");
        ledger
            .submit(request.clone(), "ETH-USD", &book(), 30000)
            .unwrap();
        ledger.fill(fill("first", "resume", "99", "0.5")).unwrap();
        let balance = ledger.balance("paper", "USD");
        drop(ledger);
        let mut reopened = Ledger::open(path, 8 * 1024 * 1024).unwrap();
        assert!(!reopened.enabled());
        assert_eq!(reopened.balance("paper", "USD"), balance);
        assert_eq!(reopened.order("resume").unwrap().filled, n("0.5"));
        assert!(
            reopened
                .submit(request, "ETH-USD", &book(), 30000)
                .unwrap()
                .duplicate
        );
        assert!(
            reopened
                .fill(fill("first", "resume", "99", "0.5"))
                .unwrap()
                .duplicate
        );
        reopened.cancel("resume").unwrap();
        assert_eq!(reopened.balance("paper", "USD").reserved, n("0"));
    });
}
#[test]
fn failed_journal_commit_never_acknowledges_or_publishes_an_order() {
    run(|ledger, path| {
        let before = ledger.balance("paper", "USD");
        drop(ledger);
        let quota = fs::metadata(path.join("events.jsonl")).unwrap().len() + 32;
        let mut limited = Ledger::open(path, quota).unwrap();
        limited.enable().unwrap();
        assert!(
            limited
                .submit(
                    order("not-written", Side::Buy, "1"),
                    "ETH-USD",
                    &book(),
                    30000
                )
                .err()
                .unwrap()
                .contains("JOURNAL_QUOTA")
        );
        assert!(!limited.enabled());
        assert_eq!(limited.balance("paper", "USD"), before);
        assert!(limited.order("not-written").is_none());
        drop(limited);
        let reopened = Ledger::open(path, 8 * 1024 * 1024).unwrap();
        assert!(reopened.order("not-written").is_none());
        assert_eq!(reopened.balance("paper", "USD"), before);
    });
}

#[test]
fn market_event_fills_are_atomic_and_add_one_journal_record() {
    run(|mut ledger, path| {
        ledger
            .submit(order("a", Side::Buy, "1"), "ETH-USD", &book(), 30000)
            .unwrap();
        ledger
            .submit(order("b", Side::Buy, "1"), "ETH-USD", &book(), 30000)
            .unwrap();
        let rows = || {
            fs::read_to_string(path.join("events.jsonl"))
                .unwrap()
                .lines()
                .count()
        };
        let before = rows();
        assert!(
            ledger
                .fill_batch(vec![
                    fill("trade-a", "a", "100", "0.5"),
                    fill("trade-b", "b", "101", "0.5")
                ])
                .is_err()
        );
        assert_eq!(rows(), before);
        assert_eq!(ledger.balance("paper", "USD").total, n("1000"));
        assert_eq!(ledger.order("a").unwrap().filled, n("0"));
        let executions = vec![
            fill("trade-a", "a", "100", "0.5"),
            fill("trade-b", "b", "100", "0.5"),
        ];
        ledger.fill_batch(executions.clone()).unwrap();
        assert_eq!(rows(), before + 1);
        assert_eq!(ledger.balance("paper", "USD").total, n("899"));
        assert_eq!(ledger.balance("paper", "USD").reserved, n("101"));
        drop(ledger);
        let mut restored = Ledger::open(path, 8 * 1024 * 1024).unwrap();
        assert_eq!(restored.balance("paper", "USD").total, n("899"));
        assert!(
            restored
                .fill_batch(executions)
                .unwrap()
                .iter()
                .all(|o| o.duplicate)
        );
        assert_eq!(rows(), before + 1);
    });
}
#[test]
fn executions_can_be_smaller_than_the_order_submission_lot() {
    run(|mut ledger, _| {
        let mut spec = instrument();
        spec.id = "WHOLE-ETH".into();
        spec.lot = n("1");
        ledger.instrument(spec).unwrap();
        let mut request = order("fractional-fill", Side::Buy, "1");
        request.instrument = "WHOLE-ETH".into();
        ledger.submit(request, "WHOLE-ETH", &book(), 30000).unwrap();
        ledger
            .fill(fill("part", "fractional-fill", "100", "0.25"))
            .unwrap();
        let result = ledger.order("fractional-fill").unwrap();
        assert_eq!(result.filled, n("0.25"));
        assert_eq!(result.status, Status::PartiallyFilled);
        assert_eq!(result.last_execution.as_ref().unwrap().quantity, n("0.25"));
        assert!(!result.created_at_ns.is_empty());
    });
}
