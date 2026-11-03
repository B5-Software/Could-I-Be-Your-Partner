use cibyp_quant_engine::{
    book::{Book, Side as BookSide, Update},
    decimal::Fixed,
    ledger::{Instrument, Ledger, Risk, Side, Submit},
    matching::{Matcher, Trade},
};
use std::{
    collections::BTreeMap,
    fs,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
#[test]
fn calibrated_time_keeps_provider_evidence_and_deduplicates_after_a_clock_refresh() {
    run(|ledger, matcher, book| {
        place(ledger, matcher, book, request("clock"), 0);
        let mut event = trade(1, "3");
        let provider = (NOW - 1_500_000_000 + 1).to_string();
        event.provider_time_ns = Some(provider.clone());
        event.source_clock = Some(cibyp_quant_engine::source_clock::SourceClock {
            offset_ns: "-1500000000".into(),
            uncertainty_ns: "50000000".into(),
            calibrated_at_ns: NOW.to_string(),
        });
        let result = matcher
            .trade(ledger, book, event.clone(), NOW + 200_000_000)
            .unwrap();
        assert_eq!(result.quantity, n("1"));
        let source = ledger
            .order("clock")
            .unwrap()
            .last_execution
            .as_ref()
            .unwrap()
            .source
            .as_ref()
            .unwrap();
        assert_eq!(source.provider_time_ns.as_ref(), Some(&provider));
        assert_eq!(source.time_ns, (NOW + 1).to_string());
        event.sequence = "2".into();
        event.time_ns = (NOW + 100_000_001).to_string();
        event.source_clock.as_mut().unwrap().offset_ns = "-1600000000".into();
        assert!(
            matcher
                .trade(ledger, book, event, NOW + 200_000_000)
                .unwrap()
                .duplicate
        );
        assert_eq!(ledger.order("clock").unwrap().filled, n("1"));
    });
}
const NOW: u128 = 1_000_000_000_000_000_000;
fn n(value: &str) -> Fixed {
    Fixed::try_from(value.to_string()).unwrap()
}
fn book() -> Book {
    let mut b = Book::default();
    b.snapshot(
        "fixture".into(),
        1,
        vec![[n("100"), n("2")], [n("99"), n("10")]],
        vec![[n("102"), n("10")]],
    )
    .unwrap();
    b
}
fn request(id: &str) -> Submit {
    Submit {
        id: id.into(),
        account: "one".into(),
        strategy: "strategy".into(),
        instrument: "ETH-USD".into(),
        side: Side::Buy,
        price: n("100"),
        quantity: n("1"),
        post_only: true,
    }
}
fn trade(id: u64, quantity: &str) -> Trade {
    Trade {
        instrument: "ETH-USD".into(),
        epoch: "fixture".into(),
        sequence: id.to_string(),
        event_id: id.to_string(),
        venue: "coinbase-advanced".into(),
        time_ns: (NOW + u128::from(id)).to_string(),
        maker_side: BookSide::Bid,
        price: n("100"),
        quantity: n(quantity),
        provider_time_ns: None,
        source_clock: None,
    }
}
fn place(ledger: &mut Ledger, matcher: &mut Matcher, book: &Book, request: Submit, delay: u64) {
    let ticket = matcher.prepare(&request, book, NOW, delay).unwrap();
    ledger.submit(request, "ETH-USD", book, 1000).unwrap();
    matcher.attach(ticket);
}
fn run(test: impl FnOnce(&mut Ledger, &mut Matcher, &mut Book)) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let parent = std::env::temp_dir().canonicalize().unwrap();
    let path = parent.join(format!(
        "cibyp-matching-{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    {
        let mut ledger = Ledger::open(&path, 16 * 1024 * 1024).unwrap();
        ledger
            .instrument(Instrument {
                id: "ETH-USD".into(),
                base: "ETH".into(),
                quote: "USD".into(),
                tick: n("0.5"),
                lot: n("1"),
                min_notional: n("1"),
                fee_bps: 100,
            })
            .unwrap();
        ledger
            .account(
                "one".into(),
                Risk {
                    max_open_orders: 100,
                    max_order_notional: BTreeMap::from([("USD".into(), n("1000"))]),
                    max_asset_position: BTreeMap::from([("ETH".into(), n("100"))]),
                },
                BTreeMap::from([("USD".into(), n("10000"))]),
            )
            .unwrap();
        ledger.enable().unwrap();
        test(&mut ledger, &mut Matcher::default(), &mut book());
    }
    assert!(
        path.is_absolute()
            && path.starts_with(&parent)
            && path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("cibyp-matching-")
    );
    fs::remove_dir_all(path).unwrap();
}
#[test]
fn visible_queue_is_consumed_before_fifo_partial_fills_and_volume_is_conserved() {
    run(|ledger, matcher, book| {
        place(ledger, matcher, book, request("first"), 0);
        place(ledger, matcher, book, request("second"), 0);
        let result = matcher
            .trade(ledger, book, trade(1, "2.5"), NOW + 1)
            .unwrap();
        assert_eq!(result.quantity, n("0.5"));
        assert_eq!(ledger.order("first").unwrap().filled, n("0.5"));
        assert_eq!(ledger.order("second").unwrap().filled, n("0"));
        let result = matcher.trade(ledger, book, trade(2, "1"), NOW + 2).unwrap();
        assert_eq!(result.quantity, n("1"));
        assert_eq!(ledger.order("first").unwrap().filled, n("1"));
        assert_eq!(ledger.order("second").unwrap().filled, n("0.5"));
        assert_eq!(
            ledger
                .order("second")
                .unwrap()
                .last_execution
                .as_ref()
                .unwrap()
                .source
                .as_ref()
                .unwrap()
                .event_id,
            "2"
        );
    });
}
#[test]
fn duplicate_trades_never_advance_the_queue_twice_and_conflicting_ids_fail() {
    run(|ledger, matcher, book| {
        place(ledger, matcher, book, request("first"), 0);
        let event = trade(1, "3");
        matcher.trade(ledger, book, event.clone(), NOW + 1).unwrap();
        let balance = ledger.balance("one", "USD");
        let mut repeated = event.clone();
        repeated.sequence = "2".into();
        assert!(
            matcher
                .trade(ledger, book, repeated.clone(), NOW + 2)
                .unwrap()
                .duplicate
        );
        assert_eq!(ledger.balance("one", "USD"), balance);
        repeated.sequence = "3".into();
        repeated.quantity = n("4");
        assert_eq!(
            matcher
                .trade(ledger, book, repeated, NOW + 3)
                .err()
                .unwrap(),
            "TRADE_EVENT_CONFLICT"
        );
    });
}
#[test]
fn execution_latency_excludes_old_trades_and_does_not_reconstruct_offline_fills() {
    run(|ledger, matcher, book| {
        place(ledger, matcher, book, request("delayed"), 500);
        let mut old = trade(1, "100");
        old.time_ns = (NOW + 499_000_000).to_string();
        let result = matcher.trade(ledger, book, old, NOW + 499_000_000).unwrap();
        assert_eq!(result.inactive_orders, 1);
        assert_eq!(result.quantity, n("0"));
        let mut next = trade(2, "2");
        next.time_ns = (NOW + 501_000_000).to_string();
        matcher
            .trade(ledger, book, next, NOW + 501_000_000)
            .unwrap();
        let mut next = trade(3, "1");
        next.time_ns = (NOW + 502_000_000).to_string();
        matcher
            .trade(ledger, book, next, NOW + 502_000_000)
            .unwrap();
        assert_eq!(ledger.order("delayed").unwrap().filled, n("1"));
    });
}
#[test]
fn own_cancellation_removes_its_remaining_volume_from_later_orders() {
    run(|ledger, matcher, book| {
        place(ledger, matcher, book, request("first"), 0);
        place(ledger, matcher, book, request("second"), 0);
        ledger.cancel("first").unwrap();
        matcher.cancelled("first");
        matcher.trade(ledger, book, trade(1, "3"), NOW + 1).unwrap();
        assert_eq!(ledger.order("second").unwrap().filled, n("1"));
    });
}
#[test]
fn external_cancellations_do_not_optimistically_improve_position() {
    run(|ledger, matcher, book| {
        place(ledger, matcher, book, request("first"), 0);
        book.delta(
            "fixture",
            2,
            vec![Update {
                side: BookSide::Bid,
                price: n("100"),
                quantity: n("0"),
            }],
        )
        .unwrap();
        matcher.observe("ETH-USD", book).unwrap();
        matcher.trade(ledger, book, trade(1, "1"), NOW + 1).unwrap();
        assert_eq!(ledger.order("first").unwrap().filled, n("0"));
    });
}
#[test]
fn source_reset_leaves_old_orders_held_with_reservations_until_explicitly_cancelled() {
    run(|ledger, matcher, book| {
        place(ledger, matcher, book, request("first"), 0);
        matcher.detach("ETH-USD");
        book.snapshot(
            "new-source".into(),
            1,
            vec![[n("100"), n("2")]],
            vec![[n("102"), n("10")]],
        )
        .unwrap();
        let mut event = trade(1, "100");
        event.epoch = "new-source".into();
        matcher.trade(ledger, book, event, NOW + 1).unwrap();
        let order = ledger.order("first").unwrap();
        assert_eq!(order.filled, n("0"));
        assert_eq!(ledger.balance("one", "USD").reserved, n("101"));
        assert_eq!(matcher.runtime(order)["held"], true);
    });
}
#[test]
fn stale_future_or_gapped_trade_events_cannot_change_balances() {
    run(|ledger, matcher, book| {
        place(ledger, matcher, book, request("first"), 0);
        let mut future = trade(1, "100");
        future.time_ns = (NOW + 251_000_000).to_string();
        assert_eq!(
            matcher.trade(ledger, book, future, NOW).err().unwrap(),
            "TRADE_CLOCK_OR_AGE"
        );
        matcher.trade(ledger, book, trade(1, "1"), NOW + 1).unwrap();
        assert_eq!(
            matcher
                .trade(ledger, book, trade(3, "100"), NOW + 3)
                .err()
                .unwrap(),
            "TRADE_SEQUENCE_GAP"
        );
        assert_eq!(ledger.order("first").unwrap().filled, n("0"));
    });
}
