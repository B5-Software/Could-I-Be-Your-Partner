// SPDX-License-Identifier: GPL-3.0-or-later
use cibyp_wallet_signer::{Input, Signer, receipts::Store};
use serde_json::json;
#[test]
fn missing_or_modified_scope_records_never_remove_restrictions_silently() {
    for sql in [
        "DELETE FROM agent_scopes",
        "UPDATE agent_scopes SET body='{}'",
    ] {
        let path = std::env::temp_dir().join(format!(
            "cibyp-scope-integrity-{}",
            hex::encode(cibyp_wallet_signer::random::<12>().unwrap())
        ));
        let mut signer = Signer::open(&path).unwrap();
        let input: Input = serde_json::from_value(json!({"id":"scope","scope":{"id":"scope","subject":"quant:fixture","label":"Fixture","parentId":null,"chainId":8453,"walletIds":[],"limits":{},"maxFeeWei":"0","expiresAt":0}})).unwrap();
        signer.request("scope.ensure", &input).unwrap();
        drop(signer);
        let db = rusqlite::Connection::open(path.join("receipts.sqlite")).unwrap();
        db.execute(sql, []).unwrap();
        drop(db);
        assert!(matches!(
            Store::open(&path),
            Err("WALLET_RECEIPT_STORE_FAILED")
        ));
        std::fs::remove_dir_all(path).unwrap();
    }
}
#[test]
fn version_five_upgrades_without_inventing_agent_authority() {
    let path = std::env::temp_dir().join(format!(
        "cibyp-scope-migration-{}",
        hex::encode(cibyp_wallet_signer::random::<12>().unwrap())
    ));
    drop(Store::open(&path).unwrap());
    let db = rusqlite::Connection::open(path.join("receipts.sqlite")).unwrap();
    db.execute_batch("DROP TABLE portfolio_revisions;DROP TABLE portfolio_revision_metadata;ALTER TABLE portfolio_signatures DROP COLUMN policy_hash;DROP TABLE period_charges;DROP TABLE period_windows;DROP TABLE period_accounts;DROP TABLE period_metadata;DROP TABLE agent_scope_charges;DROP TABLE agent_scope_signatures;DROP TABLE agent_scope_usage;DROP TABLE agent_scope_metadata;DROP TABLE agent_scopes;PRAGMA user_version=5;").unwrap();
    drop(db);
    let mut signer = Signer::open(&path).unwrap();
    let result = signer
        .request(
            "scope.list",
            &serde_json::from_value(json!({"id":"scopes"})).unwrap(),
        )
        .unwrap();
    assert_eq!(result["total"], 0);
    drop(signer);
    let db = rusqlite::Connection::open(path.join("receipts.sqlite")).unwrap();
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |r| r.get::<_, u32>(0))
            .unwrap(),
        7
    );
    drop(db);
    std::fs::remove_dir_all(path).unwrap();
}
