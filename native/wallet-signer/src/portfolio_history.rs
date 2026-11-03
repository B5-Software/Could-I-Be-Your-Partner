// SPDX-License-Identifier: GPL-3.0-or-later
use crate::{Result, authority::now, portfolio::Portfolio};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
const STORE: &str = "WALLET_RECEIPT_STORE_FAILED";
fn hash(body: &str) -> String {
    hex::encode(Sha256::digest(body.as_bytes()))
}
pub fn financial_hash(p: &Portfolio) -> Result<String> {
    Ok(hash(&serde_json::to_string(&json!({"chainId":p.chain_id,"members":p.members,"limits":p.limits,"maxFeeWei":p.max_fee_wei,"expiresAt":p.expires_at})).map_err(|_|STORE)?))
}
fn counts(c: &Connection) -> Result<()> {
    let (a,e):(i64,i64)=c.query_row("SELECT (SELECT count(*) FROM portfolio_revisions),entries FROM portfolio_revision_metadata WHERE id=1",[],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_|STORE)?;
    if a != e {
        return Err(STORE);
    }
    Ok(())
}
pub fn record(c: &Connection, p: &Portfolio, state: &str, revision: u64, kind: &str) -> Result<()> {
    counts(c)?;
    let body = serde_json::to_string(p).map_err(|_| STORE)?;
    c.execute(
        "INSERT INTO portfolio_revisions VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![
            p.id,
            revision as i64,
            body,
            hash(&body),
            state,
            now()? as i64,
            kind
        ],
    )
    .map_err(|_| STORE)?;
    c.execute(
        "UPDATE portfolio_revision_metadata SET entries=entries+1 WHERE id=1",
        [],
    )
    .map_err(|_| STORE)?;
    Ok(())
}
pub fn get(c: &Connection, id: &str, revision: u64) -> Result<Value> {
    counts(c)?;
    if revision == 0 || revision > 9007199254740991 {
        return Err("WALLET_PORTFOLIO_INVALID");
    }
    let (body,checksum,state,time,kind):(String,String,String,i64,String)=c.query_row("SELECT body,checksum,state,changed_ms,kind FROM portfolio_revisions WHERE id=?1 AND revision=?2",params![id,revision as i64],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).map_err(|_|STORE)?;
    if hash(&body) != checksum || body.len() > 65536 {
        return Err(STORE);
    }
    let p: Portfolio = serde_json::from_str(&body).map_err(|_| STORE)?;
    if p.id != id {
        return Err(STORE);
    }
    Ok(json!({"portfolio":p,"state":state,"revision":revision,"changedAt":time,"kind":kind}))
}
pub fn list(c: &Connection, id: &str, offset: u32) -> Result<Value> {
    if offset > 200000 {
        return Err("WALLET_PORTFOLIO_INVALID");
    }
    crate::portfolio::load(c, id)?;
    let total: u32 = c
        .query_row(
            "SELECT count(*) FROM portfolio_revisions WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .map_err(|_| STORE)?;
    let mut q=c.prepare("SELECT revision FROM portfolio_revisions WHERE id=?1 ORDER BY revision DESC LIMIT 20 OFFSET ?2").map_err(|_|STORE)?;
    let ids = q
        .query_map(params![id, offset], |r| r.get::<_, i64>(0))
        .map_err(|_| STORE)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| STORE)?;
    let mut items = vec![];
    for rev in ids {
        let v = get(c, id, u64::try_from(rev).map_err(|_| STORE)?)?;
        items.push(json!({"revision":v["revision"],"name":v["portfolio"]["name"],"state":v["state"],"changedAt":v["changedAt"],"kind":v["kind"]}));
    }
    Ok(json!({"items":items,"total":total,"next":if offset+20<total{Some(offset+20)}else{None}}))
}
pub fn baseline_hash(c: &Connection, id: &str) -> Result<String> {
    let rev: i64 = c
        .query_row(
            "SELECT min(revision) FROM portfolio_revisions WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .map_err(|_| STORE)?;
    let v = get(c, id, u64::try_from(rev).map_err(|_| STORE)?)?;
    financial_hash(&serde_json::from_value::<Portfolio>(v["portfolio"].clone()).map_err(|_| STORE)?)
}
pub fn validate(c: &Connection) -> Result<()> {
    let (actual,expected):(i64,i64)=c.query_row("SELECT (SELECT count(*) FROM portfolio_revisions),entries FROM portfolio_revision_metadata WHERE id=1",[],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_|STORE)?;
    if actual != expected {
        return Err(STORE);
    }
    let mut q = c
        .prepare("SELECT id,revision FROM portfolio_revisions")
        .map_err(|_| STORE)?;
    let rows = q
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|_| STORE)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| STORE)?;
    for (id, rev) in rows {
        get(c, &id, u64::try_from(rev).map_err(|_| STORE)?)?;
    }
    let mut q = c.prepare("SELECT id FROM portfolios").map_err(|_| STORE)?;
    let ids = q
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|_| STORE)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| STORE)?;
    for id in ids {
        let (p, state, rev) = crate::portfolio::load(c, &id)?;
        let max: i64 = c
            .query_row(
                "SELECT max(revision) FROM portfolio_revisions WHERE id=?1",
                [&id],
                |r| r.get(0),
            )
            .map_err(|_| STORE)?;
        if u64::try_from(max).map_err(|_| STORE)? != rev {
            return Err(STORE);
        }
        let last = get(c, &id, rev)?;
        if last["state"] != state
            || last["portfolio"] != serde_json::to_value(&p).map_err(|_| STORE)?
        {
            return Err(STORE);
        }
    }
    let bad:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM portfolio_signatures WHERE policy_hash!='legacy' AND (length(policy_hash)!=64 OR policy_hash GLOB '*[^0-9a-f]*'))",[],|r|r.get(0)).map_err(|_|STORE)?;
    if bad {
        return Err(STORE);
    }
    Ok(())
}
