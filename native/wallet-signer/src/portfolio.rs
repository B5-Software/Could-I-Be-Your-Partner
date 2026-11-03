// SPDX-License-Identifier: GPL-3.0-or-later
//! Human-configured, cross-wallet signing budgets. Not mark-to-market exposure.
use crate::{
    Result,
    authority::{Check, now, quantity},
    scope::{Rules, Usage},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
const STORE: &str = "WALLET_RECEIPT_STORE_FAILED";
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Member {
    pub wallet_id: String,
    pub address: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Portfolio {
    pub id: String,
    pub name: String,
    pub chain_id: u64,
    pub members: Vec<Member>,
    pub limits: Rules,
    pub max_fee_wei: String,
    pub expires_at: u64,
}
fn digest(body: &str) -> String {
    hex::encode(Sha256::digest(body.as_bytes()))
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
pub fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch("BEGIN IMMEDIATE;
      CREATE TABLE portfolios (id TEXT PRIMARY KEY,body TEXT NOT NULL,checksum TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('active','paused','removed')),revision INTEGER NOT NULL) STRICT;
      CREATE TABLE portfolio_members (wallet_id TEXT NOT NULL,address TEXT NOT NULL,chain INTEGER NOT NULL,portfolio_id TEXT NOT NULL REFERENCES portfolios(id),PRIMARY KEY(wallet_id,chain),UNIQUE(address,chain)) STRICT;
      CREATE TABLE portfolio_usage (id TEXT PRIMARY KEY REFERENCES portfolios(id),body TEXT NOT NULL,checksum TEXT NOT NULL) STRICT;
      CREATE TABLE portfolio_signatures (operation_id TEXT PRIMARY KEY REFERENCES receipts(operation_id),portfolio_id TEXT NOT NULL REFERENCES portfolios(id)) STRICT;
      CREATE INDEX portfolio_signatures_index ON portfolio_signatures(portfolio_id);
      CREATE TABLE portfolio_metadata (id INTEGER PRIMARY KEY CHECK(id=1),members INTEGER NOT NULL CHECK(members>=0)) STRICT;
      INSERT INTO portfolio_metadata VALUES(1,0);
      PRAGMA user_version=5;COMMIT;").map_err(|_|STORE)
}
pub fn upgrade(connection: &Connection) -> Result<()> {
    validate_bindings(connection)?;
    connection.execute_batch("BEGIN IMMEDIATE;CREATE TABLE portfolio_metadata (id INTEGER PRIMARY KEY CHECK(id=1),members INTEGER NOT NULL CHECK(members>=0)) STRICT;INSERT INTO portfolio_metadata SELECT 1,count(*) FROM portfolio_members;PRAGMA user_version=5;COMMIT;").map_err(|_|STORE)
}
fn member_count(connection: &Connection) -> Result<()> {
    let (actual,expected):(i64,i64)=connection.query_row("SELECT (SELECT count(*) FROM portfolio_members),members FROM portfolio_metadata WHERE id=1",[],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_|STORE)?;
    if actual != expected {
        return Err(STORE);
    }
    Ok(())
}
fn validate_bindings(connection: &Connection) -> Result<()> {
    let mut statement = connection
        .prepare("SELECT id FROM portfolios")
        .map_err(|_| STORE)?;
    let ids = statement
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|_| STORE)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| STORE)?;
    let mut expected = 0usize;
    for id in ids {
        let (p, state, _) = load(connection, &id)?;
        usage(connection, &id)?;
        let count: i64 = connection
            .query_row(
                "SELECT count(*) FROM portfolio_members WHERE portfolio_id=?1",
                [&id],
                |r| r.get(0),
            )
            .map_err(|_| STORE)?;
        if state == "removed" {
            if count != 0 {
                return Err(STORE);
            }
            continue;
        }
        if usize::try_from(count).map_err(|_| STORE)? != p.members.len() {
            return Err(STORE);
        }
        for m in &p.members {
            let exists:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM portfolio_members WHERE portfolio_id=?1 AND wallet_id=?2 AND address=?3 AND chain=?4)",params![id,m.wallet_id,m.address.to_ascii_lowercase(),p.chain_id as i64],|r|r.get(0)).map_err(|_|STORE)?;
            if !exists {
                return Err(STORE);
            }
        }
        expected += p.members.len();
    }
    let actual: i64 = connection
        .query_row("SELECT count(*) FROM portfolio_members", [], |r| r.get(0))
        .map_err(|_| STORE)?;
    if usize::try_from(actual).map_err(|_| STORE)? != expected {
        return Err(STORE);
    }
    Ok(())
}
pub fn validate(connection: &Connection) -> Result<()> {
    member_count(connection)?;
    validate_bindings(connection)
}
pub(crate) fn load(connection: &Connection, id: &str) -> Result<(Portfolio, String, u64)> {
    let row: Option<(String, String, String, i64)> = connection
        .query_row(
            "SELECT body,checksum,state,revision FROM portfolios WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(|_| STORE)?;
    let (body, checksum, state, revision) = row.ok_or("WALLET_PORTFOLIO_NOT_FOUND")?;
    if body.len() > 65536 || digest(&body) != checksum {
        return Err(STORE);
    }
    let value: Portfolio = serde_json::from_str(&body).map_err(|_| STORE)?;
    if value.id != id {
        return Err(STORE);
    }
    Ok((value, state, u64::try_from(revision).map_err(|_| STORE)?))
}
fn usage(connection: &Connection, id: &str) -> Result<Usage> {
    let row: Option<(String, String)> = connection
        .query_row(
            "SELECT body,checksum FROM portfolio_usage WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|_| STORE)?;
    let value = match row {
        Some((body, checksum)) => {
            if body.len() > 32768 || digest(&body) != checksum {
                return Err(STORE);
            }
            serde_json::from_str::<Usage>(&body).map_err(|_| STORE)?
        }
        None => Usage::default(),
    };
    let count: i64 = connection
        .query_row(
            "SELECT count(*) FROM portfolio_signatures WHERE portfolio_id=?1",
            [id],
            |r| r.get(0),
        )
        .map_err(|_| STORE)?;
    if u64::try_from(count).map_err(|_| STORE)? != value.transactions {
        return Err(STORE);
    }
    Ok(value)
}
pub fn get(connection: &Connection, id: &str) -> Result<Value> {
    let (portfolio, state, revision) = load(connection, id)?;
    Ok(
        json!({"portfolio":portfolio,"state":state,"revision":revision,"usage":usage(connection,id)?,"period":crate::periods::snapshot(connection,"portfolio",id,portfolio.limits.period.as_ref())?}),
    )
}
pub fn list(connection: &Connection, offset: u32) -> Result<Value> {
    if offset > 1000 {
        return Err("WALLET_PORTFOLIO_INVALID");
    }
    member_count(connection)?;
    let total: u32 = connection
        .query_row("SELECT count(*) FROM portfolios", [], |r| r.get(0))
        .map_err(|_| STORE)?;
    let mut statement = connection
        .prepare("SELECT id FROM portfolios ORDER BY rowid DESC LIMIT 20 OFFSET ?1")
        .map_err(|_| STORE)?;
    let ids = statement
        .query_map([offset], |r| r.get::<_, String>(0))
        .map_err(|_| STORE)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| STORE)?;
    let mut items = vec![];
    for id in ids {
        let (p, state, revision) = load(connection, &id)?;
        items.push(json!({"id":p.id,"name":p.name,"chainId":p.chain_id,"members":p.members,"expiresAt":p.expires_at,"state":state,"revision":revision}));
    }
    Ok(json!({"items":items,"total":total,"next":if offset+20<total {Some(offset+20)}else{None}}))
}
pub fn create(connection: &Connection, value: &Portfolio) -> Result<Value> {
    let body = serde_json::to_string(value).map_err(|_| STORE)?;
    if connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM portfolios WHERE id=?1)",
            [&value.id],
            |r| r.get::<_, bool>(0),
        )
        .map_err(|_| STORE)?
    {
        let (previous, _, _) = load(connection, &value.id)?;
        if serde_json::to_string(&previous).map_err(|_| STORE)? != body {
            return Err("WALLET_PORTFOLIO_CHANGED");
        }
        return get(connection, &value.id);
    }
    if !valid_id(&value.id)
        || value.name.trim().is_empty()
        || value.name.chars().count() > 80
        || value.name.chars().any(char::is_control)
        || ![8453, 84532].contains(&value.chain_id)
        || value.members.is_empty()
        || value.members.len() > 16
        || body.len() > 65536
        || (value.expires_at != 0 && value.expires_at <= now()?)
    {
        return Err("WALLET_PORTFOLIO_INVALID");
    }
    value.limits.validate()?;
    quantity(&value.max_fee_wei)?;
    if value
        .limits
        .tokens
        .iter()
        .any(|t| t.chain_id != value.chain_id)
    {
        return Err("WALLET_PORTFOLIO_INVALID");
    }
    if value
        .limits
        .period
        .as_ref()
        .is_some_and(|p| p.tokens.iter().any(|t| t.chain_id != value.chain_id))
    {
        return Err("WALLET_PERIOD_INVALID");
    }
    let count: u32 = connection
        .query_row("SELECT count(*) FROM portfolios", [], |r| r.get(0))
        .map_err(|_| STORE)?;
    if count >= 1000 {
        return Err("WALLET_NATIVE_AUTH_LIMIT");
    }
    let mut wallets = std::collections::BTreeSet::new();
    let mut addresses = std::collections::BTreeSet::new();
    for member in &value.members {
        let address = member.address.to_ascii_lowercase();
        if !valid_id(&member.wallet_id)
            || address.len() != 42
            || !address.starts_with("0x")
            || !address[2..].bytes().all(|b| b.is_ascii_hexdigit())
            || !wallets.insert(&member.wallet_id)
            || !addresses.insert(address.clone())
        {
            return Err("WALLET_PORTFOLIO_INVALID");
        }
        let exists:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM portfolio_members WHERE chain=?1 AND (wallet_id=?2 OR address=?3))",params![value.chain_id as i64,member.wallet_id,address],|r|r.get(0)).map_err(|_|STORE)?;
        if exists {
            return Err("WALLET_PORTFOLIO_MEMBER_BUSY");
        }
    }
    crate::periods::register(
        connection,
        "portfolio",
        &value.id,
        value.limits.period.as_ref(),
        None,
        now()?,
    )?;
    connection
        .execute(
            "INSERT INTO portfolios VALUES(?1,?2,?3,'active',1)",
            params![value.id, body, digest(&body)],
        )
        .map_err(|_| STORE)?;
    for member in &value.members {
        connection
            .execute(
                "INSERT INTO portfolio_members VALUES(?1,?2,?3,?4)",
                params![
                    member.wallet_id,
                    member.address.to_ascii_lowercase(),
                    value.chain_id as i64,
                    value.id
                ],
            )
            .map_err(|_| STORE)?;
    }
    connection
        .execute(
            "UPDATE portfolio_metadata SET members=members+?1 WHERE id=1",
            [value.members.len() as i64],
        )
        .map_err(|_| STORE)?;
    crate::portfolio_history::record(connection, value, "active", 1, "create")?;
    get(connection, &value.id)
}
pub fn state(connection: &Connection, id: &str, next: &str, expected: u64) -> Result<Value> {
    let (p, current, revision) = load(connection, id)?;
    if revision != expected
        || current == "removed"
        || !["active", "paused", "removed"].contains(&next)
        || revision >= 9007199254740991
    {
        return Err("WALLET_PORTFOLIO_CHANGED");
    }
    if next == "active" && p.expires_at != 0 && p.expires_at <= now()? {
        return Err("WALLET_PORTFOLIO_EXPIRED");
    }
    connection
        .execute(
            "UPDATE portfolios SET state=?1,revision=revision+1 WHERE id=?2",
            params![next, id],
        )
        .map_err(|_| STORE)?;
    if next == "removed" {
        member_count(connection)?;
        connection
            .execute("DELETE FROM portfolio_members WHERE portfolio_id=?1", [id])
            .map_err(|_| STORE)?;
        connection
            .execute(
                "UPDATE portfolio_metadata SET members=members-?1 WHERE id=1",
                [p.members.len() as i64],
            )
            .map_err(|_| STORE)?;
    }
    crate::portfolio_history::record(connection, &p, next, revision + 1, "state")?;
    get(connection, id)
}
fn assets(tokens: &[crate::tokens::Rule]) -> std::collections::BTreeSet<(u64, String, u8)> {
    tokens
        .iter()
        .map(|t| (t.chain_id, t.address.to_ascii_lowercase(), t.decimals))
        .collect()
}
pub fn update(c: &Connection, p: &Portfolio, expected: u64) -> Result<Value> {
    let (old, state, rev) = load(c, &p.id)?;
    if state == "removed" || rev != expected || rev >= 9007199254740991 {
        return Err("WALLET_PORTFOLIO_CHANGED");
    }
    if p.chain_id != old.chain_id
        || serde_json::to_value(&p.members).map_err(|_| STORE)?
            != serde_json::to_value(&old.members).map_err(|_| STORE)?
    {
        return Err("WALLET_PORTFOLIO_MEMBER_CHANGED");
    }
    if p.name.trim().is_empty()
        || p.name.chars().count() > 80
        || p.name.chars().any(char::is_control)
        || (p.expires_at != 0 && p.expires_at <= now()?)
    {
        return Err("WALLET_PORTFOLIO_INVALID");
    }
    p.limits.validate()?;
    quantity(&p.max_fee_wei)?;
    if p.limits
        .tokens
        .iter()
        .chain(p.limits.period.iter().flat_map(|p| p.tokens.iter()))
        .any(|t| t.chain_id != p.chain_id)
    {
        return Err("WALLET_PERIOD_INVALID");
    }
    if usage(c, &p.id)?.transactions > 0 && assets(&old.limits.tokens) != assets(&p.limits.tokens) {
        return Err("WALLET_BUDGET_ASSETS_FIXED");
    }
    if let Some(previous) = &old.limits.period {
        crate::periods::snapshot(c, "portfolio", &p.id, Some(previous))?;
        let next = p
            .limits
            .period
            .as_ref()
            .ok_or("WALLET_PERIOD_SCHEDULE_CHANGED")?;
        if previous.seconds != next.seconds {
            return Err("WALLET_PERIOD_SCHEDULE_CHANGED");
        }
        let history = crate::periods::history(c, "portfolio", &p.id, 0, 1)?;
        if history["total"].as_u64().ok_or(STORE)? > 0
            && assets(&previous.tokens) != assets(&next.tokens)
        {
            return Err("WALLET_BUDGET_ASSETS_FIXED");
        }
    }
    let body = serde_json::to_string(p).map_err(|_| STORE)?;
    if body.len() > 65536 {
        return Err("WALLET_PORTFOLIO_INVALID");
    }
    crate::periods::register(
        c,
        "portfolio",
        &p.id,
        p.limits.period.as_ref(),
        None,
        now()?,
    )?;
    c.execute(
        "UPDATE portfolios SET body=?1,checksum=?2,revision=revision+1 WHERE id=?3",
        params![body, digest(&body), p.id],
    )
    .map_err(|_| STORE)?;
    crate::portfolio_history::record(c, p, &state, rev + 1, "edit")?;
    get(c, &p.id)
}
fn bound(connection: &Connection, request: &Check<'_>) -> Result<Option<Portfolio>> {
    member_count(connection)?;
    let chain =
        i64::try_from(request.transaction.chain_id).map_err(|_| "WALLET_PORTFOLIO_INVALID")?;
    let row:Option<(String,String,String)>=connection.query_row("SELECT portfolio_id,wallet_id,address FROM portfolio_members WHERE chain=?1 AND (wallet_id=?2 OR address=?3)",params![chain,request.wallet_id,request.address.to_ascii_lowercase()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|_|STORE)?;
    let Some((id, wallet, address)) = row else {
        return Ok(None);
    };
    if wallet != request.wallet_id || !address.eq_ignore_ascii_case(request.address) {
        return Err("WALLET_PORTFOLIO_MEMBER_CHANGED");
    }
    let (p, state, _) = load(connection, &id)?;
    if state != "active" {
        return Err("WALLET_PORTFOLIO_PAUSED");
    }
    if p.expires_at != 0 && p.expires_at <= now()? {
        return Err("WALLET_PORTFOLIO_EXPIRED");
    }
    if p.chain_id != request.transaction.chain_id
        || !p
            .members
            .iter()
            .any(|m| m.wallet_id == wallet && m.address.eq_ignore_ascii_case(&address))
    {
        return Err(STORE);
    }
    Ok(Some(p))
}
fn next_usage(connection: &Connection, p: &Portfolio, request: &Check<'_>) -> Result<Usage> {
    if !request.replay
        && request.policy_id.is_some()
        && request.replacement_of.is_some()
        && !p.limits.allow_replacement
    {
        return Err("WALLET_PORTFOLIO_LIMIT");
    }
    let mut used = usage(connection, &p.id)?;
    crate::periods::check(
        connection,
        "portfolio",
        &p.id,
        p.limits.period.as_ref(),
        request,
    )?;
    let fee = quantity(request.fee_reserve_wei)?;
    let max = quantity(&p.max_fee_wei)?;
    if max != ethnum::U256::ZERO && fee > max {
        return Err("WALLET_PORTFOLIO_LIMIT");
    }
    p.limits
        .check(request.transaction, fee, &used, request.replay)
        .map_err(|_| "WALLET_PORTFOLIO_LIMIT")?;
    crate::tokens::consume(
        &p.limits.tokens,
        &mut used.tokens,
        &crate::tokens::analyze(request.transaction, request.address),
        request.replay,
    )?;
    if !request.replay {
        used.value_wei = quantity(&used.value_wei)?
            .checked_add(quantity(&request.transaction.value)?)
            .ok_or("WALLET_PORTFOLIO_LIMIT")?
            .to_string();
        used.fee_wei = quantity(&used.fee_wei)?
            .checked_add(fee)
            .ok_or("WALLET_PORTFOLIO_LIMIT")?
            .to_string();
        used.transactions = used
            .transactions
            .checked_add(1)
            .ok_or("WALLET_PORTFOLIO_LIMIT")?;
    }
    Ok(used)
}
pub fn check(connection: &Connection, request: &Check<'_>) -> Result<()> {
    let Some(p) = bound(connection, request)? else {
        return Ok(());
    };
    if request.replay {
        let previous: Option<String> = connection
            .query_row(
                "SELECT portfolio_id FROM portfolio_signatures WHERE operation_id=?1",
                [request.operation_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| STORE)?;
        if previous.as_deref() != Some(&p.id) {
            return Err("WALLET_PORTFOLIO_OLD_SIGNATURE");
        }
        let recorded: String = connection
            .query_row(
                "SELECT policy_hash FROM portfolio_signatures WHERE operation_id=?1",
                [request.operation_id],
                |r| r.get(0),
            )
            .map_err(|_| STORE)?;
        let expected = if recorded == "legacy" {
            crate::portfolio_history::baseline_hash(connection, &p.id)?
        } else {
            recorded
        };
        if expected != crate::portfolio_history::financial_hash(&p)? {
            return Err("WALLET_PORTFOLIO_OLD_SIGNATURE");
        }
    }
    next_usage(connection, &p, request)?;
    Ok(())
}
pub fn consume(connection: &Connection, request: &Check<'_>) -> Result<()> {
    let Some(p) = bound(connection, request)? else {
        return Ok(());
    };
    let used = next_usage(connection, &p, request)?;
    crate::periods::consume(
        connection,
        "portfolio",
        &p.id,
        p.limits.period.as_ref(),
        request,
    )?;
    let body = serde_json::to_string(&used).map_err(|_| STORE)?;
    if body.len() > 32768 {
        return Err(STORE);
    }
    connection.execute("INSERT INTO portfolio_usage VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET body=excluded.body,checksum=excluded.checksum",params![p.id,body,digest(&body)]).map_err(|_|STORE)?;
    connection
        .execute(
            "INSERT INTO portfolio_signatures VALUES(?1,?2,?3)",
            params![
                request.operation_id,
                p.id,
                crate::portfolio_history::financial_hash(&p)?
            ],
        )
        .map_err(|_| STORE)?;
    Ok(())
}
