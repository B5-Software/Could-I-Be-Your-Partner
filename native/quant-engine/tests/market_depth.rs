use cibyp_quant_engine::{
    book::{Book, Coverage, Side as BookSide, Update},
    decimal::Fixed,
    ledger::{Side, Submit},
    matching::{Matcher, now_ns},
};
fn n(value: &str) -> Fixed {
    Fixed::try_from(value.to_owned()).unwrap()
}
fn coverage() -> Coverage {
    Coverage {
        bid_floor: Some(n("95")),
        ask_ceiling: Some(n("105")),
    }
}
fn book() -> Book {
    let mut book = Book::default();
    book.snapshot_bounded(
        "source".into(),
        1,
        vec![[n("99"), n("2")], [n("97"), n("1")]],
        vec![[n("101"), n("3")]],
        coverage(),
    )
    .unwrap();
    book
}
#[test]
fn a_bounded_snapshot_does_not_turn_unknown_depth_into_an_empty_queue() {
    let book = book();
    assert!(!book.price_known(BookSide::Bid, n("94")));
    assert!(!book.price_known(BookSide::Ask, n("106")));
    assert!(book.price_known(BookSide::Bid, n("98")));
    let order = Submit {
        id: "one".into(),
        account: "account".into(),
        strategy: "strategy".into(),
        instrument: "market".into(),
        side: Side::Buy,
        price: n("94"),
        quantity: n("1"),
        post_only: true,
    };
    let matcher = Matcher::default();
    assert!(
        matches!(matcher.prepare(&order,&book,now_ns(),500),Err(e) if e=="PRICE_OUTSIDE_KNOWN_DEPTH")
    );
    assert!(
        matcher
            .prepare(
                &Submit {
                    price: n("98"),
                    ..order
                },
                &book,
                now_ns(),
                500
            )
            .is_ok()
    );
}
#[test]
fn invalid_coverage_or_outside_updates_stop_trading() {
    let mut book = book();
    assert_eq!(
        book.delta(
            "source",
            2,
            vec![Update {
                side: BookSide::Bid,
                price: n("94"),
                quantity: n("1")
            }]
        ),
        Err("LEVEL_OUTSIDE_KNOWN_DEPTH")
    );
    assert!(!book.eligible(1000));
    assert_eq!(
        book.snapshot_bounded(
            "new".into(),
            1,
            vec![[n("94"), n("1")]],
            vec![[n("101"), n("1")]],
            coverage()
        ),
        Err("INVALID_BOOK_COVERAGE")
    );
}
#[test]
fn local_receipt_does_not_make_old_or_future_source_data_fresh() {
    let mut book = book();
    book.source_time(Some(now_ns() - 2_000_000_000));
    assert!(!book.eligible(1000));
    book.source_time(Some(now_ns() + 1_000_000_000));
    assert!(!book.eligible(1000));
    book.source_time(Some(now_ns()));
    assert!(book.eligible(1000));
}
