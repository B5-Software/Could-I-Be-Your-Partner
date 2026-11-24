use super::*;
use crate::book::Side as BookSide;

const MAX_LEVELS: usize = 64;
const FRESH_MS: u64 = 1000;

fn sweep(request: &Submit, lot: Fixed, book: &Book, side: BookSide) -> Result<Vec<(Fixed, Fixed)>> {
    let mut fills = Vec::new();
    let mut remaining = request.quantity;
    let mut take = |price: Fixed, size: Fixed| -> Result<bool> {
        let available = book.simulated_available(side, price, size);
        let atom = remaining.0.min(available.0);
        let quantity = Fixed(atom - atom % lot.0);
        if quantity.0 > 0 {
            check(fills.len() < MAX_LEVELS, "PAPER_SWEEP_LEVEL_LIMIT")?;
            fills.push((price, quantity));
            remaining = remaining.checked_sub(quantity)?;
        }
        Ok(remaining.0 == 0)
    };
    match side {
        BookSide::Ask => {
            for (&price, &size) in book.asks.range(..=request.price) {
                if take(price, size)? {
                    break;
                }
            }
        }
        BookSide::Bid => {
            for (&price, &size) in book.bids.range(request.price..).rev() {
                if take(price, size)? {
                    break;
                }
            }
        }
    }
    if request.time_in_force == TimeInForce::Fok && remaining.0 > 0 {
        fills.clear();
    }
    check(
        book.can_track_simulated_takes(side, &fills),
        "PAPER_SWEEP_TRACKING_LIMIT",
    )?;
    Ok(fills)
}

impl Ledger {
    /// Consume the executable portion of the currently observed L2 book. An
    /// immediate order never rests in the public maker queue.
    pub fn submit_immediate(&mut self, request: Submit, book: &mut Book) -> Result<Outcome> {
        check(
            !request.time_in_force.is_resting() && !request.post_only,
            "PAPER_IMMEDIATE_MODE",
        )?;
        id(&request.id)?;
        let key = format!("submit:{}", request.id);
        let digest = fingerprint(&request)?;
        if let Some(previous) = self.duplicate(&key, &digest)? {
            return Ok(previous);
        }
        check(
            request.strategy.starts_with("workspace:")
                && self.strategy(&request.strategy, 0).is_none(),
            "PAPER_IMMEDIATE_SCOPE",
        )?;
        check(!self.account_halted(&request.account), "ACCOUNT_HALTED")?;
        check(book.eligible(FRESH_MS), "FRESH_BOOK_REQUIRED")?;
        request.quantity.positive()?;
        let instrument = self
            .state
            .instruments
            .get(&request.instrument)
            .ok_or("INSTRUMENT_NOT_FOUND")?;
        let mut overlay = State::default();
        overlay
            .instruments
            .insert(instrument.id.clone(), instrument.clone());
        overlay.risk.insert(
            request.account.clone(),
            self.state
                .risk
                .get(&request.account)
                .ok_or("ACCOUNT_NOT_FOUND")?
                .clone(),
        );
        for asset in [&instrument.base, &instrument.quote] {
            overlay.balances.insert(
                (request.account.clone(), asset.clone()),
                self.state.balance(&request.account, asset),
            );
        }
        overlay.pending.insert(
            (request.account.clone(), instrument.base.clone()),
            self.state.pending(&request.account, &instrument.base),
        );
        if let Some(&count) = self.state.counts.get(&request.account) {
            overlay.counts.insert(request.account.clone(), count);
        }
        let lot = instrument.lot;
        let side = match request.side {
            Side::Buy => BookSide::Ask,
            Side::Sell => BookSide::Bid,
        };
        let order_id = request.id.clone();
        let instrument_id = request.instrument.clone();
        let time = utc_ns();
        let mut levels = Vec::new();
        let outcome = self.stage(overlay, |ledger| {
            let mut outcome = ledger.place(request, &instrument_id, book, FRESH_MS)?;
            levels = sweep(&outcome.order.request, lot, book, side)?;
            for (index, &(price, quantity)) in levels.iter().enumerate() {
                let execution_id = format!("sweep:{digest}:{:02}", index + 1);
                outcome = ledger.fill(Fill {
                    id: execution_id.clone(),
                    order: order_id.clone(),
                    price,
                    quantity,
                    source: Some(ExecutionSource {
                        venue: "paper-l2-sweep".into(),
                        event_id: execution_id,
                        epoch: book.epoch.clone(),
                        sequence: book.sequence.to_string(),
                        time_ns: time.clone(),
                        provider_time_ns: book.provider_time.clone(),
                        source_clock: book.source_clock.clone(),
                    }),
                })?;
            }
            if outcome.order.is_open() {
                outcome.order = ledger.cancel(&order_id)?;
            }
            Ok(outcome)
        })?;
        for (price, quantity) in levels {
            book.record_simulated_take(side, price, quantity);
        }
        Ok(outcome)
    }
}
