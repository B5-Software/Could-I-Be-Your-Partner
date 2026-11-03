// SPDX-License-Identifier: GPL-3.0-or-later
// Fixture generated independently by ethers from a public BIP-39 test vector.
use cibyp_wallet_signer::legacy;
#[test]
fn old_hd_backups_preserve_the_mnemonic_and_derivation_path() {
    let fixture = include_str!("fixtures/legacy-hd.json");
    let secret = legacy::decrypt(fixture, "Ｔｅｓｔ-only-password").unwrap();
    assert_eq!(
        secret.mnemonic.as_deref(),
        Some(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
        )
    );
    assert_eq!(secret.derivation_path.as_deref(), Some("m/44'/60'/0'/0/0"));
    assert_eq!(
        cibyp_wallet_signer::evm::address(&hex::decode(&secret.private_key).unwrap()).unwrap(),
        "0x9858effd232b4033e47d90003d41ec34ecaeda94"
    );
    let mut changed: serde_json::Value = serde_json::from_str(fixture).unwrap();
    changed["x-ethers"]["path"] = serde_json::json!("m/44'/60'/0'/0/1");
    assert!(matches!(
        legacy::decrypt(&changed.to_string(), "Ｔｅｓｔ-only-password"),
        Err("WALLET_KEYSTORE_AUTHENTICATION")
    ));
}
