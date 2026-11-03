// SPDX-License-Identifier: GPL-3.0-or-later
//! Fixed-duration signing quotas, charged atomically with receipts. Not chain-time limits.
use crate::{
    Result,
    authority::{Check, now, quantity},
    scope::Usage,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
const STORE: &str = "WALLET_RECEIPT_STORE_FAILED";
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub seconds: u64,
    pub max_total_value_wei: String,
    pub max_total_fee_wei: String,
    pub max_transactions: u64,
    #[serde(default)]
    pub tokens: Vec<crate::tokens::Rule>,
}
impl Policy {
    pub fn validate(&self) -> Result<()> {
        if !(1..=2592000).contains(&self.seconds)
            || self.max_transactions > 1000000
            || self.tokens.len() > 16
        {
            return Err("WALLET_PERIOD_INVALID");
        }
        quantity(&self.max_total_value_wei)?;
        quantity(&self.max_total_fee_wei)?;
        let mut ids = std::collections::BTreeSet::new();
        for t in &self.tokens {
            t.validate()?;
            if !ids.insert(crate::tokens::key(t.chain_id, &t.address)) {
                return Err("WALLET_PERIOD_INVALID");
            }
        }
        Ok(())
    }
    pub fn subset_of(&self, parent: &Self) -> Result<()> {
        if self.seconds != parent.seconds {
            return Err("WALLET_AGENT_SCOPE_WIDENING");
        }
        let child = crate::scope::Rules {
            max_total_value_wei: self.max_total_value_wei.clone(),
            max_total_fee_wei: self.max_total_fee_wei.clone(),
            max_transactions: self.max_transactions,
            tokens: serde_json::from_value(serde_json::to_value(&self.tokens).map_err(|_| STORE)?)
                .map_err(|_| STORE)?,
            ..Default::default()
        };
        let parent = crate::scope::Rules {
            max_total_value_wei: parent.max_total_value_wei.clone(),
            max_total_fee_wei: parent.max_total_fee_wei.clone(),
            max_transactions: parent.max_transactions,
            tokens: serde_json::from_value(
                serde_json::to_value(&parent.tokens).map_err(|_| STORE)?,
            )
            .map_err(|_| STORE)?,
            ..Default::default()
        };
        child.subset_of(&parent)
    }
}
fn hash(body: &str) -> String {
    hex::encode(Sha256::digest(body.as_bytes()))
}
fn kind(k: &str) -> bool {
    ["grant", "portfolio", "scope"].contains(&k)
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-:".contains(&b))
}
pub fn initialize(c: &Connection) -> Result<()> {
    c.execute_batch("BEGIN IMMEDIATE;
      CREATE TABLE period_accounts(kind TEXT NOT NULL,id TEXT NOT NULL,seconds INTEGER NOT NULL,origin_ms INTEGER NOT NULL,last_ms INTEGER NOT NULL,windows INTEGER NOT NULL,signatures INTEGER NOT NULL,checksum TEXT NOT NULL,PRIMARY KEY(kind,id)) STRICT;
      CREATE TABLE period_windows(kind TEXT NOT NULL,id TEXT NOT NULL,start_ms INTEGER NOT NULL,body TEXT NOT NULL,checksum TEXT NOT NULL,PRIMARY KEY(kind,id,start_ms),FOREIGN KEY(kind,id) REFERENCES period_accounts(kind,id)) STRICT;
      CREATE TABLE period_charges(operation_id TEXT NOT NULL REFERENCES receipts(operation_id),kind TEXT NOT NULL,id TEXT NOT NULL,start_ms INTEGER NOT NULL,PRIMARY KEY(operation_id,kind,id),FOREIGN KEY(kind,id,start_ms) REFERENCES period_windows(kind,id,start_ms)) STRICT;
      CREATE INDEX period_charges_account ON period_charges(kind,id,start_ms);
      CREATE TABLE period_metadata(id INTEGER PRIMARY KEY CHECK(id=1),accounts INTEGER NOT NULL,windows INTEGER NOT NULL,charges INTEGER NOT NULL) STRICT;
      INSERT INTO period_metadata VALUES(1,0,0,0);
      ALTER TABLE portfolio_signatures ADD COLUMN policy_hash TEXT NOT NULL DEFAULT 'legacy';
      CREATE TABLE portfolio_revisions(id TEXT NOT NULL REFERENCES portfolios(id),revision INTEGER NOT NULL,body TEXT NOT NULL,checksum TEXT NOT NULL,state TEXT NOT NULL,changed_ms INTEGER NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(id,revision)) STRICT;
      INSERT INTO portfolio_revisions SELECT id,revision,body,checksum,state,0,'baseline' FROM portfolios;
      CREATE TABLE portfolio_revision_metadata(id INTEGER PRIMARY KEY CHECK(id=1),entries INTEGER NOT NULL) STRICT;
      INSERT INTO portfolio_revision_metadata SELECT 1,count(*) FROM portfolio_revisions;
      PRAGMA user_version=7;COMMIT;").map_err(|_|STORE)
}
struct Account {
    seconds: u64,
    origin: u64,
    last: u64,
    windows: u64,
    signatures: u64,
}
impl Account {
    fn checksum(&self, k: &str, id: &str) -> Result<String> {
        Ok(hash(&serde_json::to_string(&json!({"kind":k,"id":id,"seconds":self.seconds,"originMs":self.origin,"lastMs":self.last,"windows":self.windows,"signatures":self.signatures})).map_err(|_|STORE)?))
    }
}
fn number(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value = row.get::<_, i64>(index)?;
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, value))
}
fn sql(value: u64) -> Result<i64> {
    i64::try_from(value).map_err(|_| STORE)
}
fn account(c: &Connection, k: &str, id: &str) -> Result<Account> {
    type Row = (u64, u64, u64, u64, u64, String);
    let row:Option<Row>=c.query_row("SELECT seconds,origin_ms,last_ms,windows,signatures,checksum FROM period_accounts WHERE kind=?1 AND id=?2",params![k,id],|r|Ok((number(r,0)?,number(r,1)?,number(r,2)?,number(r,3)?,number(r,4)?,r.get(5)?))).optional().map_err(|_|STORE)?;
    let (seconds, origin, last, windows, signatures, checksum) = row.ok_or(STORE)?;
    if !kind(k)
        || !valid_id(id)
        || !(1..=2592000).contains(&seconds)
        || origin > last
        || last > 9007199254740991
    {
        return Err(STORE);
    }
    let result = Account {
        seconds,
        origin,
        last,
        windows,
        signatures,
    };
    if result.checksum(k, id)? != checksum {
        return Err(STORE);
    }
    let (windows,charges):(i64,i64)=c.query_row("SELECT (SELECT count(*) FROM period_windows WHERE kind=?1 AND id=?2),(SELECT count(*) FROM period_charges WHERE kind=?1 AND id=?2)",params![k,id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_|STORE)?;
    if u64::try_from(windows).map_err(|_| STORE)? != result.windows
        || u64::try_from(charges).map_err(|_| STORE)? != result.signatures
    {
        return Err(STORE);
    }
    Ok(result)
}
pub fn register(
    c: &Connection,
    k: &str,
    id: &str,
    policy: Option<&Policy>,
    parent: Option<(&str, &str)>,
    time: u64,
) -> Result<()> {
    let Some(p) = policy else {
        return Ok(());
    };
    p.validate()?;
    let (actual,expected):(i64,i64)=c.query_row("SELECT (SELECT count(*) FROM period_accounts),accounts FROM period_metadata WHERE id=1",[],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_|STORE)?;
    if actual != expected {
        return Err(STORE);
    }
    if !kind(k) || !valid_id(id) || time > 9007199254740991 {
        return Err("WALLET_PERIOD_INVALID");
    }
    let exists: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM period_accounts WHERE kind=?1 AND id=?2)",
            params![k, id],
            |r| r.get(0),
        )
        .map_err(|_| STORE)?;
    if exists {
        if account(c, k, id)?.seconds != p.seconds {
            return Err("WALLET_PERIOD_SCHEDULE_CHANGED");
        }
        return Ok(());
    }
    let origin = if let Some((pk, pi)) = parent {
        let parent = account(c, pk, pi)?;
        if parent.seconds != p.seconds {
            return Err("WALLET_PERIOD_SCHEDULE_CHANGED");
        }
        if time < parent.last {
            return Err("WALLET_PERIOD_CLOCK_ROLLBACK");
        }
        parent.origin
    } else {
        time
    };
    let state = Account {
        seconds: p.seconds,
        origin,
        last: time,
        windows: 0,
        signatures: 0,
    };
    c.execute(
        "INSERT INTO period_accounts VALUES(?1,?2,?3,?4,?5,0,0,?6)",
        params![
            k,
            id,
            p.seconds as i64,
            sql(origin)?,
            sql(time)?,
            state.checksum(k, id)?
        ],
    )
    .map_err(|_| STORE)?;
    c.execute(
        "UPDATE period_metadata SET accounts=accounts+1 WHERE id=1",
        [],
    )
    .map_err(|_| STORE)?;
    Ok(())
}
fn start(a: &Account, time: u64) -> u64 {
    a.origin + (time.max(a.origin) - a.origin) / (a.seconds * 1000) * (a.seconds * 1000)
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Window {
    usage: Usage,
    limits: Value,
}
fn window(c: &Connection, k: &str, id: &str, start: u64) -> Result<Option<Window>> {
    let row: Option<(String, String)> = c
        .query_row(
            "SELECT body,checksum FROM period_windows WHERE kind=?1 AND id=?2 AND start_ms=?3",
            params![k, id, sql(start)?],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|_| STORE)?;
    let value = if let Some((body, checksum)) = row {
        if body.len() > 32768 || hash(&body) != checksum {
            return Err(STORE);
        }
        Some(serde_json::from_str::<Window>(&body).map_err(|_| STORE)?)
    } else {
        None
    };
    let count: u64 = c
        .query_row(
            "SELECT count(*) FROM period_charges WHERE kind=?1 AND id=?2 AND start_ms=?3",
            params![k, id, sql(start)?],
            |r| number(r, 0),
        )
        .map_err(|_| STORE)?;
    if value.as_ref().map_or(0, |v| v.usage.transactions) != count {
        return Err(STORE);
    }
    Ok(value)
}
fn compact(p: &Policy) -> Value {
    json!({"maxTotalValueWei":p.max_total_value_wei,"maxTotalFeeWei":p.max_total_fee_wei,"maxTransactions":p.max_transactions,"tokens":p.tokens.iter().map(|t|json!({"chainId":t.chain_id,"address":t.address,"symbol":t.symbol,"decimals":t.decimals,"maxSignedAtoms":t.max_signed_atoms})).collect::<Vec<_>>()})
}
pub fn snapshot(c: &Connection, k: &str, id: &str, policy: Option<&Policy>) -> Result<Value> {
    if policy.is_none() {
        return Ok(Value::Null);
    }
    snapshot_at(c, k, id, policy, now()?)
}
pub fn snapshot_at(
    c: &Connection,
    k: &str,
    id: &str,
    policy: Option<&Policy>,
    time: u64,
) -> Result<Value> {
    let Some(p) = policy else {
        return Ok(Value::Null);
    };
    let a = account(c, k, id)?;
    if a.seconds != p.seconds {
        return Err(STORE);
    }
    let start = start(&a, time.max(a.last));
    let used = window(c, k, id, start)?
        .map(|w| w.usage)
        .unwrap_or_default();
    Ok(
        json!({"identity":{"kind":k,"id":id},"seconds":a.seconds,"originMs":a.origin,"startMs":start,"endMs":start+a.seconds*1000,"clockRollback":time<a.last,"limits":compact(p),"usage":used}),
    )
}
fn bounded(value: ethnum::U256, limit: &str) -> Result<()> {
    let max = quantity(limit)?;
    if max != ethnum::U256::ZERO && value > max {
        return Err("WALLET_PERIOD_LIMIT");
    }
    Ok(())
}
fn next(
    c: &Connection,
    k: &str,
    id: &str,
    p: &Policy,
    r: &Check<'_>,
) -> Result<(u64, Usage, bool)> {
    let a = account(c, k, id)?;
    if a.seconds != p.seconds {
        return Err(STORE);
    }
    if r.checked_at_ms < a.last {
        return Err("WALLET_PERIOD_CLOCK_ROLLBACK");
    }
    let start = start(&a, r.checked_at_ms);
    let previous = window(c, k, id, start)?;
    let fresh = previous.is_none();
    let mut used = previous.map(|w| w.usage).unwrap_or_default();
    if r.replay {
        let old: Option<u64> = c
            .query_row(
                "SELECT start_ms FROM period_charges WHERE kind=?1 AND id=?2 AND operation_id=?3",
                params![k, id, r.operation_id],
                |r| number(r, 0),
            )
            .optional()
            .map_err(|_| STORE)?;
        if old != Some(start) {
            return Err("WALLET_PERIOD_OLD_SIGNATURE");
        }
        return Ok((start, used, false));
    }
    let value = quantity(&used.value_wei)?
        .checked_add(quantity(&r.transaction.value)?)
        .ok_or("WALLET_PERIOD_LIMIT")?;
    let fee = quantity(&used.fee_wei)?
        .checked_add(quantity(r.fee_reserve_wei)?)
        .ok_or("WALLET_PERIOD_LIMIT")?;
    bounded(value, &p.max_total_value_wei)?;
    bounded(fee, &p.max_total_fee_wei)?;
    if p.max_transactions != 0 && used.transactions >= p.max_transactions {
        return Err("WALLET_PERIOD_LIMIT");
    }
    crate::tokens::consume(
        &p.tokens,
        &mut used.tokens,
        &crate::tokens::analyze(r.transaction, r.address),
        false,
    )?;
    used.value_wei = value.to_string();
    used.fee_wei = fee.to_string();
    used.transactions = used
        .transactions
        .checked_add(1)
        .ok_or("WALLET_PERIOD_LIMIT")?;
    Ok((start, used, fresh))
}
pub fn check(
    c: &Connection,
    k: &str,
    id: &str,
    policy: Option<&Policy>,
    r: &Check<'_>,
) -> Result<()> {
    if let Some(p) = policy {
        next(c, k, id, p, r)?;
    }
    Ok(())
}
pub fn consume(
    c: &Connection,
    k: &str,
    id: &str,
    policy: Option<&Policy>,
    r: &Check<'_>,
) -> Result<()> {
    let Some(p) = policy else {
        return Ok(());
    };
    let (start, usage, fresh) = next(c, k, id, p, r)?;
    let previous = account(c, k, id)?;
    let body = serde_json::to_string(&Window {
        usage,
        limits: compact(p),
    })
    .map_err(|_| STORE)?;
    if body.len() > 32768 {
        return Err(STORE);
    }
    c.execute("INSERT INTO period_windows VALUES(?1,?2,?3,?4,?5) ON CONFLICT(kind,id,start_ms) DO UPDATE SET body=excluded.body,checksum=excluded.checksum",params![k,id,sql(start)?,body,hash(&body)]).map_err(|_|STORE)?;
    c.execute(
        "INSERT INTO period_charges VALUES(?1,?2,?3,?4)",
        params![r.operation_id, k, id, sql(start)?],
    )
    .map_err(|_| STORE)?;
    let updated = Account {
        windows: previous
            .windows
            .checked_add(u64::from(fresh))
            .ok_or(STORE)?,
        signatures: previous.signatures.checked_add(1).ok_or(STORE)?,
        last: r.checked_at_ms,
        ..previous
    };
    c.execute("UPDATE period_accounts SET last_ms=?1,windows=?2,signatures=?3,checksum=?4 WHERE kind=?5 AND id=?6",params![sql(updated.last)?,sql(updated.windows)?,sql(updated.signatures)?,updated.checksum(k,id)?,k,id]).map_err(|_|STORE)?;
    c.execute(
        "UPDATE period_metadata SET windows=windows+?1,charges=charges+1 WHERE id=1",
        [u8::from(fresh)],
    )
    .map_err(|_| STORE)?;
    Ok(())
}
pub fn history(c: &Connection, k: &str, id: &str, offset: u32, limit: u32) -> Result<Value> {
    if !kind(k) || !valid_id(id) || offset > 200000 || !(1..=5).contains(&limit) {
        return Err("WALLET_PERIOD_INVALID");
    }
    let exists: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM period_accounts WHERE kind=?1 AND id=?2)",
            params![k, id],
            |r| r.get(0),
        )
        .map_err(|_| STORE)?;
    if !exists {
        return Ok(json!({"items":[],"total":0,"next":null}));
    }
    let a = account(c, k, id)?;
    let mut q=c.prepare("SELECT start_ms FROM period_windows WHERE kind=?1 AND id=?2 ORDER BY start_ms DESC LIMIT ?3 OFFSET ?4").map_err(|_|STORE)?;
    let starts = q
        .query_map(params![k, id, limit, offset], |r| number(r, 0))
        .map_err(|_| STORE)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| STORE)?;
    let mut items = vec![];
    for start in starts {
        let w = window(c, k, id, start)?.ok_or(STORE)?;
        items.push(
            json!({"startMs":start,"endMs":start+a.seconds*1000,"usage":w.usage,"limits":w.limits}),
        );
    }
    Ok(
        json!({"items":items,"total":a.windows,"next":if u64::from(offset+limit)<a.windows {Some(offset+limit)}else{None}}),
    )
}
pub fn validate(c: &Connection) -> Result<()> {
    let (a, w, s): (u64, u64, u64) = c
        .query_row(
            "SELECT accounts,windows,charges FROM period_metadata WHERE id=1",
            [],
            |r| Ok((number(r, 0)?, number(r, 1)?, number(r, 2)?)),
        )
        .map_err(|_| STORE)?;
    for (table, expected) in [
        ("period_accounts", a),
        ("period_windows", w),
        ("period_charges", s),
    ] {
        let actual: u64 = c
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| {
                number(r, 0)
            })
            .map_err(|_| STORE)?;
        if actual != expected {
            return Err(STORE);
        }
    }
    let mut q = c
        .prepare("SELECT kind,id FROM period_accounts")
        .map_err(|_| STORE)?;
    let ids = q
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|_| STORE)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| STORE)?;
    for (k, id) in ids {
        let account = account(c, &k, &id)?;
        let (windows,signatures):(u64,u64)=c.query_row("SELECT (SELECT count(*) FROM period_windows WHERE kind=?1 AND id=?2),(SELECT count(*) FROM period_charges WHERE kind=?1 AND id=?2)",params![k,id],|r|Ok((number(r,0)?,number(r,1)?))).map_err(|_|STORE)?;
        if windows != account.windows || signatures != account.signatures {
            return Err(STORE);
        }
        let mut q = c
            .prepare("SELECT start_ms FROM period_windows WHERE kind=?1 AND id=?2")
            .map_err(|_| STORE)?;
        let starts = q
            .query_map(params![k, id], |r| number(r, 0))
            .map_err(|_| STORE)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| STORE)?;
        for time in starts {
            if time < account.origin
                || (time - account.origin) % (account.seconds * 1000) != 0
                || time > account.last
            {
                return Err(STORE);
            }
            window(c, &k, &id, time)?.ok_or(STORE)?;
        }
    }
    // Verify typed owning policies too: losing an account must not disable a quota.
    let mut expected = 0u64;
    for (table, k) in [
        ("grants", "grant"),
        ("portfolios", "portfolio"),
        ("agent_scopes", "scope"),
    ] {
        let mut q = c
            .prepare(&format!("SELECT id,body,checksum FROM {table}"))
            .map_err(|_| STORE)?;
        let rows = q
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|_| STORE)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| STORE)?;
        for (id, body, checksum) in rows {
            if hash(&body) != checksum {
                return Err(STORE);
            }
            let value: Value = serde_json::from_str(&body).map_err(|_| STORE)?;
            if let Some(p) = value
                .get("limits")
                .and_then(|v| v.get("period"))
                .filter(|v| !v.is_null())
            {
                let p: Policy = serde_json::from_value(p.clone()).map_err(|_| STORE)?;
                p.validate().map_err(|_| STORE)?;
                if account(c, k, &id)?.seconds != p.seconds {
                    return Err(STORE);
                }
                expected += 1;
            }
        }
    }
    if expected != a {
        return Err(STORE);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Connection, Policy, crate::evm::Transaction) {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys=ON;CREATE TABLE receipts(operation_id TEXT PRIMARY KEY);CREATE TABLE grants(id TEXT PRIMARY KEY,body TEXT,checksum TEXT);CREATE TABLE portfolios(id TEXT PRIMARY KEY,revision INTEGER,body TEXT,checksum TEXT,state TEXT);CREATE TABLE portfolio_signatures(operation_id TEXT PRIMARY KEY,portfolio_id TEXT);CREATE TABLE agent_scopes(id TEXT PRIMARY KEY,body TEXT,checksum TEXT);").unwrap();
        initialize(&c).unwrap();
        let p = Policy {
            seconds: 2,
            max_total_value_wei: "10".into(),
            max_total_fee_wei: "10".into(),
            max_transactions: 1,
            tokens: vec![],
        };
        let body = serde_json::to_string(&json!({"limits":{"period":p}})).unwrap();
        c.execute(
            "INSERT INTO grants VALUES('budget',?1,?2)",
            params![body, hash(&body)],
        )
        .unwrap();
        register(&c, "grant", "budget", Some(&p), None, 1000).unwrap();
        let tx=serde_json::from_value(json!({"type":2,"chainId":8453,"nonce":0,"to":format!("0x{}","2".repeat(40)),"value":"1","data":"0x","gasLimit":"21000","maxFeePerGas":"1","maxPriorityFeePerGas":"1"})).unwrap();
        (c, p, tx)
    }
    fn request<'a>(tx: &'a crate::evm::Transaction, id: &'a str, time: u64) -> Check<'a> {
        Check {
            checked_at_ms: time,
            expires_at: 99999,
            wallet_id: "wallet",
            address: "0x1111111111111111111111111111111111111111",
            operation_id: id,
            session: "test",
            transaction: tx,
            unsigned_hash: "test",
            fee_reserve_wei: "2",
            policy_id: Some("grant"),
            execution: None,
            replay: false,
            replacement_of: None,
            agent_scope_id: None,
            agent_subject: None,
        }
    }
    fn charge(c: &mut Connection, p: &Policy, r: &Check<'_>) {
        let tx = c.transaction().unwrap();
        tx.execute("INSERT INTO receipts VALUES(?1)", [r.operation_id])
            .unwrap();
        consume(&tx, "grant", "budget", Some(p), r).unwrap();
        tx.commit().unwrap();
    }
    #[test]
    fn exact_boundaries_preserve_history_reject_old_replays_and_clock_rollback() {
        let (mut c, p, tx) = fixture();
        charge(&mut c, &p, &request(&tx, "one", 1500));
        assert_eq!(
            check(&c, "grant", "budget", Some(&p), &request(&tx, "two", 2999)),
            Err("WALLET_PERIOD_LIMIT")
        );
        charge(&mut c, &p, &request(&tx, "two", 3000));
        let mut replay = request(&tx, "one", 3001);
        replay.replay = true;
        assert_eq!(
            check(&c, "grant", "budget", Some(&p), &replay),
            Err("WALLET_PERIOD_OLD_SIGNATURE")
        );
        replay.operation_id = "two";
        check(&c, "grant", "budget", Some(&p), &replay).unwrap();
        assert_eq!(
            check(
                &c,
                "grant",
                "budget",
                Some(&p),
                &request(&tx, "three", 2500)
            ),
            Err("WALLET_PERIOD_CLOCK_ROLLBACK")
        );
        let snapshot = snapshot_at(&c, "grant", "budget", Some(&p), 2500).unwrap();
        assert_eq!(snapshot["clockRollback"], true);
        assert_eq!(snapshot["usage"]["transactions"], 1);
        let history = history(&c, "grant", "budget", 0, 1).unwrap();
        assert_eq!(history["total"], 2);
        assert_eq!(history["next"], 1);
        assert_eq!(history["items"][0]["startMs"], 3000);
        validate(&c).unwrap();
    }
    #[test]
    fn a_rolled_back_signature_does_not_consume_a_window() {
        let (mut c, p, tx) = fixture();
        let r = request(&tx, "rolled-back", 1500);
        {
            let t = c.transaction().unwrap();
            t.execute("INSERT INTO receipts VALUES(?1)", [r.operation_id])
                .unwrap();
            consume(&t, "grant", "budget", Some(&p), &r).unwrap();
            t.rollback().unwrap();
        }
        assert_eq!(
            snapshot_at(&c, "grant", "budget", Some(&p), 1600).unwrap()["usage"]["transactions"],
            0
        );
        assert_eq!(history(&c, "grant", "budget", 0, 2).unwrap()["total"], 0);
        validate(&c).unwrap();
    }
    #[test]
    fn missing_windows_and_changed_origins_fail_before_a_new_signature() {
        for sql in [
            "DELETE FROM period_charges;DELETE FROM period_windows",
            "UPDATE period_accounts SET origin_ms=origin_ms+1",
            "DELETE FROM period_accounts",
        ] {
            let (mut c, p, tx) = fixture();
            charge(&mut c, &p, &request(&tx, "one", 1500));
            c.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
            c.execute_batch(sql).unwrap();
            assert_eq!(
                check(&c, "grant", "budget", Some(&p), &request(&tx, "two", 1600)),
                Err(STORE)
            );
            assert_eq!(validate(&c), Err(STORE));
        }
    }
    #[test]
    fn descendants_share_the_original_schedule_and_cannot_change_its_duration() {
        let (c, p, _) = fixture();
        register(
            &c,
            "scope",
            "child",
            Some(&p),
            Some(("grant", "budget")),
            2000,
        )
        .unwrap();
        assert_eq!(
            snapshot_at(&c, "scope", "child", Some(&p), 2000).unwrap()["originMs"],
            1000
        );
        let changed = Policy { seconds: 3, ..p };
        assert_eq!(
            register(&c, "grant", "budget", Some(&changed), None, 2500),
            Err("WALLET_PERIOD_SCHEDULE_CHANGED")
        );
    }
}
