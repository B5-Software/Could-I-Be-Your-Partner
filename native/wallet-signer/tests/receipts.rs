// SPDX-License-Identifier: GPL-3.0-or-later
use cibyp_wallet_signer::{
    evm,
    receipts::{Receipt, Store},
};
use std::{fs, path::PathBuf};
struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!(
            "cibyp-receipt-test-{}",
            hex::encode(cibyp_wallet_signer::random::<16>().unwrap())
        )))
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn receipt() -> Receipt {
    let mut record = Receipt {
        operation_id: "test-operation".into(),
        wallet_id: "test-wallet".into(),
        address: "0x1111111111111111111111111111111111111111".into(),
        unsigned_hash: format!("0x{}", "a".repeat(64)),
        hash: evm::raw_hash("0x02").unwrap(),
        sealed_raw: String::new(),
        nonce_hex: String::new(),
        chain_id: 8453,
        nonce: 0,
    };
    record.seal(&[1u8; 32], "fixture-store", "0x02").unwrap();
    record
}
#[test]
fn receipts_are_exclusive_durable_and_identity_bound() {
    let directory = Directory::new();
    let mut store = Store::open(&directory.0).unwrap();
    assert_eq!(
        Store::open(&directory.0).err(),
        Some("WALLET_RECEIPT_STORE_BUSY")
    );
    let id = store.id.clone();
    assert!(store.get("missing").unwrap().is_none());
    store.prove_absent("missing").unwrap();
    store.commit(&receipt()).unwrap();
    drop(store);
    let store = Store::open(&directory.0).unwrap();
    assert_eq!(store.id, id);
    store.check(&id).unwrap();
    assert_eq!(store.check("other"), Err("WALLET_RECEIPT_STORE_CHANGED"));
    let saved = store.get("test-operation").unwrap().unwrap();
    assert_eq!(
        saved
            .open_raw(&[1u8; 32], "fixture-store")
            .unwrap()
            .as_str(),
        "0x02"
    );
    assert!(saved.open_raw(&[2u8; 32], "fixture-store").is_err());
    assert!(saved.open_raw(&[1u8; 32], "another-store").is_err());
    let mut tampered = receipt();
    tampered.nonce = 1;
    assert!(tampered.open_raw(&[1u8; 32], "fixture-store").is_err());
    assert!(saved.summary(&id).get("raw").is_none());
}
#[test]
fn corruption_never_becomes_an_empty_store() {
    let directory = Directory::new();
    let mut store = Store::open(&directory.0).unwrap();
    store.commit(&receipt()).unwrap();
    drop(store);
    let file = directory.0.join("receipts.sqlite");
    let connection = rusqlite::Connection::open(&file).unwrap();
    connection
        .execute("UPDATE receipts SET checksum='damaged'", [])
        .unwrap();
    drop(connection);
    assert_eq!(
        Store::open(&directory.0).err(),
        Some("WALLET_RECEIPT_STORE_FAILED")
    );
    fs::write(&file, b"broken database").unwrap();
    assert_eq!(
        Store::open(&directory.0).err(),
        Some("WALLET_RECEIPT_STORE_FAILED")
    );
}
#[test]
fn duplicate_writes_poison_the_connection_until_recovery() {
    let directory = Directory::new();
    let mut store = Store::open(&directory.0).unwrap();
    let record = receipt();
    store.commit(&record).unwrap();
    assert_eq!(store.commit(&record), Err("WALLET_RECEIPT_STORE_FAILED"));
    assert_eq!(
        store.get("test-operation").err(),
        Some("WALLET_RECEIPT_STORE_FAILED")
    );
    drop(store);
    assert!(
        Store::open(&directory.0)
            .unwrap()
            .get("test-operation")
            .unwrap()
            .is_some()
    );
}
#[test]
fn missing_rows_do_not_prove_an_operation_was_never_signed() {
    let directory = Directory::new();
    let mut store = Store::open(&directory.0).unwrap();
    store.commit(&receipt()).unwrap();
    drop(store);
    let connection = rusqlite::Connection::open(directory.0.join("receipts.sqlite")).unwrap();
    connection
        .execute_batch("PRAGMA foreign_keys=OFF;DELETE FROM receipts;")
        .unwrap();
    drop(connection);
    assert_eq!(
        Store::open(&directory.0).err(),
        Some("WALLET_RECEIPT_STORE_FAILED")
    );
}
#[test]
fn upgrading_a_receipt_only_database_preserves_receipts_and_recovers_nonce_locks() {
    let directory = Directory::new();
    let mut store = Store::open(&directory.0).unwrap();
    store.commit(&receipt()).unwrap();
    drop(store);
    let connection = rusqlite::Connection::open(directory.0.join("receipts.sqlite")).unwrap();
    connection.execute_batch("DROP TABLE portfolio_revisions;DROP TABLE portfolio_revision_metadata;ALTER TABLE portfolio_signatures DROP COLUMN policy_hash;DROP TABLE period_charges;DROP TABLE period_windows;DROP TABLE period_accounts;DROP TABLE period_metadata;DROP TABLE agent_scope_charges;DROP TABLE agent_scope_signatures;DROP TABLE agent_scope_usage;DROP TABLE agent_scope_metadata;DROP TABLE agent_scopes;DROP TABLE portfolio_metadata;DROP TABLE portfolio_signatures;DROP TABLE portfolio_usage;DROP TABLE portfolio_members;DROP TABLE portfolios;DROP TABLE grant_usage;DROP TABLE authorization_usage;DROP TABLE nonce_locks;DROP TABLE plans;DROP TABLE approvals;DROP TABLE grants;DROP TABLE authority_fences;DROP TABLE denials;PRAGMA user_version=0;").unwrap();
    drop(connection);
    let store = Store::open(&directory.0).unwrap();
    assert_eq!(
        store.get("test-operation").unwrap().unwrap().hash,
        receipt().hash
    );
    let connection = rusqlite::Connection::open(directory.0.join("receipts.sqlite")).unwrap();
    let operation: String = connection
        .query_row(
            "SELECT operation_id FROM nonce_locks WHERE nonce=0",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(operation, "test-operation");
    let version: u32 = connection
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 7);
}
