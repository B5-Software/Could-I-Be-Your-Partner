// SPDX-License-Identifier: GPL-3.0-or-later
//! Immutable Agent identities and inherited signing budgets; no wallet grants.
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
pub struct Scope {
    pub id: String,
    pub subject: String,
    pub label: String,
    pub parent_id: Option<String>,
    pub chain_id: u64,
    pub wallet_ids: Vec<String>,
    pub limits: Rules,
    pub max_fee_wei: String,
    pub expires_at: u64,
}
fn hash(body: &str) -> String {
    hex::encode(Sha256::digest(body.as_bytes()))
}
fn id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
fn subject(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-:".contains(&b))
}
pub fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch("BEGIN IMMEDIATE;
      CREATE TABLE agent_scopes (id TEXT PRIMARY KEY,subject TEXT NOT NULL,chain INTEGER NOT NULL,parent_id TEXT REFERENCES agent_scopes(id),body TEXT NOT NULL,checksum TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('active','paused')),revision INTEGER NOT NULL,UNIQUE(subject,chain)) STRICT;
      CREATE TABLE agent_scope_usage (id TEXT PRIMARY KEY REFERENCES agent_scopes(id),body TEXT NOT NULL,checksum TEXT NOT NULL) STRICT;
      CREATE TABLE agent_scope_signatures (operation_id TEXT PRIMARY KEY REFERENCES receipts(operation_id),leaf_id TEXT NOT NULL REFERENCES agent_scopes(id)) STRICT;
      CREATE TABLE agent_scope_charges (operation_id TEXT NOT NULL REFERENCES agent_scope_signatures(operation_id),scope_id TEXT NOT NULL REFERENCES agent_scopes(id),PRIMARY KEY(operation_id,scope_id)) STRICT;
      CREATE INDEX agent_scope_charge_index ON agent_scope_charges(scope_id);
      CREATE TABLE agent_scope_metadata (id INTEGER PRIMARY KEY CHECK(id=1),scopes INTEGER NOT NULL CHECK(scopes>=0),signatures INTEGER NOT NULL CHECK(signatures>=0)) STRICT;
      INSERT INTO agent_scope_metadata VALUES(1,0,0);PRAGMA user_version=6;COMMIT;").map_err(|_|STORE)
}
fn counts(connection: &Connection) -> Result<()> {
    let (scopes,signatures,expected_scopes,expected_signatures):(i64,i64,i64,i64)=connection.query_row("SELECT (SELECT count(*) FROM agent_scopes),(SELECT count(*) FROM agent_scope_signatures),scopes,signatures FROM agent_scope_metadata WHERE id=1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(|_|STORE)?;
    if scopes != expected_scopes || signatures != expected_signatures {
        return Err(STORE);
    }
    Ok(())
}
fn load(connection: &Connection, key: &str) -> Result<(Scope, String, u64)> {
    type StoredScope = (String, String, String, i64, String, i64, Option<String>);
    let row:Option<StoredScope>=connection.query_row("SELECT body,checksum,state,revision,subject,chain,parent_id FROM agent_scopes WHERE id=?1",[key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional().map_err(|_|STORE)?;
    let (body, checksum, state, revision, subject, chain, parent) =
        row.ok_or("WALLET_AGENT_SCOPE_NOT_FOUND")?;
    if body.len() > 65536 || hash(&body) != checksum {
        return Err(STORE);
    }
    let scope: Scope = serde_json::from_str(&body).map_err(|_| STORE)?;
    if scope.id != key
        || scope.subject != subject
        || scope.chain_id != u64::try_from(chain).map_err(|_| STORE)?
        || scope.parent_id != parent
    {
        return Err(STORE);
    }
    Ok((scope, state, u64::try_from(revision).map_err(|_| STORE)?))
}
fn lineage(connection: &Connection, key: &str) -> Result<Vec<(Scope, String, u64)>> {
    let mut path = vec![];
    let mut next = Some(key.to_string());
    while let Some(key) = next {
        if path.len() >= 8
            || path
                .iter()
                .any(|(s, _, _): &(Scope, String, u64)| s.id == key)
        {
            return Err(STORE);
        }
        let value = load(connection, &key)?;
        if path
            .first()
            .is_some_and(|(s, _, _): &(Scope, String, u64)| s.chain_id != value.0.chain_id)
        {
            return Err(STORE);
        }
        next = value.0.parent_id.clone();
        path.push(value);
    }
    Ok(path)
}
fn usage(connection: &Connection, key: &str) -> Result<Usage> {
    let row: Option<(String, String)> = connection
        .query_row(
            "SELECT body,checksum FROM agent_scope_usage WHERE id=?1",
            [key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|_| STORE)?;
    let used = if let Some((body, checksum)) = row {
        if body.len() > 32768 || hash(&body) != checksum {
            return Err(STORE);
        }
        serde_json::from_str::<Usage>(&body).map_err(|_| STORE)?
    } else {
        Usage::default()
    };
    let count: i64 = connection
        .query_row(
            "SELECT count(*) FROM agent_scope_charges WHERE scope_id=?1",
            [key],
            |r| r.get(0),
        )
        .map_err(|_| STORE)?;
    if used.transactions != u64::try_from(count).map_err(|_| STORE)? {
        return Err(STORE);
    }
    Ok(used)
}
pub fn validate(connection: &Connection) -> Result<()> {
    counts(connection)?;
    let mut statement = connection
        .prepare("SELECT id FROM agent_scopes")
        .map_err(|_| STORE)?;
    let ids = statement
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|_| STORE)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| STORE)?;
    for key in ids {
        lineage(connection, &key)?;
        usage(connection, &key)?;
    }
    let mut statement = connection
        .prepare("SELECT operation_id,leaf_id FROM agent_scope_signatures")
        .map_err(|_| STORE)?;
    let rows = statement
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|_| STORE)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| STORE)?;
    for (operation, leaf) in rows {
        let path = lineage(connection, &leaf)?;
        let mut q = connection
            .prepare("SELECT scope_id FROM agent_scope_charges WHERE operation_id=?1")
            .map_err(|_| STORE)?;
        let charges = q
            .query_map([operation], |r| r.get::<_, String>(0))
            .map_err(|_| STORE)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| STORE)?;
        if charges.len() != path.len() || path.iter().any(|(s, _, _)| !charges.contains(&s.id)) {
            return Err(STORE);
        }
    }
    Ok(())
}
pub fn get(connection: &Connection, key: &str) -> Result<Value> {
    counts(connection)?;
    let path = lineage(connection, key)?;
    let (scope, state, revision) = &path[0];
    let current_time = now()?;
    let mut reason = path.iter().find_map(|(s, state, _)| {
        if state != "active" {
            Some("WALLET_AGENT_SCOPE_PAUSED")
        } else if s.expires_at != 0 && s.expires_at <= current_time {
            Some("WALLET_AGENT_SCOPE_EXPIRED")
        } else {
            None
        }
    });
    let period = crate::periods::snapshot_at(
        connection,
        "scope",
        key,
        scope.limits.period.as_ref(),
        current_time,
    )?;
    for (ancestor, _, _) in &path {
        let snapshot = crate::periods::snapshot_at(
            connection,
            "scope",
            &ancestor.id,
            ancestor.limits.period.as_ref(),
            current_time,
        )?;
        if snapshot["clockRollback"] == true && reason.is_none() {
            reason = Some("WALLET_PERIOD_CLOCK_ROLLBACK");
        }
    }
    Ok(
        json!({"scope":scope,"state":state,"revision":revision,"ready":reason.is_none(),"reason":reason,"path":path.iter().map(|(s,_,_)|s.id.clone()).collect::<Vec<_>>(),"rootSubject":path.last().ok_or(STORE)?.0.subject,"usage":usage(connection,key)?,"period":period}),
    )
}
pub fn list(connection: &Connection, offset: u32, actor: Option<&str>) -> Result<Value> {
    counts(connection)?;
    if offset > 10000 {
        return Err("WALLET_AGENT_SCOPE_INVALID");
    }
    if let Some(key) = actor {
        load(connection, key)?;
    }
    let cte = "WITH RECURSIVE subtree(id) AS (SELECT id FROM agent_scopes WHERE (?1 IS NULL AND parent_id IS NULL) OR id=?1 UNION ALL SELECT a.id FROM agent_scopes a JOIN subtree s ON a.parent_id=s.id) ";
    let total: u32 = connection
        .query_row(
            &(cte.to_string() + "SELECT count(*) FROM subtree"),
            [actor],
            |r| r.get(0),
        )
        .map_err(|_| STORE)?;
    let mut q = connection
        .prepare(&(cte.to_string()+"SELECT a.id FROM agent_scopes a JOIN subtree s ON a.id=s.id ORDER BY a.rowid DESC LIMIT 20 OFFSET ?2"))
        .map_err(|_| STORE)?;
    let ids = q
        .query_map(params![actor, offset], |r| r.get::<_, String>(0))
        .map_err(|_| STORE)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| STORE)?;
    let mut items = vec![];
    for key in ids {
        let (s, state, revision) = load(connection, &key)?;
        items.push(json!({"id":s.id,"subject":s.subject,"label":s.label,"parentId":s.parent_id,"chainId":s.chain_id,"walletIds":s.wallet_ids,"expiresAt":s.expires_at,"state":state,"revision":revision}));
    }
    Ok(json!({"items":items,"total":total,"next":if offset+20<total {Some(offset+20)}else{None}}))
}
pub fn ensure(connection: &Connection, s: &Scope) -> Result<Value> {
    counts(connection)?;
    if !id(&s.id)
        || !subject(&s.subject)
        || s.label.chars().count() > 80
        || s.label.chars().any(char::is_control)
        || ![8453, 84532].contains(&s.chain_id)
        || s.wallet_ids.len() > 16
        || s.wallet_ids.iter().any(|v| !id(v))
    {
        return Err("WALLET_AGENT_SCOPE_INVALID");
    }
    s.limits.validate()?;
    quantity(&s.max_fee_wei)?;
    if s.limits.tokens.iter().any(|t| t.chain_id != s.chain_id) {
        return Err("WALLET_AGENT_SCOPE_INVALID");
    }
    if s.limits
        .period
        .as_ref()
        .is_some_and(|p| p.tokens.iter().any(|t| t.chain_id != s.chain_id))
    {
        return Err("WALLET_PERIOD_INVALID");
    }
    let body = serde_json::to_string(s).map_err(|_| STORE)?;
    if body.len() > 65536 {
        return Err("WALLET_AGENT_SCOPE_INVALID");
    }
    if connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_scopes WHERE id=?1)",
            [&s.id],
            |r| r.get::<_, bool>(0),
        )
        .map_err(|_| STORE)?
    {
        let (saved, _, _) = load(connection, &s.id)?;
        let mut expected = serde_json::to_value(s).map_err(|_| STORE)?;
        let mut previous = serde_json::to_value(saved).map_err(|_| STORE)?;
        expected.as_object_mut().ok_or(STORE)?.remove("label");
        previous.as_object_mut().ok_or(STORE)?.remove("label");
        if expected != previous {
            return Err("WALLET_AGENT_SCOPE_CHANGED");
        }
        return get(connection, &s.id);
    }
    if s.expires_at != 0 && s.expires_at <= now()? {
        return Err("WALLET_AGENT_SCOPE_EXPIRED");
    }
    let duplicate: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_scopes WHERE subject=?1 AND chain=?2)",
            params![s.subject, s.chain_id as i64],
            |r| r.get(0),
        )
        .map_err(|_| STORE)?;
    if duplicate {
        return Err("WALLET_AGENT_SCOPE_CHANGED");
    }
    if let Some(parent) = &s.parent_id {
        let path = lineage(connection, parent)?;
        if path.len() >= 8 {
            return Err("WALLET_AGENT_SCOPE_INVALID");
        }
        for (p, state, _) in &path {
            if state != "active" {
                return Err("WALLET_AGENT_SCOPE_PAUSED");
            }
            if p.expires_at != 0 && p.expires_at <= now()? {
                return Err("WALLET_AGENT_SCOPE_EXPIRED");
            }
        }
        let p = &path[0].0;
        if p.chain_id != s.chain_id
            || (p.expires_at != 0 && (s.expires_at == 0 || s.expires_at > p.expires_at))
            || (!p.wallet_ids.is_empty()
                && (s.wallet_ids.is_empty()
                    || s.wallet_ids.iter().any(|v| !p.wallet_ids.contains(v))))
        {
            return Err("WALLET_AGENT_SCOPE_WIDENING");
        }
        let max = quantity(&p.max_fee_wei)?;
        let child = quantity(&s.max_fee_wei)?;
        if max != ethnum::U256::ZERO && (child == ethnum::U256::ZERO || child > max) {
            return Err("WALLET_AGENT_SCOPE_WIDENING");
        }
        s.limits.subset_of(&p.limits)?;
    }
    let count: i64 = connection
        .query_row(
            "SELECT scopes FROM agent_scope_metadata WHERE id=1",
            [],
            |r| r.get(0),
        )
        .map_err(|_| STORE)?;
    if count >= 10000 {
        return Err("WALLET_NATIVE_AUTH_LIMIT");
    }
    let parent_period = if let Some(parent) = &s.parent_id {
        let (p, _, _) = load(connection, parent)?;
        p.limits.period.is_some()
    } else {
        false
    };
    crate::periods::register(
        connection,
        "scope",
        &s.id,
        s.limits.period.as_ref(),
        if parent_period {
            s.parent_id.as_deref().map(|id| ("scope", id))
        } else {
            None
        },
        now()?,
    )?;
    connection
        .execute(
            "INSERT INTO agent_scopes VALUES(?1,?2,?3,?4,?5,?6,'active',1)",
            params![
                s.id,
                s.subject,
                s.chain_id as i64,
                s.parent_id,
                body,
                hash(&body)
            ],
        )
        .map_err(|_| STORE)?;
    connection
        .execute(
            "UPDATE agent_scope_metadata SET scopes=scopes+1 WHERE id=1",
            [],
        )
        .map_err(|_| STORE)?;
    get(connection, &s.id)
}
pub fn state(
    connection: &Connection,
    key: &str,
    next: &str,
    expected: u64,
    actor: Option<&str>,
) -> Result<Value> {
    counts(connection)?;
    let path = lineage(connection, key)?;
    let revision = path[0].2;
    if !["active", "paused"].contains(&next) || expected != revision || revision >= 9007199254740991
    {
        return Err("WALLET_AGENT_SCOPE_CHANGED");
    }
    if let Some(actor) = actor
        && (next != "paused" || !path.iter().any(|(s, _, _)| s.id == actor))
    {
        return Err("WALLET_AGENT_SCOPE_FORBIDDEN");
    }
    if next == "active" {
        let current_time = now()?;
        for (index, (scope, state, _)) in path.iter().enumerate() {
            if scope.expires_at != 0 && scope.expires_at <= current_time {
                return Err("WALLET_AGENT_SCOPE_EXPIRED");
            }
            if index != 0 && state != "active" {
                return Err("WALLET_AGENT_SCOPE_PAUSED");
            }
        }
    }
    connection
        .execute(
            "UPDATE agent_scopes SET state=?1,revision=revision+1 WHERE id=?2",
            params![next, key],
        )
        .map_err(|_| STORE)?;
    get(connection, key)
}
fn path_for(connection: &Connection, r: &Check<'_>) -> Result<Vec<(Scope, String, u64)>> {
    counts(connection)?;
    let previous: Option<String> = connection
        .query_row(
            "SELECT leaf_id FROM agent_scope_signatures WHERE operation_id=?1",
            [r.operation_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| STORE)?;
    let Some(key) = r.agent_scope_id else {
        if previous.is_some() || r.agent_subject.is_some() {
            return Err("WALLET_AGENT_SCOPE_REQUIRED");
        }
        return Ok(vec![]);
    };
    let path = lineage(connection, key)?;
    if r.agent_subject != Some(path[0].0.subject.as_str())
        || path[0].0.chain_id != r.transaction.chain_id
    {
        return Err("WALLET_AGENT_SCOPE_FORBIDDEN");
    }
    if r.replay && previous.as_deref() != Some(key) {
        return Err("WALLET_AGENT_SCOPE_OLD_SIGNATURE");
    }
    for (s, state, _) in &path {
        if state != "active" {
            return Err("WALLET_AGENT_SCOPE_PAUSED");
        }
        if s.expires_at != 0 && s.expires_at <= now()? {
            return Err("WALLET_AGENT_SCOPE_EXPIRED");
        }
        if !s.wallet_ids.is_empty() && !s.wallet_ids.iter().any(|id| id == r.wallet_id) {
            return Err("WALLET_AGENT_SCOPE_FORBIDDEN");
        }
    }
    Ok(path)
}
fn charged(connection: &Connection, s: &Scope, r: &Check<'_>) -> Result<Usage> {
    crate::periods::check(connection, "scope", &s.id, s.limits.period.as_ref(), r)?;
    let mut u = usage(connection, &s.id)?;
    let fee = quantity(r.fee_reserve_wei)?;
    let max = quantity(&s.max_fee_wei)?;
    if max != ethnum::U256::ZERO && fee > max {
        return Err("WALLET_AGENT_SCOPE_LIMIT");
    }
    if !r.replay
        && r.policy_id.is_some()
        && r.replacement_of.is_some()
        && !s.limits.allow_replacement
    {
        return Err("WALLET_AGENT_SCOPE_LIMIT");
    }
    s.limits
        .check(r.transaction, fee, &u, r.replay)
        .map_err(|_| "WALLET_AGENT_SCOPE_LIMIT")?;
    crate::tokens::consume(
        &s.limits.tokens,
        &mut u.tokens,
        &crate::tokens::analyze(r.transaction, r.address),
        r.replay,
    )?;
    if !r.replay {
        u.value_wei = quantity(&u.value_wei)?
            .checked_add(quantity(&r.transaction.value)?)
            .ok_or("WALLET_AGENT_SCOPE_LIMIT")?
            .to_string();
        u.fee_wei = quantity(&u.fee_wei)?
            .checked_add(fee)
            .ok_or("WALLET_AGENT_SCOPE_LIMIT")?
            .to_string();
        u.transactions = u
            .transactions
            .checked_add(1)
            .ok_or("WALLET_AGENT_SCOPE_LIMIT")?;
    }
    Ok(u)
}
pub fn check(connection: &Connection, r: &Check<'_>) -> Result<()> {
    for (s, _, _) in path_for(connection, r)? {
        charged(connection, &s, r)?;
    }
    Ok(())
}
pub fn consume(connection: &Connection, r: &Check<'_>) -> Result<()> {
    let path = path_for(connection, r)?;
    if path.is_empty() {
        return Ok(());
    }
    connection
        .execute(
            "INSERT INTO agent_scope_signatures VALUES(?1,?2)",
            params![r.operation_id, path[0].0.id],
        )
        .map_err(|_| STORE)?;
    for (s, _, _) in path {
        let u = charged(connection, &s, r)?;
        crate::periods::consume(connection, "scope", &s.id, s.limits.period.as_ref(), r)?;
        let body = serde_json::to_string(&u).map_err(|_| STORE)?;
        if body.len() > 32768 {
            return Err(STORE);
        }
        connection.execute("INSERT INTO agent_scope_usage VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET body=excluded.body,checksum=excluded.checksum",params![s.id,body,hash(&body)]).map_err(|_|STORE)?;
        connection
            .execute(
                "INSERT INTO agent_scope_charges VALUES(?1,?2)",
                params![r.operation_id, s.id],
            )
            .map_err(|_| STORE)?;
    }
    connection
        .execute(
            "UPDATE agent_scope_metadata SET signatures=signatures+1 WHERE id=1",
            [],
        )
        .map_err(|_| STORE)?;
    Ok(())
}
