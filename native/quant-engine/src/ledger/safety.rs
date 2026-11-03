//! Persistent account emergency stop. One compact WAL event cancels all remaining
//! PAPER orders and stops every deployment sharing the account. Never resumes.
use super::*;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Halt {
    pub id: String,
    pub at_ns: String,
}
impl State {
    pub(super) fn apply_halt(
        &mut self,
        account: String,
        operation: String,
        time: String,
    ) -> Result<()> {
        id(&operation)?;
        check(self.risk.contains_key(&account), "ACCOUNT_NOT_FOUND")?;
        check(
            !self
                .halt_receipts
                .contains_key(&(account.clone(), operation.clone())),
            "HALT_OPERATION_EXISTS",
        )?;
        check(time.parse::<u128>().is_ok(), "INVALID_TIME")?;
        let orders = self
            .open_by_account
            .get(&account)
            .into_iter()
            .flatten()
            .filter_map(|id| self.orders.get(id))
            .map(|o| {
                let mut order = o.clone();
                order.version = order.version.checked_add(1).ok_or("VERSION_LIMIT")?;
                order.status = Status::Cancelled;
                order.reserved = Fixed(0);
                order.updated_at_ns = time.clone();
                Ok(order)
            })
            .collect::<Result<Vec<_>>>()?;
        let balances = self
            .balances
            .iter()
            .filter(|((a, _), _)| a == &account)
            .map(|((a, asset), b)| BalanceChange {
                account: a.clone(),
                asset: asset.clone(),
                value: Balance {
                    total: b.total,
                    reserved: Fixed(0),
                },
            })
            .collect();
        let pending = self
            .pending
            .keys()
            .filter(|(a, _)| a == &account)
            .map(|(a, asset)| PendingChange {
                account: a.clone(),
                asset: asset.clone(),
                value: Fixed(0),
            })
            .collect();
        self.apply(Event::Orders {
            orders,
            balances,
            pending,
            counts: vec![(account.clone(), 0)],
            receipt: None,
        })?;
        self.strategies.halt_account(&account, &time);
        self.halts.insert(
            account.clone(),
            Halt {
                id: operation.clone(),
                at_ns: time,
            },
        );
        self.halt_receipts.insert((account, operation), false);
        Ok(())
    }
}
impl Ledger {
    pub fn account_halted(&self, account: &str) -> bool {
        self.state.halts.contains_key(account)
    }
    pub fn halt_account(&mut self, account: &str, operation: &str) -> Result<serde_json::Value> {
        id(operation)?;
        check(self.state.risk.contains_key(account), "ACCOUNT_NOT_FOUND")?;
        // A retried old halt cannot undo a human reset or replace a newer latch.
        if self
            .state
            .halt_receipts
            .contains_key(&(account.into(), operation.into()))
        {
            return self.account_view(account);
        }
        self.active_accounts.remove(account);
        self.commit(Event::Halt {
            account: account.into(),
            operation: operation.into(),
            time: utc_ns(),
        })?;
        self.account_view(account)
    }
    pub fn reset_halt(&mut self, account: &str, expected: &str) -> Result<serde_json::Value> {
        id(expected)?;
        check(self.state.risk.contains_key(account), "ACCOUNT_NOT_FOUND")?;
        if let Some(halt) = self.state.halts.get(account) {
            check(halt.id == expected, "HALT_CHANGED")?;
        } else {
            check(
                self.state
                    .halt_receipts
                    .get(&(account.into(), expected.into()))
                    == Some(&true),
                "HALT_CHANGED",
            )?;
            return self.account_view(account);
        }
        self.active_accounts.remove(account);
        self.commit(Event::ResetHalt {
            account: account.into(),
            expected: expected.into(),
        })?;
        self.account_view(account)
    }
}
