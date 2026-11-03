// SPDX-License-Identifier: GPL-3.0-or-later
//! Private control-plane approvals. No Agent-facing endpoint grants authority.
use crate::{Result, evm::Transaction, receipts::Receipt};
use ethnum::U256;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
const STORE: &str = "WALLET_RECEIPT_STORE_FAILED";
pub fn now() -> Result<u64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|time| time.as_millis() as u64)
        .map_err(|_| "WALLET_CLOCK_UNAVAILABLE")
}
pub fn quantity(text: &str) -> Result<U256> {
    if text.is_empty() || text.len() > 78 || !text.bytes().all(|b| b.is_ascii_digit()) {
        return Err("WALLET_NATIVE_AUTH_INVALID");
    }
    text.parse().map_err(|_| "WALLET_NATIVE_AUTH_INVALID")
}
fn identifier(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 128
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_:".contains(&b))
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Grant {
    #[serde(default)]
    pub require_agent_scope: bool,
    #[serde(default)]
    pub authority_version: u8,
    #[serde(default)]
    pub limits: crate::scope::Rules,
    #[serde(default)]
    pub generation: u64,
    pub policy_id: String,
    pub wallet_id: String,
    pub address: String,
    pub chains: Vec<u64>,
    pub expires_at: u64,
    pub max_fee_wei: String,
}
impl Grant {
    pub fn validate(&self) -> Result<()> {
        if self.authority_version != 2
            || !identifier(&self.policy_id)
            || !identifier(&self.wallet_id)
            || self.address.len() != 42
            || !self.address.starts_with("0x")
            || !self.address[2..].bytes().all(|b| b.is_ascii_hexdigit())
            || self.chains.is_empty()
            || self.chains.len() > 2
            || self.chains.iter().any(|c| ![8453, 84532].contains(c))
            || (self.expires_at != 0 && self.expires_at <= now()?)
        {
            return Err("WALLET_NATIVE_AUTH_INVALID");
        }
        quantity(&self.max_fee_wei)?;
        self.limits.validate()?;
        if self
            .limits
            .tokens
            .iter()
            .any(|token| !self.chains.contains(&token.chain_id))
        {
            return Err("WALLET_NATIVE_AUTH_INVALID");
        }
        if self
            .limits
            .period
            .as_ref()
            .is_some_and(|p| p.tokens.iter().any(|t| !self.chains.contains(&t.chain_id)))
        {
            return Err("WALLET_PERIOD_INVALID");
        }
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Approval {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_scope_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_subject: Option<String>,
    pub wallet_id: String,
    pub address: String,
    pub unsigned_hash: String,
    pub session: String,
    pub expires_at: u64,
    pub fee_reserve_wei: String,
    pub replacement_of: Option<String>,
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Execution {
    pub plan_id: String,
    pub scope_hash: String,
    pub fee_budget_wei: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Plan {
    wallet_id: String,
    address: String,
    chain_id: u64,
    scope_hash: String,
    fee_budget_wei: String,
    used_fee_wei: String,
}
pub struct Check<'a> {
    pub checked_at_ms: u64,
    pub agent_scope_id: Option<&'a str>,
    pub agent_subject: Option<&'a str>,
    pub replacement_of: Option<&'a str>,
    pub expires_at: u64,
    pub wallet_id: &'a str,
    pub address: &'a str,
    pub operation_id: &'a str,
    pub session: &'a str,
    pub transaction: &'a Transaction,
    pub unsigned_hash: &'a str,
    pub fee_reserve_wei: &'a str,
    pub policy_id: Option<&'a str>,
    pub execution: Option<&'a Execution>,
    pub replay: bool,
}
pub fn initialize(connection: &mut Connection) -> Result<()> {
    let version: u32 = connection
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|_| STORE)?;
    if version > 7 {
        return Err(STORE);
    }
    if version == 0 {
        let tx = connection.transaction().map_err(|_| STORE)?;
        tx.execute_batch("CREATE TABLE grants (id TEXT PRIMARY KEY,body TEXT NOT NULL,checksum TEXT NOT NULL,revoked INTEGER NOT NULL CHECK(revoked IN(0,1))) STRICT;
            CREATE TABLE approvals (id TEXT PRIMARY KEY,body TEXT NOT NULL,checksum TEXT NOT NULL) STRICT;
            CREATE TABLE plans (id TEXT PRIMARY KEY,body TEXT NOT NULL,checksum TEXT NOT NULL) STRICT;
            CREATE TABLE nonce_locks (address TEXT NOT NULL,chain INTEGER NOT NULL,nonce INTEGER NOT NULL,operation_id TEXT NOT NULL REFERENCES receipts(operation_id),PRIMARY KEY(address,chain,nonce)) STRICT;
            CREATE TABLE authorization_usage (operation_id TEXT PRIMARY KEY REFERENCES receipts(operation_id),authority TEXT NOT NULL,plan TEXT,fee TEXT NOT NULL) STRICT;
            CREATE TABLE authority_fences (wallet_id TEXT PRIMARY KEY,generation INTEGER NOT NULL) STRICT;
            CREATE TABLE denials (operation_id TEXT PRIMARY KEY) STRICT;
            PRAGMA user_version=2;").map_err(|_|STORE)?;
        {
            let mut statement = tx
                .prepare("SELECT body FROM receipts ORDER BY rowid")
                .map_err(|_| STORE)?;
            let mut rows = statement.query([]).map_err(|_| STORE)?;
            while let Some(row) = rows.next().map_err(|_| STORE)? {
                let body: String = row.get(0).map_err(|_| STORE)?;
                let receipt: Receipt = serde_json::from_str(&body).map_err(|_| STORE)?;
                record_nonce(&tx, &receipt)?;
            }
        }
        tx.commit().map_err(|_| STORE)?;
    }
    if version == 1 {
        connection.execute_batch("BEGIN IMMEDIATE;CREATE TABLE authority_fences (wallet_id TEXT PRIMARY KEY,generation INTEGER NOT NULL) STRICT;
            CREATE TABLE denials (operation_id TEXT PRIMARY KEY) STRICT;UPDATE grants SET revoked=1;PRAGMA user_version=2;COMMIT;").map_err(|_|STORE)?;
    }
    if version <= 2 {
        // Old grants did not have the new aggregate counters. Require a fresh
        // human grant rather than inventing zero historical consumption.
        connection.execute_batch("BEGIN IMMEDIATE;CREATE TABLE grant_usage (id TEXT PRIMARY KEY,body TEXT NOT NULL,checksum TEXT NOT NULL) STRICT;
            CREATE INDEX authority_usage_index ON authorization_usage(authority);UPDATE grants SET revoked=1;PRAGMA user_version=3;COMMIT;").map_err(|_|STORE)?;
    }
    if version <= 3 {
        crate::portfolio::initialize(connection)?;
    }
    if version == 4 {
        crate::portfolio::upgrade(connection)?;
    }
    crate::portfolio::validate(connection)?;
    if version <= 5 {
        crate::agent_scopes::initialize(connection)?;
    }
    crate::agent_scopes::validate(connection)?;
    if version <= 6 {
        crate::periods::initialize(connection)?;
    }
    crate::periods::validate(connection)?;
    crate::portfolio_history::validate(connection)?;
    Ok(())
}
fn usage(connection: &Connection, id: &str) -> Result<crate::scope::Usage> {
    let usage: crate::scope::Usage = read(connection, "grant_usage", id)?.unwrap_or_default();
    let count: i64 = connection
        .query_row(
            "SELECT count(*) FROM authorization_usage WHERE authority=?1",
            [id],
            |r| r.get(0),
        )
        .map_err(|_| STORE)?;
    if usage.transactions != u64::try_from(count).map_err(|_| STORE)? {
        return Err(STORE);
    }
    Ok(usage)
}
fn read<T: DeserializeOwned>(connection: &Connection, table: &str, id: &str) -> Result<Option<T>> {
    let sql = match table {
        "grants" => "SELECT body,checksum FROM grants WHERE id=?1",
        "approvals" => "SELECT body,checksum FROM approvals WHERE id=?1",
        "plans" => "SELECT body,checksum FROM plans WHERE id=?1",
        "grant_usage" => "SELECT body,checksum FROM grant_usage WHERE id=?1",
        _ => return Err(STORE),
    };
    let row: Option<(String, String)> = connection
        .query_row(sql, [id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(|_| STORE)?;
    row.map(|(body, checksum)| {
        if body.len() > 65536 || hex::encode(Sha256::digest(body.as_bytes())) != checksum {
            return Err(STORE);
        }
        serde_json::from_str(&body).map_err(|_| STORE)
    })
    .transpose()
}
fn put<T: Serialize>(connection: &Connection, table: &str, id: &str, value: &T) -> Result<()> {
    let sql = match table {
        "grants" => "INSERT INTO grants VALUES(?1,?2,?3,0)",
        "approvals" => {
            "INSERT INTO approvals VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET body=excluded.body,checksum=excluded.checksum"
        }
        "plans" => {
            "INSERT INTO plans VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET body=excluded.body,checksum=excluded.checksum"
        }
        "grant_usage" => {
            "INSERT INTO grant_usage VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET body=excluded.body,checksum=excluded.checksum"
        }
        _ => return Err(STORE),
    };
    let body = serde_json::to_string(value).map_err(|_| STORE)?;
    if body.len() > 65536 {
        return Err("WALLET_NATIVE_AUTH_LIMIT");
    }
    connection
        .execute(
            sql,
            params![id, body, hex::encode(Sha256::digest(body.as_bytes()))],
        )
        .map_err(|_| STORE)?;
    Ok(())
}
pub fn grant(connection: &Connection, value: &Grant) -> Result<()> {
    value.validate()?;
    if value.generation != generation(connection, &value.wallet_id)? {
        return Err("WALLET_NATIVE_AUTH_CHANGED");
    }
    if read::<Grant>(connection, "grants", &value.policy_id)?.is_some() {
        return Err("WALLET_NATIVE_AUTH_CONFLICT");
    }
    let count: i64 = connection
        .query_row("SELECT count(*) FROM grants", [], |r| r.get(0))
        .map_err(|_| STORE)?;
    if count >= 10000 {
        return Err("WALLET_NATIVE_AUTH_LIMIT");
    }
    crate::periods::register(
        connection,
        "grant",
        &value.policy_id,
        value.limits.period.as_ref(),
        None,
        now()?,
    )?;
    put(connection, "grants", &value.policy_id, value)
}
pub fn generation(connection: &Connection, wallet: &str) -> Result<u64> {
    let value: Option<i64> = connection
        .query_row(
            "SELECT generation FROM authority_fences WHERE wallet_id=?1",
            [wallet],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| STORE)?;
    u64::try_from(value.unwrap_or(0)).map_err(|_| STORE)
}
pub fn inspect(connection: &Connection, wallet: &str, policy: &str) -> Result<serde_json::Value> {
    let grant: Grant = read(connection, "grants", policy)?.ok_or("WALLET_NATIVE_AUTH_REQUIRED")?;
    if grant.wallet_id != wallet {
        return Err("WALLET_NATIVE_AUTH_REQUIRED");
    }
    let revoked: bool = connection
        .query_row("SELECT revoked FROM grants WHERE id=?1", [policy], |r| {
            r.get(0)
        })
        .map_err(|_| STORE)?;
    Ok(
        serde_json::json!({"policyId":policy,"revoked":revoked,"generation":generation(connection,wallet)?,"expiresAt":grant.expires_at,"limits":grant.limits,"usage":usage(connection,policy)?,"period":crate::periods::snapshot(connection,"grant",policy,grant.limits.period.as_ref())?}),
    )
}
pub fn revoke(connection: &Connection, wallet: &str) -> Result<u64> {
    // Wallet ID is an indexed property of the typed body, never interpolated SQL.
    let mut statement = connection
        .prepare("SELECT id FROM grants WHERE revoked=0")
        .map_err(|_| STORE)?;
    let ids = statement
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|_| STORE)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| STORE)?;
    for id in ids {
        let value: Grant = read(connection, "grants", &id)?.ok_or(STORE)?;
        if value.wallet_id == wallet {
            connection
                .execute("UPDATE grants SET revoked=1 WHERE id=?1", [id])
                .map_err(|_| STORE)?;
        }
    }
    let generation = generation(connection, wallet)?
        .checked_add(1)
        .filter(|g| *g <= 9007199254740991)
        .ok_or(STORE)?;
    connection.execute("INSERT INTO authority_fences VALUES(?1,?2) ON CONFLICT(wallet_id) DO UPDATE SET generation=excluded.generation",params![wallet,generation as i64]).map_err(|_|STORE)?;
    Ok(generation)
}
pub fn approve(connection: &Connection, id: &str, value: &Approval) -> Result<()> {
    if value.expires_at <= now()?
        || value.expires_at > now()? + 300000
        || !identifier(id)
        || value.unsigned_hash.len() != 66
    {
        return Err("WALLET_NATIVE_AUTH_INVALID");
    }
    quantity(&value.fee_reserve_wei)?;
    // A manual confirmation is single-use. Repeating it cannot mutate an
    // existing operation into a different transaction or fee allowance.
    if let Some(previous) = read::<Approval>(connection, "approvals", id)?
        && (previous.wallet_id != value.wallet_id
            || previous.address != value.address
            || previous.unsigned_hash != value.unsigned_hash
            || previous.fee_reserve_wei != value.fee_reserve_wei
            || previous.replacement_of != value.replacement_of
            || previous.agent_scope_id != value.agent_scope_id
            || previous.agent_subject != value.agent_subject)
    {
        return Err("WALLET_NATIVE_AUTH_CONFLICT");
    }
    put(connection, "approvals", id, value)
}
pub fn nonce(
    connection: &Connection,
    address: &str,
    chain: u64,
    nonce: u64,
) -> Result<Option<String>> {
    let chain = i64::try_from(chain).map_err(|_| STORE)?;
    let nonce = i64::try_from(nonce).map_err(|_| STORE)?;
    connection.query_row("SELECT r.body FROM nonce_locks n JOIN receipts r ON n.operation_id=r.operation_id WHERE n.address=?1 AND n.chain=?2 AND n.nonce=?3",params![address.to_ascii_lowercase(),chain,nonce],|r|r.get::<_,String>(0)).optional().map_err(|_|STORE)?
        .map(|body|serde_json::from_str::<Receipt>(&body).map(|r|r.hash.clone()).map_err(|_|STORE)).transpose()
}
pub(crate) fn record_nonce(connection: &Connection, receipt: &Receipt) -> Result<()> {
    let chain = i64::try_from(receipt.chain_id).map_err(|_| STORE)?;
    let nonce = i64::try_from(receipt.nonce).map_err(|_| STORE)?;
    connection.execute("INSERT INTO nonce_locks VALUES(?1,?2,?3,?4) ON CONFLICT(address,chain,nonce) DO UPDATE SET operation_id=excluded.operation_id",params![receipt.address.to_ascii_lowercase(),chain,nonce,receipt.operation_id]).map_err(|_|STORE)?;
    Ok(())
}
pub fn check(connection: &Connection, request: &Check<'_>) -> Result<()> {
    crate::agent_scopes::check(connection, request)?;
    crate::portfolio::check(connection, request)?;
    if request.expires_at <= now()? {
        return Err("WALLET_INTENT_EXPIRED");
    }
    if request.replay {
        let usage: Option<(String, Option<String>, String)> = connection
            .query_row(
                "SELECT authority,plan,fee FROM authorization_usage WHERE operation_id=?1",
                [request.operation_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|_| STORE)?;
        if let Some((authority, plan, fee)) = usage
            && (authority != request.policy_id.unwrap_or("manual")
                || plan.as_deref() != request.execution.map(|e| e.plan_id.as_str())
                || fee != request.fee_reserve_wei)
        {
            return Err("WALLET_NATIVE_AUTH_CONFLICT");
        }
    }
    let denied: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM denials WHERE operation_id=?1)",
            [request.operation_id],
            |r| r.get(0),
        )
        .map_err(|_| STORE)?;
    if denied {
        return Err("WALLET_NATIVE_AUTH_REQUIRED");
    }
    let fee = quantity(request.fee_reserve_wei)?;
    let min_fee = quantity(&request.transaction.gas_limit)?
        .checked_mul(quantity(&request.transaction.max_fee_per_gas)?)
        .ok_or("WALLET_NATIVE_FEE_LIMIT")?;
    if fee < min_fee {
        return Err("WALLET_NATIVE_FEE_LIMIT");
    }
    let replacement = nonce(
        connection,
        request.address,
        request.transaction.chain_id,
        request.transaction.nonce,
    )?;
    if let Some(policy_id) = request.policy_id {
        let value: Grant =
            read(connection, "grants", policy_id)?.ok_or("WALLET_NATIVE_AUTH_REQUIRED")?;
        let revoked: i32 = connection
            .query_row("SELECT revoked FROM grants WHERE id=?1", [policy_id], |r| {
                r.get(0)
            })
            .map_err(|_| STORE)?;
        if value.authority_version != 2
            || revoked != 0
            || value.generation != generation(connection, request.wallet_id)?
            || value.wallet_id != request.wallet_id
            || !value.address.eq_ignore_ascii_case(request.address)
            || !value.chains.contains(&request.transaction.chain_id)
            || (value.expires_at != 0 && value.expires_at <= now()?)
        {
            return Err("WALLET_NATIVE_AUTH_REQUIRED");
        }
        let max = quantity(&value.max_fee_wei)?;
        if value.require_agent_scope
            && (request.agent_scope_id.is_none() || request.agent_subject.is_none())
        {
            return Err("WALLET_AGENT_SCOPE_REQUIRED");
        }
        if max != U256::ZERO && fee > max {
            return Err("WALLET_NATIVE_FEE_LIMIT");
        }
        let mut used = usage(connection, policy_id)?;
        crate::periods::check(
            connection,
            "grant",
            policy_id,
            value.limits.period.as_ref(),
            request,
        )?;
        value
            .limits
            .check(request.transaction, fee, &used, request.replay)?;
        crate::tokens::consume(
            &value.limits.tokens,
            &mut used.tokens,
            &crate::tokens::analyze(request.transaction, request.address),
            request.replay,
        )?;
        if !request.replay && replacement.as_deref() != request.replacement_of {
            return Err("WALLET_NATIVE_NONCE_CONFIRMATION");
        }
        if replacement.is_some() && !request.replay && !value.limits.allow_replacement {
            return Err("WALLET_NATIVE_NONCE_CONFIRMATION");
        }
    } else {
        let value: Approval = read(connection, "approvals", request.operation_id)?
            .ok_or("WALLET_NATIVE_APPROVAL_REQUIRED")?;
        if value.wallet_id != request.wallet_id
            || !value.address.eq_ignore_ascii_case(request.address)
            || value.session != request.session
            || value.agent_scope_id.as_deref() != request.agent_scope_id
            || value.agent_subject.as_deref() != request.agent_subject
            || value.unsigned_hash != request.unsigned_hash
            || value.fee_reserve_wei != request.fee_reserve_wei
            || value.expires_at <= now()?
        {
            return Err("WALLET_NATIVE_APPROVAL_REQUIRED");
        }
        if !request.replay && value.replacement_of != replacement {
            return Err("WALLET_NATIVE_NONCE_CONFIRMATION");
        }
    }
    if let Some(execution) = request.execution {
        if !identifier(&execution.plan_id)
            || execution.scope_hash.len() != 64
            || quantity(&execution.fee_budget_wei)? == U256::ZERO
        {
            return Err("WALLET_NATIVE_AUTH_INVALID");
        }
        let used = if let Some(plan) = read::<Plan>(connection, "plans", &execution.plan_id)? {
            if plan.wallet_id != request.wallet_id
                || !plan.address.eq_ignore_ascii_case(request.address)
                || plan.chain_id != request.transaction.chain_id
                || plan.scope_hash != execution.scope_hash
                || plan.fee_budget_wei != execution.fee_budget_wei
            {
                return Err("WALLET_NATIVE_PLAN_CHANGED");
            }
            quantity(&plan.used_fee_wei)?
        } else {
            U256::ZERO
        };
        if !request.replay
            && used.checked_add(fee).ok_or("WALLET_NATIVE_FEE_LIMIT")?
                > quantity(&execution.fee_budget_wei)?
        {
            return Err("WALLET_NATIVE_PLAN_BUDGET");
        }
    }
    Ok(())
}
pub fn consume(connection: &Connection, receipt: &Receipt, request: &Check<'_>) -> Result<()> {
    check(connection, request)?;
    crate::agent_scopes::consume(connection, request)?;
    crate::portfolio::consume(connection, request)?;
    record_nonce(connection, receipt)?;
    if let Some(policy_id) = request.policy_id {
        let mut previous = usage(connection, policy_id)?;
        let grant: Grant =
            read(connection, "grants", policy_id)?.ok_or("WALLET_NATIVE_AUTH_REQUIRED")?;
        crate::periods::consume(
            connection,
            "grant",
            policy_id,
            grant.limits.period.as_ref(),
            request,
        )?;
        crate::tokens::consume(
            &grant.limits.tokens,
            &mut previous.tokens,
            &crate::tokens::analyze(request.transaction, request.address),
            false,
        )?;
        let next = crate::scope::Usage {
            value_wei: quantity(&previous.value_wei)?
                .checked_add(quantity(&request.transaction.value)?)
                .ok_or("WALLET_NATIVE_SCOPE_LIMIT")?
                .to_string(),
            fee_wei: quantity(&previous.fee_wei)?
                .checked_add(quantity(request.fee_reserve_wei)?)
                .ok_or("WALLET_NATIVE_SCOPE_LIMIT")?
                .to_string(),
            transactions: previous
                .transactions
                .checked_add(1)
                .ok_or("WALLET_NATIVE_SCOPE_LIMIT")?,
            tokens: previous.tokens,
        };
        put(connection, "grant_usage", policy_id, &next)?;
    }
    if let Some(execution) = request.execution {
        let previous: Option<Plan> = read(connection, "plans", &execution.plan_id)?;
        let used = previous
            .map(|p| quantity(&p.used_fee_wei))
            .transpose()?
            .unwrap_or(U256::ZERO);
        let plan = Plan {
            wallet_id: request.wallet_id.into(),
            address: request.address.into(),
            chain_id: request.transaction.chain_id,
            scope_hash: execution.scope_hash.clone(),
            fee_budget_wei: execution.fee_budget_wei.clone(),
            used_fee_wei: used
                .checked_add(quantity(request.fee_reserve_wei)?)
                .ok_or("WALLET_NATIVE_FEE_LIMIT")?
                .to_string(),
        };
        put(connection, "plans", &execution.plan_id, &plan)?;
    }
    connection
        .execute(
            "INSERT INTO authorization_usage VALUES(?1,?2,?3,?4)",
            params![
                receipt.operation_id,
                request.policy_id.unwrap_or("manual"),
                request.execution.map(|e| e.plan_id.as_str()),
                request.fee_reserve_wei
            ],
        )
        .map_err(|_| STORE)?;
    Ok(())
}
