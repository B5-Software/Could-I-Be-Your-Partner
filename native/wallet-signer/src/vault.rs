// SPDX-License-Identifier: GPL-3.0-or-later
use crate::{Result, random};
use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload as AeadPayload},
};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Secret {
    pub private_key: String,
    pub mnemonic: Option<String>,
    pub derivation_path: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Kdf {
    pub name: String,
    pub version: u32,
    #[serde(rename = "memoryKiB")]
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
    pub salt: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cipher {
    pub name: String,
    pub nonce: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Header {
    pub format: String,
    pub version: u32,
    pub id: String,
    pub address: String,
    pub curve: String,
    pub kdf: Kdf,
    pub cipher: Cipher,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Vault {
    pub header: Header,
    pub ciphertext: String,
}
fn derive(password: &str, kdf: &Kdf) -> Result<Zeroizing<[u8; 32]>> {
    if kdf.name != "argon2id"
        || kdf.version != 19
        || !(65536..=262144).contains(&kdf.memory_kib)
        || !(3..=6).contains(&kdf.iterations)
        || !(1..=4).contains(&kdf.parallelism)
        || u64::from(kdf.memory_kib) * u64::from(kdf.iterations) > 786432
    {
        return Err("WALLET_KDF_LIMIT");
    }
    if password.len() > 4096 {
        return Err("WALLET_PASSWORD_LENGTH");
    }
    let salt = hex::decode(&kdf.salt).map_err(|_| "WALLET_KEYSTORE_FORMAT")?;
    if salt.len() != 32 {
        return Err("WALLET_KEYSTORE_FORMAT");
    }
    let params = Params::new(kdf.memory_kib, kdf.iterations, kdf.parallelism, Some(32))
        .map_err(|_| "WALLET_KDF_LIMIT")?;
    let mut key = Zeroizing::new([0; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), &salt, &mut *key)
        .map_err(|_| "WALLET_OPERATION_FAILED")?;
    Ok(key)
}
pub fn encrypt(secret: &Secret, password: &str) -> Result<String> {
    if password.chars().count() < 12 || password.len() > 4096 {
        return Err("WALLET_PASSWORD_LENGTH");
    }
    let key_bytes =
        Zeroizing::new(hex::decode(&secret.private_key).map_err(|_| "WALLET_KEYSTORE_FORMAT")?);
    let address = crate::evm::address(&key_bytes)?;
    let header = Header {
        format: "CIBYP-WALLET".into(),
        version: 1,
        id: hex::encode(random::<16>()?),
        address,
        curve: "secp256k1".into(),
        kdf: Kdf {
            name: "argon2id".into(),
            version: 19,
            memory_kib: 65536,
            iterations: 3,
            parallelism: 1,
            salt: hex::encode(random::<32>()?),
        },
        cipher: Cipher {
            name: "xchacha20-poly1305".into(),
            nonce: hex::encode(random::<24>()?),
        },
    };
    let key = derive(password, &header.kdf)?;
    let nonce = hex::decode(&header.cipher.nonce).map_err(|_| "WALLET_KEYSTORE_FORMAT")?;
    let aad = serde_json::to_vec(&header).map_err(|_| "WALLET_KEYSTORE_FORMAT")?;
    let plaintext =
        Zeroizing::new(serde_json::to_vec(secret).map_err(|_| "WALLET_OPERATION_FAILED")?);
    let ciphertext = XChaCha20Poly1305::new((&*key).into())
        .encrypt(
            XNonce::from_slice(&nonce),
            AeadPayload {
                msg: &plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| "WALLET_OPERATION_FAILED")?;
    serde_json::to_string(&Vault {
        header,
        ciphertext: hex::encode(ciphertext),
    })
    .map_err(|_| "WALLET_OPERATION_FAILED")
}
pub fn decrypt(text: &str, password: &str) -> Result<Secret> {
    if text.len() > 65536 {
        return Err("WALLET_KEYSTORE_LIMIT");
    }
    let vault: Vault = serde_json::from_str(text).map_err(|_| "WALLET_KEYSTORE_FORMAT")?;
    let header = &vault.header;
    if header.format != "CIBYP-WALLET"
        || header.version != 1
        || header.curve != "secp256k1"
        || header.id.len() != 32
        || hex::decode(&header.id).is_err()
        || header.cipher.name != "xchacha20-poly1305"
    {
        return Err("WALLET_KEYSTORE_FORMAT");
    }
    let nonce = hex::decode(&header.cipher.nonce).map_err(|_| "WALLET_KEYSTORE_FORMAT")?;
    if nonce.len() != 24 || vault.ciphertext.len() > 16384 {
        return Err("WALLET_KEYSTORE_FORMAT");
    }
    let ciphertext = hex::decode(&vault.ciphertext).map_err(|_| "WALLET_KEYSTORE_FORMAT")?;
    let aad = serde_json::to_vec(header).map_err(|_| "WALLET_KEYSTORE_FORMAT")?;
    let key = derive(password, &header.kdf)?;
    let plain = Zeroizing::new(
        XChaCha20Poly1305::new((&*key).into())
            .decrypt(
                XNonce::from_slice(&nonce),
                AeadPayload {
                    msg: &ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| "WALLET_KEYSTORE_AUTHENTICATION")?,
    );
    let secret: Secret = serde_json::from_slice(&plain).map_err(|_| "WALLET_KEYSTORE_FORMAT")?;
    let bytes =
        Zeroizing::new(hex::decode(&secret.private_key).map_err(|_| "WALLET_KEYSTORE_FORMAT")?);
    if crate::evm::address(&bytes)? != header.address {
        return Err("WALLET_KEYSTORE_AUTHENTICATION");
    }
    Ok(secret)
}
