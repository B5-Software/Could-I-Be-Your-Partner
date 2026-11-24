// SPDX-License-Identifier: GPL-3.0-or-later
//! Sliding host-clock limits for new portfolio transaction signatures.
use crate::{Result, authority::now};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

const STORE: &str = "WALLET_RECEIPT_STORE_FAILED";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub window_seconds: u32,
    pub max_signatures: u32,
}

impl Policy {
    pub fn validate(&self) -> Result<()> {
        if !(1..=300).contains(&self.window_seconds) || !(1..=1000).contains(&self.max_signatures) {
            return Err("WALLET_PORTFOLIO_RATE_INVALID");
        }
        Ok(())
    }
}

pub fn initialize(connection: &mut Connection) -> Result<()> {
    let tx = connection.transaction().map_err(|_| STORE)?;
    tx.execute_batch(
        "ALTER TABLE portfolio_signatures ADD COLUMN signed_ms INTEGER NOT NULL DEFAULT 0 CHECK(signed_ms BETWEEN 0 AND 9007199254740991);
         CREATE INDEX portfolio_signatures_time ON portfolio_signatures(portfolio_id,signed_ms);
         CREATE TABLE portfolio_rate_migration(id INTEGER PRIMARY KEY CHECK(id=1),at_ms INTEGER NOT NULL CHECK(at_ms BETWEEN 1 AND 9007199254740991)) STRICT;
         PRAGMA user_version=9;",
    )
    .map_err(|_| STORE)?;
    tx.execute(
        "INSERT INTO portfolio_rate_migration VALUES(1,?1)",
        [i64::try_from(now()?).map_err(|_| STORE)?],
    )
    .map_err(|_| STORE)?;
    tx.commit().map_err(|_| STORE)
}

fn migrated_at(connection: &Connection) -> Result<i64> {
    connection
        .query_row(
            "SELECT at_ms FROM portfolio_rate_migration WHERE id=1",
            [],
            |r| r.get(0),
        )
        .map_err(|_| STORE)
}

pub fn validate(connection: &Connection) -> Result<()> {
    migrated_at(connection)?;
    connection
        .prepare("SELECT signed_ms FROM portfolio_signatures LIMIT 1")
        .map_err(|_| STORE)?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    status: &'static str,
    used: i64,
    remaining: i64,
    next_eligible_at: Option<i64>,
    checked_at: i64,
    window_seconds: u32,
    max_signatures: u32,
}

pub fn snapshot(
    connection: &Connection,
    id: &str,
    policy: &Policy,
    at: u64,
) -> Result<Observation> {
    policy.validate()?;
    let at = i64::try_from(at).map_err(|_| STORE)?;
    let migration = migrated_at(connection)?;
    let (latest, legacy): (i64, bool) = connection.query_row(
        "SELECT coalesce((SELECT signed_ms FROM portfolio_signatures WHERE portfolio_id=?1 ORDER BY signed_ms DESC LIMIT 1),0),
                exists(SELECT 1 FROM portfolio_signatures WHERE portfolio_id=?1 AND signed_ms=0)",
        [id], |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(|_| STORE)?;
    let window = i64::from(policy.window_seconds) * 1000;
    let floor = at.saturating_sub(window).max(0);
    let used: i64 = connection
        .query_row(
            "SELECT count(*) FROM portfolio_signatures WHERE portfolio_id=?1 AND signed_ms>?2",
            params![id, floor],
            |r| r.get(0),
        )
        .map_err(|_| STORE)?;
    let maximum = i64::from(policy.max_signatures);
    let (status, next_eligible_at) = if at < latest || (legacy && at < migration) {
        ("clock-rollback", None)
    } else if legacy && floor < migration {
        ("settling", Some(migration + window))
    } else if used >= maximum {
        let next: i64 = connection.query_row(
            "SELECT signed_ms FROM portfolio_signatures WHERE portfolio_id=?1 AND signed_ms>?2 ORDER BY signed_ms DESC LIMIT 1 OFFSET ?3",
            params![id, floor, maximum - 1], |r| r.get(0),
        ).map_err(|_| STORE)?;
        ("limited", Some(next + window))
    } else {
        ("ready", None)
    };
    Ok(Observation {
        status,
        used,
        remaining: if status == "ready" { maximum - used } else { 0 },
        next_eligible_at,
        checked_at: at,
        window_seconds: policy.window_seconds,
        max_signatures: policy.max_signatures,
    })
}

pub fn check(connection: &Connection, id: &str, policy: &Policy, at: u64) -> Result<()> {
    match snapshot(connection, id, policy, at)?.status {
        "ready" => Ok(()),
        "clock-rollback" => Err("WALLET_PORTFOLIO_RATE_CLOCK_ROLLBACK"),
        _ => Err("WALLET_PORTFOLIO_RATE_LIMIT"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_preserves_legacy_rows_and_boundaries_use_the_rolling_window() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE portfolio_signatures(operation_id TEXT PRIMARY KEY,portfolio_id TEXT NOT NULL,policy_hash TEXT NOT NULL) STRICT;
          INSERT INTO portfolio_signatures VALUES('old','legacy','legacy');
          PRAGMA user_version=8;").unwrap();
        initialize(&mut db).unwrap();
        let migration = migrated_at(&db).unwrap();
        let before = u64::try_from(migration).unwrap();
        let policy = Policy {
            window_seconds: 5,
            max_signatures: 2,
        };
        let old = snapshot(&db, "legacy", &policy, before + 4999).unwrap();
        assert_eq!(old.status, "settling");
        assert_eq!(old.next_eligible_at, Some(migration + 5000));
        assert_eq!(check(&db, "legacy", &policy, before + 5000), Ok(()));
        assert_eq!(
            check(&db, "legacy", &policy, before - 1),
            Err("WALLET_PORTFOLIO_RATE_CLOCK_ROLLBACK")
        );

        for (id, elapsed) in [("first", 1000), ("second", 2000), ("third", 3000)] {
            db.execute(
                "INSERT INTO portfolio_signatures VALUES(?1,'shared','policy',?2)",
                params![id, migration + elapsed],
            )
            .unwrap();
        }
        let capped = snapshot(&db, "shared", &policy, before + 3000).unwrap();
        assert_eq!(
            (capped.status, capped.used, capped.remaining),
            ("limited", 3, 0)
        );
        assert_eq!(capped.next_eligible_at, Some(migration + 7000));
        assert_eq!(
            check(&db, "shared", &policy, before + 2999),
            Err("WALLET_PORTFOLIO_RATE_CLOCK_ROLLBACK")
        );
        assert_eq!(
            check(&db, "shared", &policy, before + 6999),
            Err("WALLET_PORTFOLIO_RATE_LIMIT")
        );
        let open = snapshot(&db, "shared", &policy, before + 7000).unwrap();
        assert_eq!((open.status, open.used, open.remaining), ("ready", 1, 1));
    }
}
