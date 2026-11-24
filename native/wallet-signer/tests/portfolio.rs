// SPDX-License-Identifier: GPL-3.0-or-later
use cibyp_wallet_signer::{
    authority::Check,
    evm::Transaction,
    portfolio::{AllowanceEvidence, Member, Portfolio, check_allowance},
    receipts::Store,
    scope::Rules,
};
#[test]
fn approval_ceiling_binds_recent_evidence_and_preserves_revocation() {
    use serde_json::json;
    let path = std::env::temp_dir().join(format!(
        "cibyp-portfolio-cap-{}",
        hex::encode(cibyp_wallet_signer::random::<12>().unwrap())
    ));
    let owner = format!("0x{}", "2".repeat(40));
    let token = format!("0x{}", "3".repeat(40));
    let mut signer = cibyp_wallet_signer::Signer::open(&path).unwrap();
    let input = serde_json::from_value(json!({"id":"cap","portfolio":{
        "id":"cap","name":"Ceiling","chainId":8453,"members":[{"walletId":"wallet","address":owner}],
        "limits":{},"maxFeeWei":"0","expiresAt":0,"allowanceCeiling":{
            "token":token,"atoms":"10","decimals":6,"baselineReportId":format!("1000000000000-{}", "a".repeat(64))
        }
    }})).unwrap();
    signer.request("portfolio.create", &input).unwrap();
    drop(signer);
    let connection = rusqlite::Connection::open(path.join("receipts.sqlite")).unwrap();
    let approve = |value: u64| -> Transaction {
        serde_json::from_value(json!({"type":2,"chainId":8453,"nonce":0,"to":token,"value":"0",
            "data":format!("0x095ea7b3{:024}{}{:064x}",0,"4".repeat(40),value),"gasLimit":"50000","maxFeePerGas":"1","maxPriorityFeePerGas":"1"})).unwrap()
    };
    let check = |tx: &Transaction, evidence: Option<&AllowanceEvidence>| {
        let binding = Check {
            checked_at_ms: 50000,
            expires_at: 60000,
            wallet_id: "wallet",
            address: &owner,
            operation_id: "operation",
            session: "session",
            unsigned_hash: "signed-intent-digest",
            transaction: tx,
            fee_reserve_wei: "50000",
            policy_id: None,
            execution: None,
            replay: false,
            replacement_of: None,
            agent_scope_id: None,
            agent_subject: None,
        };
        check_allowance(&connection, &binding, evidence)
    };
    let tx = approve(3);
    let mut evidence = AllowanceEvidence {
        portfolio_id: "cap".into(),
        revision: 1,
        operation_id: "operation".into(),
        unsigned_hash: "signed-intent-digest".into(),
        block_hash: format!("0x{}", "a".repeat(64)),
        checked_at: 40000,
        previous_pair_atoms: "2".into(),
        projected_atoms: "11".into(),
    };
    assert_eq!(check(&tx, None), Err("WALLET_PORTFOLIO_ALLOWANCE_REQUIRED"));
    assert_eq!(
        check(&tx, Some(&evidence)),
        Err("WALLET_PORTFOLIO_ALLOWANCE_EXCEEDED")
    );
    assert_eq!(check(&approve(2), Some(&evidence)), Ok(()));
    assert_eq!(check(&approve(0), None), Ok(()));
    evidence.projected_atoms = "10".into();
    assert_eq!(check(&tx, Some(&evidence)), Ok(()));
    evidence.operation_id = "another-operation".into();
    assert_eq!(
        check(&tx, Some(&evidence)),
        Err("WALLET_PORTFOLIO_ALLOWANCE_REQUIRED")
    );
    evidence.operation_id = "operation".into();
    evidence.checked_at = 29000;
    assert_eq!(
        check(&tx, Some(&evidence)),
        Err("WALLET_PORTFOLIO_ALLOWANCE_REQUIRED")
    );
    drop(connection);
    std::fs::remove_dir_all(path).unwrap();
}
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
        equity_floor_usd_atomic: None,
        allowance_ceiling: None,
        signature_rate: None,
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
        db.execute_batch("DROP TABLE portfolio_rate_migration;DROP INDEX portfolio_signatures_time;ALTER TABLE portfolio_signatures DROP COLUMN signed_ms;DROP TABLE message_approvals;DROP TABLE message_receipts;DROP TABLE message_metadata;DROP TABLE portfolio_revisions;DROP TABLE portfolio_revision_metadata;ALTER TABLE portfolio_signatures DROP COLUMN policy_hash;DROP TABLE period_charges;DROP TABLE period_windows;DROP TABLE period_accounts;DROP TABLE period_metadata;DROP TABLE agent_scope_charges;DROP TABLE agent_scope_signatures;DROP TABLE agent_scope_usage;DROP TABLE agent_scope_metadata;DROP TABLE agent_scopes;DROP TABLE portfolio_metadata;PRAGMA user_version=4;")
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
