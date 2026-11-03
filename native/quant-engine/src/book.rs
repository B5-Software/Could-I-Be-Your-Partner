//! Sequenced L2 state. A gap invalidates the book until a fresh snapshot.
use crate::clock;
use crate::decimal::Fixed;
use crate::source_clock::SourceClock;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq, Ord, PartialOrd)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Bid,
    Ask,
}
#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Update {
    pub side: Side,
    pub price: Fixed,
    pub quantity: Fixed,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Coverage {
    pub bid_floor: Option<Fixed>,
    pub ask_ceiling: Option<Fixed>,
}
impl Coverage {
    fn contains(&self, side: Side, price: Fixed) -> bool {
        match side {
            Side::Bid => self.bid_floor.is_none_or(|floor| price >= floor),
            Side::Ask => self.ask_ceiling.is_none_or(|ceiling| price <= ceiling),
        }
    }
}
#[derive(Default)]
pub struct Book {
    pub epoch: String,
    pub sequence: u64,
    seen_sequence: u64,
    pub bids: BTreeMap<Fixed, Fixed>,
    pub asks: BTreeMap<Fixed, Fixed>,
    valid: bool,
    observed: Option<u128>,
    last: Vec<Update>,
    reason: Option<&'static str>,
    coverage: Coverage,
    source_time: Option<u128>,
    pub provider_time: Option<String>,
    pub source_clock: Option<SourceClock>,
}
impl Book {
    pub fn price_known(&self, side: Side, price: Fixed) -> bool {
        self.coverage.contains(side, price)
    }
    pub fn source_time(&mut self, time: Option<u128>) {
        self.source_time = time;
    }
    pub fn valid(&self) -> bool {
        self.valid
    }
    pub fn suspend(&mut self) {
        self.valid = false;
        self.reason = Some("SOURCE_UNAVAILABLE");
    }
    fn level(
        map: &mut BTreeMap<Fixed, Fixed>,
        price: Fixed,
        quantity: Fixed,
    ) -> Result<(), &'static str> {
        price.positive()?;
        if quantity.0 < 0 {
            return Err("NEGATIVE_BOOK_SIZE");
        }
        if quantity.0 == 0 {
            map.remove(&price);
        } else {
            map.insert(price, quantity);
        }
        if map.len() > 10000 {
            return Err("BOOK_DEPTH_LIMIT");
        }
        Ok(())
    }
    fn coherent(bids: &BTreeMap<Fixed, Fixed>, asks: &BTreeMap<Fixed, Fixed>) -> bool {
        match (bids.last_key_value(), asks.first_key_value()) {
            (Some((bid, _)), Some((ask, _))) => bid < ask,
            _ => false,
        }
    }
    fn invalidate(&mut self, reason: &'static str) -> Result<(), &'static str> {
        self.valid = false;
        self.reason = Some(reason);
        Err(reason)
    }
    pub fn snapshot(
        &mut self,
        epoch: String,
        sequence: u64,
        bids: Vec<[Fixed; 2]>,
        asks: Vec<[Fixed; 2]>,
    ) -> Result<(), &'static str> {
        self.snapshot_bounded(epoch, sequence, bids, asks, Coverage::default())
    }
    pub fn snapshot_bounded(
        &mut self,
        epoch: String,
        sequence: u64,
        bids: Vec<[Fixed; 2]>,
        asks: Vec<[Fixed; 2]>,
        coverage: Coverage,
    ) -> Result<(), &'static str> {
        if epoch.is_empty() || epoch.len() > 128 || bids.len() > 10000 || asks.len() > 10000 {
            return self.invalidate("BOOK_SNAPSHOT_LIMIT");
        }
        if coverage.bid_floor.is_some_and(|p| p.0 <= 0)
            || coverage.ask_ceiling.is_some_and(|p| p.0 <= 0)
            || bids.iter().any(|[p, _]| !coverage.contains(Side::Bid, *p))
            || asks.iter().any(|[p, _]| !coverage.contains(Side::Ask, *p))
        {
            return self.invalidate("INVALID_BOOK_COVERAGE");
        }
        if self.epoch == epoch
            && (sequence < self.seen_sequence || (!self.valid && sequence <= self.sequence))
        {
            return self.invalidate("BOOK_SEQUENCE_REGRESSED");
        }
        let (mut buy, mut sell) = (BTreeMap::new(), BTreeMap::new());
        for [price, quantity] in bids {
            if buy.contains_key(&price) {
                return self.invalidate("DUPLICATE_BOOK_LEVEL");
            }
            if let Err(e) = Self::level(&mut buy, price, quantity) {
                return self.invalidate(e);
            }
        }
        for [price, quantity] in asks {
            if sell.contains_key(&price) {
                return self.invalidate("DUPLICATE_BOOK_LEVEL");
            }
            if let Err(e) = Self::level(&mut sell, price, quantity) {
                return self.invalidate(e);
            }
        }
        if !Self::coherent(&buy, &sell) {
            return self.invalidate("CROSSED_OR_EMPTY_BOOK");
        }
        if self.valid && self.epoch == epoch && self.sequence == sequence {
            return if self.bids == buy && self.asks == sell && self.coverage == coverage {
                Ok(())
            } else {
                self.invalidate("CONFLICTING_DUPLICATE_SNAPSHOT")
            };
        }
        self.bids = buy;
        self.asks = sell;
        self.coverage = coverage;
        self.source_time = None;
        self.provider_time = None;
        self.source_clock = None;
        self.epoch = epoch;
        self.sequence = sequence;
        self.seen_sequence = sequence;
        self.valid = true;
        self.observed = Some(clock::mono_ns());
        self.last.clear();
        self.reason = None;
        Ok(())
    }
    pub fn delta(
        &mut self,
        epoch: &str,
        sequence: u64,
        updates: Vec<Update>,
    ) -> Result<bool, &'static str> {
        if !self.valid {
            return Err("BOOK_SNAPSHOT_REQUIRED");
        }
        if self.epoch != epoch {
            return self.invalidate("BOOK_EPOCH_CHANGED").map(|_| false);
        }
        self.seen_sequence = self.seen_sequence.max(sequence);
        if sequence < self.sequence {
            return Ok(false);
        }
        if sequence == self.sequence {
            if updates == self.last {
                return Ok(false);
            }
            return self
                .invalidate("CONFLICTING_DUPLICATE_SEQUENCE")
                .map(|_| false);
        }
        if self.sequence.checked_add(1) != Some(sequence) {
            return self.invalidate("BOOK_SEQUENCE_GAP").map(|_| false);
        }
        if updates.len() > 8000 {
            return self.invalidate("BOOK_DELTA_LIMIT").map(|_| false);
        }
        // Validate all updates before applying any. Invalidation prevents trading
        // if the source leaves an empty/crossed book; no partial state is eligible.
        for u in &updates {
            if u.price.0 <= 0 || u.quantity.0 < 0 {
                return self.invalidate("INVALID_BOOK_LEVEL").map(|_| false);
            }
            if !self.coverage.contains(u.side, u.price) {
                return self.invalidate("LEVEL_OUTSIDE_KNOWN_DEPTH").map(|_| false);
            }
        }
        for u in &updates {
            let map = match u.side {
                Side::Bid => &mut self.bids,
                Side::Ask => &mut self.asks,
            };
            if let Err(e) = Self::level(map, u.price, u.quantity) {
                return self.invalidate(e).map(|_| false);
            }
        }
        if !Self::coherent(&self.bids, &self.asks) {
            return self.invalidate("CROSSED_OR_EMPTY_BOOK").map(|_| false);
        }
        self.sequence = sequence;
        self.last = updates;
        self.observed = Some(clock::mono_ns());
        self.reason = None;
        Ok(true)
    }
    pub fn eligible(&self, stale_ms: u64) -> bool {
        self.valid
            && self.source_time.is_none_or(|time| {
                let now = clock::now_ns();
                time <= now.saturating_add(250_000_000)
                    && now.saturating_sub(time) <= u128::from(stale_ms) * 1_000_000
            })
            && self.observed.is_some_and(|instant| {
                clock::elapsed_ns(instant) <= u128::from(stale_ms) * 1_000_000
            })
    }
    pub fn status(&self, stale_ms: u64, depth: usize) -> serde_json::Value {
        serde_json::json!({"epoch":self.epoch,"sequence":self.sequence.to_string(),"valid":self.valid,"eligible":self.eligible(stale_ms),"reason":self.reason,"coverage":self.coverage,"sourceTimeNs":self.source_time.map(|t|t.to_string()),"providerTimeNs":self.provider_time,"sourceClock":self.source_clock,
            "bids":self.bids.iter().rev().take(depth).collect::<Vec<_>>(),"asks":self.asks.iter().take(depth).collect::<Vec<_>>()})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn n(s: &str) -> Fixed {
        Fixed::try_from(s.to_string()).unwrap()
    }
    fn book() -> Book {
        let mut b = Book::default();
        b.snapshot(
            "one".into(),
            5,
            vec![[n("99"), n("2")]],
            vec![[n("101"), n("3")]],
        )
        .unwrap();
        b
    }
    #[test]
    fn gap_recovery_duplicates_and_epoch() {
        let mut b = book();
        let change = vec![Update {
            side: Side::Bid,
            price: n("99"),
            quantity: n("4"),
        }];
        assert_eq!(b.delta("one", 6, change.clone()), Ok(true));
        assert_eq!(b.delta("one", 6, change), Ok(false));
        assert!(b.eligible(1000));
        assert_eq!(b.delta("one", 8, vec![]), Err("BOOK_SEQUENCE_GAP"));
        assert!(!b.eligible(1000));
        assert_eq!(b.delta("one", 9, vec![]), Err("BOOK_SNAPSHOT_REQUIRED"));
        b.snapshot(
            "two".into(),
            1,
            vec![[n("99"), n("1")]],
            vec![[n("101"), n("1")]],
        )
        .unwrap();
        assert!(b.eligible(1000));
        assert_eq!(b.delta("old", 2, vec![]), Err("BOOK_EPOCH_CHANGED"));
    }
    #[test]
    fn conflicting_or_crossed_input_is_never_eligible() {
        let mut b = book();
        assert!(
            b.delta(
                "one",
                5,
                vec![Update {
                    side: Side::Ask,
                    price: n("101"),
                    quantity: n("9")
                }]
            )
            .is_err()
        );
        assert!(!b.eligible(1000));
        let mut b = book();
        assert!(
            b.delta(
                "one",
                6,
                vec![Update {
                    side: Side::Bid,
                    price: n("102"),
                    quantity: n("1")
                }]
            )
            .is_err()
        );
        assert!(!b.eligible(1000));
    }
    #[test]
    fn freshness_uses_monotonic_time() {
        let mut b = book();
        b.observed = None;
        assert!(!b.eligible(1000));
    }
    #[test]
    fn resync_cannot_restore_an_older_snapshot_or_refresh_replayed_data() {
        let mut b = book();
        b.observed = None;
        b.snapshot(
            "one".into(),
            5,
            vec![[n("99"), n("2")]],
            vec![[n("101"), n("3")]],
        )
        .unwrap();
        assert!(!b.eligible(1000));
        assert!(b.delta("one", 8, vec![]).is_err());
        assert!(
            b.snapshot(
                "one".into(),
                5,
                vec![[n("99"), n("2")]],
                vec![[n("101"), n("3")]]
            )
            .is_err()
        );
        assert!(
            b.snapshot(
                "one".into(),
                7,
                vec![[n("99"), n("2")]],
                vec![[n("101"), n("3")]]
            )
            .is_err()
        );
        assert_eq!(
            b.snapshot(
                "one".into(),
                4,
                vec![[n("99"), n("2")]],
                vec![[n("101"), n("3")]]
            ),
            Err("BOOK_SEQUENCE_REGRESSED")
        );
    }
}
