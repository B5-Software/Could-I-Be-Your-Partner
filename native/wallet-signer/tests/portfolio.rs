// SPDX-License-Identifier: GPL-3.0-or-later
use cibyp_wallet_signer::{
    portfolio::{Member, Portfolio},
    receipts::Store,
    scope::Rules,
};
#[test]
fn missing_members_never_remove_a_wallet_budget_silently() {
    let path = std::env::temp_dir().join(format!(
        "cibyp-portfolio-{}",
        hex::encode(cibyp_wallet_signer::random::<12>().unwrap())
    ));
    let mut signer = cibyp_wallet_signer::Signer::open(&path).unwrap();
    let portfolio = Portfolio {
        id: "fixture-portfolio".into(),
        name: "Test".into(),
        chain_id: 8453,
        members: vec![Member {
            wallet_id: "wallet".into(),
            address: format!("0x{}", "2".repeat(40)),
        }],
        limits: Rules::default(),
        max_fee_wei: "0".into(),
        expires_at: 0,
    };
    let input: cibyp_wallet_signer::Input =
        serde_json::from_value(serde_json::json!({"id":portfolio.id,"portfolio":portfolio}))
            .unwrap();
    signer.request("portfolio.create", &input).unwrap();
    drop(signer);
    let db = rusqlite::Connection::open(path.join("receipts.sqlite")).unwrap();
    db.execute("DELETE FROM portfolio_members", []).unwrap();
    drop(db);
    assert!(matches!(
        Store::open(&path),
        Err("WALLET_RECEIPT_STORE_FAILED")
    ));
    std::fs::remove_dir_all(path).unwrap();
}
#[test]
fn previous_portfolio_schema_upgrade_preserves_members_and_refuses_a_damaged_binding() {
    for damaged in [false, true] {
        let path = std::env::temp_dir().join(format!(
            "cibyp-portfolio-migrate-{}",
            hex::encode(cibyp_wallet_signer::random::<12>().unwrap())
        ));
        let mut signer = cibyp_wallet_signer::Signer::open(&path).unwrap();
        let input:cibyp_wallet_signer::Input=serde_json::from_value(serde_json::json!({"id":"fixture","portfolio":{"id":"fixture","name":"Fixture","chainId":8453,"members":[{"walletId":"wallet","address":format!("0x{}","2".repeat(40))}],"limits":{},"maxFeeWei":"0","expiresAt":0}})).unwrap();
        signer.request("portfolio.create", &input).unwrap();
        drop(signer);
        let db = rusqlite::Connection::open(path.join("receipts.sqlite")).unwrap();
        db.execute_batch("DROP TABLE portfolio_revisions;DROP TABLE portfolio_revision_metadata;ALTER TABLE portfolio_signatures DROP COLUMN policy_hash;DROP TABLE period_charges;DROP TABLE period_windows;DROP TABLE period_accounts;DROP TABLE period_metadata;DROP TABLE agent_scope_charges;DROP TABLE agent_scope_signatures;DROP TABLE agent_scope_usage;DROP TABLE agent_scope_metadata;DROP TABLE agent_scopes;DROP TABLE portfolio_metadata;PRAGMA user_version=4;")
            .unwrap();
        if damaged {
            db.execute("DELETE FROM portfolio_members", []).unwrap();
        }
        drop(db);
        if damaged {
            assert!(matches!(
                Store::open(&path),
                Err("WALLET_RECEIPT_STORE_FAILED")
            ));
        } else {
            drop(Store::open(&path).unwrap());
            let db = rusqlite::Connection::open(path.join("receipts.sqlite")).unwrap();
            assert_eq!(
                db.query_row(
                    "SELECT members FROM portfolio_metadata WHERE id=1",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                1
            );
            drop(db);
        }
        std::fs::remove_dir_all(path).unwrap();
    }
}
