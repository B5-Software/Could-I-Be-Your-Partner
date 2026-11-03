// SPDX-License-Identifier: GPL-3.0-or-later
// Import compatibility only. New vaults never use unauthenticated AES-CTR.
use crate::{Result, vault::Secret};
use ctr::cipher::{KeyIvInit, StreamCipher};
use serde_json::Value;
use sha3::{Digest, Keccak256};
use subtle::ConstantTimeEq;
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;
fn bytes(value: &Value, max: usize) -> Result<Vec<u8>> {
    let text = value.as_str().ok_or("WALLET_KEYSTORE_FORMAT")?;
    if text.len() > max * 2 {
        return Err("WALLET_KEYSTORE_FORMAT");
    };
    hex::decode(text).map_err(|_| "WALLET_KEYSTORE_FORMAT")
}
fn number(value: &Value) -> Result<u64> {
    value.as_u64().ok_or("WALLET_KDF_LIMIT")
}
pub fn decrypt(text: &str, password: &str) -> Result<Secret> {
    if text.len() > 65536 || password.len() > 4096 {
        return Err("WALLET_KEYSTORE_LIMIT");
    }
    let result = decrypt_exact(text, password);
    if matches!(result, Err("WALLET_KEYSTORE_AUTHENTICATION")) {
        let normalized = Zeroizing::new(password.nfkc().collect::<String>());
        if normalized.as_str() != password {
            return decrypt_exact(text, &normalized);
        }
    }
    result
}
fn decrypt_exact(text: &str, password: &str) -> Result<Secret> {
    if text.len() > 65536 || password.len() > 4096 {
        return Err("WALLET_KEYSTORE_LIMIT");
    }
    let doc: Value = serde_json::from_str(text).map_err(|_| "WALLET_KEYSTORE_FORMAT")?;
    if doc["version"] != 3 {
        return Err("WALLET_KEYSTORE_FORMAT");
    }
    let c = doc
        .get("crypto")
        .or_else(|| doc.get("Crypto"))
        .ok_or("WALLET_KEYSTORE_FORMAT")?;
    if c["cipher"] != "aes-128-ctr" {
        return Err("WALLET_KEYSTORE_FORMAT");
    }
    let p = &c["kdfparams"];
    if number(&p["dklen"])? != 32 {
        return Err("WALLET_KDF_LIMIT");
    }
    let salt = bytes(&p["salt"], 64)?;
    let iv = bytes(&c["cipherparams"]["iv"], 16)?;
    let ciphertext = bytes(&c["ciphertext"], 32)?;
    let expected = bytes(&c["mac"], 32)?;
    if salt.len() < 8 || iv.len() != 16 || ciphertext.len() != 32 || expected.len() != 32 {
        return Err("WALLET_KEYSTORE_FORMAT");
    }
    let mut key = Zeroizing::new([0u8; 64]);
    match c["kdf"].as_str() {
        Some("scrypt") => {
            let n = number(&p["n"])?;
            let r = number(&p["r"])?;
            let parallel = number(&p["p"])?;
            if n < 2
                || !n.is_power_of_two()
                || n > 262144
                || r == 0
                || r > 8
                || parallel == 0
                || parallel > 16
                || n * r > 2097152
                || n * r * parallel > 16777216
            {
                return Err("WALLET_KDF_LIMIT");
            };
            let params = scrypt::Params::new(n.ilog2() as u8, r as u32, parallel as u32, 32)
                .map_err(|_| "WALLET_KDF_LIMIT")?;
            scrypt::scrypt(password.as_bytes(), &salt, &params, &mut *key)
                .map_err(|_| "WALLET_OPERATION_FAILED")?;
        }
        Some("pbkdf2") => {
            let rounds = number(&p["c"])?;
            if rounds == 0 || rounds > 1000000 {
                return Err("WALLET_KDF_LIMIT");
            };
            match p["prf"].as_str() {
                Some("hmac-sha256") => pbkdf2::pbkdf2_hmac::<sha2::Sha256>(
                    password.as_bytes(),
                    &salt,
                    rounds as u32,
                    &mut key[..32],
                ),
                Some("hmac-sha512") => pbkdf2::pbkdf2_hmac::<sha2::Sha512>(
                    password.as_bytes(),
                    &salt,
                    rounds as u32,
                    &mut key[..32],
                ),
                _ => return Err("WALLET_KDF_LIMIT"),
            }
        }
        _ => return Err("WALLET_KDF_LIMIT"),
    }
    let mut hash = Keccak256::new();
    hash.update(&key[16..32]);
    hash.update(&ciphertext);
    if hash.finalize().as_slice().ct_eq(&expected).unwrap_u8() != 1 {
        return Err("WALLET_KEYSTORE_AUTHENTICATION");
    }
    let mut plain = Zeroizing::new(ciphertext);
    ctr::Ctr128BE::<aes::Aes128>::new((&key[..16]).into(), iv.as_slice().into())
        .apply_keystream(&mut plain);
    let address = crate::evm::address(&plain)?;
    if let Some(stated) = doc["address"].as_str()
        && !address[2..].eq_ignore_ascii_case(stated.trim_start_matches("0x"))
    {
        return Err("WALLET_KEYSTORE_AUTHENTICATION");
    }
    let mut secret = Secret {
        private_key: hex::encode(&*plain),
        mnemonic: None,
        derivation_path: None,
    };
    if let Some(extension) = doc.get("x-ethers") {
        if extension["version"] != "0.1"
            || c["kdf"] != "scrypt"
            || extension["locale"].as_str().unwrap_or("en") != "en"
        {
            return Err("WALLET_KEYSTORE_EXTENSION_UNSUPPORTED");
        }
        let counter = bytes(&extension["mnemonicCounter"], 16)?;
        let mut entropy = Zeroizing::new(bytes(&extension["mnemonicCiphertext"], 32)?);
        if counter.len() != 16 || ![16, 20, 24, 28, 32].contains(&entropy.len()) {
            return Err("WALLET_KEYSTORE_FORMAT");
        }
        ctr::Ctr128BE::<aes::Aes256>::new((&key[32..64]).into(), counter.as_slice().into())
            .apply_keystream(&mut entropy);
        let mnemonic = bip39::Mnemonic::from_entropy(&entropy)
            .map_err(|_| "WALLET_KEYSTORE_AUTHENTICATION")?;
        let path = extension["path"].as_str().unwrap_or(crate::PATH);
        if path.len() > 256 {
            return Err("WALLET_KEYSTORE_FORMAT");
        }
        let seed = Zeroizing::new(mnemonic.to_seed(""));
        let derived = bip32::XPrv::derive_from_path(
            seed.as_slice(),
            &path.parse().map_err(|_| "WALLET_KEYSTORE_FORMAT")?,
        )
        .map_err(|_| "WALLET_KEYSTORE_FORMAT")?;
        let private = Zeroizing::new(derived.to_bytes());
        if private.as_slice().ct_eq(&plain).unwrap_u8() != 1 {
            return Err("WALLET_KEYSTORE_AUTHENTICATION");
        }
        secret.mnemonic = Some(mnemonic.to_string());
        secret.derivation_path = Some(path.into());
    }
    Ok(secret)
}
