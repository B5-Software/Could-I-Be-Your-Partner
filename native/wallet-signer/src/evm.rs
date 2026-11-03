// SPDX-License-Identifier: GPL-3.0-or-later
use crate::Result;
use ethnum::U256;
use k256::ecdsa::SigningKey;
use rlp::RlpStream;
use serde::Deserialize;
use sha3::{Digest, Keccak256};
fn signing_key(bytes: &[u8]) -> Result<SigningKey> {
    SigningKey::from_slice(bytes).map_err(|_| "WALLET_PRIVATE_KEY_FORMAT")
}
pub fn address(bytes: &[u8]) -> Result<String> {
    let key = signing_key(bytes)?;
    let public = key.verifying_key().to_encoded_point(false);
    let hash = Keccak256::digest(&public.as_bytes()[1..]);
    Ok("0x".to_owned() + &hex::encode(&hash[12..]))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Transaction {
    pub r#type: u8,
    pub chain_id: u64,
    pub nonce: u64,
    pub to: String,
    pub value: String,
    pub data: String,
    pub gas_limit: String,
    pub max_fee_per_gas: String,
    pub max_priority_fee_per_gas: String,
}
fn quantity(value: &str) -> Result<U256> {
    if value.is_empty() || value.len() > 78 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err("WALLET_TRANSACTION_FORMAT");
    };
    value.parse().map_err(|_| "WALLET_TRANSACTION_FORMAT")
}
fn integer(stream: &mut RlpStream, value: U256) {
    let bytes = value.to_be_bytes();
    let index = bytes.iter().position(|b| *b != 0).unwrap_or(bytes.len());
    stream.append(&&bytes[index..]);
}
fn fields(tx: &Transaction, stream: &mut RlpStream, to: &[u8], data: &[u8]) -> Result<()> {
    stream.append(&tx.chain_id);
    stream.append(&tx.nonce);
    integer(stream, quantity(&tx.max_priority_fee_per_gas)?);
    integer(stream, quantity(&tx.max_fee_per_gas)?);
    integer(stream, quantity(&tx.gas_limit)?);
    stream.append(&to);
    integer(stream, quantity(&tx.value)?);
    stream.append(&data);
    stream.begin_list(0);
    Ok(())
}
fn validated(tx: &Transaction) -> Result<(Vec<u8>, Vec<u8>)> {
    if ![8453, 84532].contains(&tx.chain_id) || tx.r#type != 2 {
        return Err("WALLET_CHAIN_UNAVAILABLE");
    }
    if tx.nonce > 9007199254740991
        || quantity(&tx.max_priority_fee_per_gas)? > quantity(&tx.max_fee_per_gas)?
        || quantity(&tx.max_fee_per_gas)? == U256::ZERO
        || quantity(&tx.gas_limit)? < U256::from(21000u64)
        || quantity(&tx.gas_limit)? > U256::from(36000000u64)
    {
        return Err("WALLET_TRANSACTION_FORMAT");
    }
    let to = hex::decode(
        tx.to
            .strip_prefix("0x")
            .ok_or("WALLET_TRANSACTION_FORMAT")?,
    )
    .map_err(|_| "WALLET_TRANSACTION_FORMAT")?;
    if to.len() != 20 || tx.data.len() > 32770 {
        return Err("WALLET_TRANSACTION_FORMAT");
    }
    let data = hex::decode(
        tx.data
            .strip_prefix("0x")
            .ok_or("WALLET_TRANSACTION_FORMAT")?,
    )
    .map_err(|_| "WALLET_TRANSACTION_FORMAT")?;
    Ok((to, data))
}
pub fn unsigned_hash(tx: &Transaction) -> Result<String> {
    let (to, data) = validated(tx)?;
    let mut unsigned = RlpStream::new_list(9);
    fields(tx, &mut unsigned, &to, &data)?;
    let mut preimage = vec![2];
    preimage.extend_from_slice(&unsigned.out());
    Ok("0x".to_owned() + &hex::encode(Keccak256::digest(&preimage)))
}
pub fn raw_hash(raw: &str) -> Result<String> {
    if raw.len() > 34000 {
        return Err("WALLET_TRANSACTION_FORMAT");
    }
    let bytes = hex::decode(raw.strip_prefix("0x").ok_or("WALLET_TRANSACTION_FORMAT")?)
        .map_err(|_| "WALLET_TRANSACTION_FORMAT")?;
    Ok("0x".to_owned() + &hex::encode(Keccak256::digest(bytes)))
}
pub fn sign(bytes: &[u8], tx: &Transaction) -> Result<String> {
    let (to, data) = validated(tx)?;
    let hash = hex::decode(&unsigned_hash(tx)?[2..]).map_err(|_| "WALLET_TRANSACTION_FORMAT")?;
    let (signature, recovery) = signing_key(bytes)?
        .sign_prehash_recoverable(&hash)
        .map_err(|_| "WALLET_SIGN_FAILED")?;
    if recovery.to_byte() > 1 {
        return Err("WALLET_SIGN_FAILED");
    }
    let mut signed = RlpStream::new_list(12);
    fields(tx, &mut signed, &to, &data)?;
    signed.append(&u64::from(recovery.to_byte()));
    integer(
        &mut signed,
        U256::from_be_bytes(signature.r().to_bytes().into()),
    );
    integer(
        &mut signed,
        U256::from_be_bytes(signature.s().to_bytes().into()),
    );
    let mut raw = vec![2];
    raw.extend_from_slice(&signed.out());
    Ok("0x".to_owned() + &hex::encode(raw))
}
