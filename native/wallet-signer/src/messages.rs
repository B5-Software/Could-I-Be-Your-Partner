// SPDX-License-Identifier: GPL-3.0-or-later
//! Human-only message approvals and encrypted receipts. Never consume or grant
//! transaction authority: a message may authorize spending outside this app.
use crate::{Result, authority::now};
use alloy_dyn_abi::eip712::TypedData;
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use k256::ecdsa::SigningKey;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sha3::Keccak256;
use zeroize::Zeroizing;
const INVALID: &str = "WALLET_MESSAGE_INVALID";
const STORE: &str = "WALLET_RECEIPT_STORE_FAILED";
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Message {
    pub kind: String,
    pub payload: String,
    pub origin: String,
    pub connection_id: String,
    pub chain_id: u64,
}
fn hash(bytes: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn hexhash(bytes: impl AsRef<[u8]>) -> String {
    "0x".to_owned() + &hex::encode(Keccak256::digest(bytes))
}
fn identifier(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 128
        && v.bytes()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || b"_$".contains(&c))
        && v.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_$:".contains(&c))
}
fn field_type(v: &str) -> bool {
    v.len() <= 256
        && v.bytes().filter(|c| *c == b'[').count() <= 32
        && v.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_$:[]".contains(&c))
}
fn bounded(v: &Value, depth: usize, nodes: &mut usize) -> Result<()> {
    *nodes += 1;
    if depth > 32 || *nodes > 4096 {
        return Err(INVALID);
    }
    match v {
        Value::Array(items) => {
            for item in items {
                bounded(item, depth + 1, nodes)?;
            }
        }
        Value::Object(items) => {
            for item in items.values() {
                bounded(item, depth + 1, nodes)?;
            }
        }
        Value::Number(n)
            if n.as_u64().is_some_and(|n| n > 9007199254740991)
                || n.as_i64().is_some_and(|n| n < -9007199254740991)
                || n.is_f64() =>
        {
            return Err(INVALID);
        }
        _ => {}
    }
    Ok(())
}
fn expansion(
    types: &serde_json::Map<String, Value>,
    root: &str,
    depth: usize,
    count: &mut usize,
) -> Result<()> {
    *count += 1;
    if depth > 32 || *count > 4096 {
        return Err(INVALID);
    }
    for field in types.get(root).and_then(Value::as_array).ok_or(INVALID)? {
        let child = field["type"]
            .as_str()
            .ok_or(INVALID)?
            .split('[')
            .next()
            .ok_or(INVALID)?;
        if types.contains_key(child) {
            expansion(types, child, depth + 1, count)?;
        }
    }
    Ok(())
}
impl Message {
    pub fn digest(&self) -> Result<String> {
        if self.payload.len() > 32768
            || self.origin.len() > 2048
            || !(self.origin.starts_with("https://")
                || ["http://127.0.0.1", "http://localhost", "http://[::1]"]
                    .contains(&self.origin.as_str())
                || self.origin.starts_with("http://127.0.0.1:")
                || self.origin.starts_with("http://localhost:")
                || self.origin.starts_with("http://[::1]:"))
            || self.origin.chars().any(char::is_whitespace)
            || self.connection_id.len() != 36
            || !self
                .connection_id
                .bytes()
                .all(|b| b.is_ascii_hexdigit() || b == b'-')
            || !crate::evm::valid_chain_id(self.chain_id)
        {
            return Err(INVALID);
        }
        match self.kind.as_str() {
            "personal" => {
                let bytes = hex::decode(self.payload.strip_prefix("0x").ok_or(INVALID)?)
                    .map_err(|_| INVALID)?;
                let mut preimage =
                    format!("\x19Ethereum Signed Message:\n{}", bytes.len()).into_bytes();
                preimage.extend(bytes);
                Ok(hexhash(preimage))
            }
            "typed" => {
                let data: Value = serde_json::from_str(&self.payload).map_err(|_| INVALID)?;
                bounded(&data, 0, &mut 0)?;
                let obj = data.as_object().ok_or(INVALID)?;
                if obj.len() != 4
                    || !obj.keys().all(|k| {
                        ["types", "domain", "primaryType", "message"].contains(&k.as_str())
                    })
                {
                    return Err(INVALID);
                }
                let types = data["types"].as_object().ok_or(INVALID)?;
                if !data["message"].is_object()
                    || (data["primaryType"] == "EIP712Domain"
                        && !data["message"].as_object().ok_or(INVALID)?.is_empty())
                {
                    return Err(INVALID);
                }
                if types.len() > 64 || types.is_empty() || types.keys().any(|key| !identifier(key))
                {
                    return Err(INVALID);
                }
                let domain = data["domain"].as_object().ok_or(INVALID)?;
                let expected = [
                    ("name", "string"),
                    ("version", "string"),
                    ("chainId", "uint256"),
                    ("verifyingContract", "address"),
                    ("salt", "bytes32"),
                ];
                if domain
                    .keys()
                    .any(|k| !expected.iter().any(|(name, _)| k == name))
                {
                    return Err(INVALID);
                }
                let mut fields = 0;
                for schema in types.values() {
                    let schema = schema.as_array().ok_or(INVALID)?;
                    fields += schema.len();
                    let mut names = std::collections::BTreeSet::new();
                    if fields > 256
                        || schema.iter().any(|p| {
                            p.as_object().is_none_or(|p| {
                                p.len() != 2 || !p.contains_key("name") || !p.contains_key("type")
                            }) || !identifier(p["name"].as_str().unwrap_or(""))
                                || !p["type"].as_str().is_some_and(field_type)
                                || !names.insert(p["name"].as_str().unwrap_or(""))
                        })
                    {
                        return Err(INVALID);
                    }
                }
                let domain_type = data["types"]["EIP712Domain"].as_array().ok_or(INVALID)?;
                if domain_type.len() != domain.len()
                    || domain_type.iter().any(|p| {
                        !expected.iter().any(|(name, ty)| {
                            p["name"] == *name && p["type"] == *ty && domain.contains_key(*name)
                        })
                    })
                {
                    return Err(INVALID);
                }
                if let Some(chain) = domain.get("chainId") {
                    let chain = chain
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| chain.to_string());
                    let chain = if let Some(hex) = chain.strip_prefix("0x") {
                        u64::from_str_radix(hex, 16)
                    } else {
                        chain.parse()
                    }
                    .map_err(|_| INVALID)?;
                    if chain != self.chain_id {
                        return Err("WALLET_MESSAGE_CHAIN");
                    }
                }
                expansion(
                    types,
                    data["primaryType"].as_str().ok_or(INVALID)?,
                    0,
                    &mut 0,
                )?;
                expansion(types, "EIP712Domain", 0, &mut 0)?;
                let parsed: TypedData =
                    serde_json::from_value(data.clone()).map_err(|_| INVALID)?;
                let mut domain_data = data.clone();
                domain_data["primaryType"] = json!("EIP712Domain");
                domain_data["message"] = data["domain"].clone();
                let domain_data: TypedData =
                    serde_json::from_value(domain_data).map_err(|_| INVALID)?;
                let mut preimage = vec![0x19, 0x01];
                preimage.extend(domain_data.hash_struct().map_err(|_| INVALID)?.as_slice());
                if parsed.primary_type != "EIP712Domain" {
                    preimage.extend(parsed.hash_struct().map_err(|_| INVALID)?.as_slice());
                }
                Ok(hexhash(preimage))
            }
            _ => Err(INVALID),
        }
    }
    pub fn binding(&self) -> Result<String> {
        Ok(hash(serde_json::to_vec(self).map_err(|_| INVALID)?))
    }
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Approval {
    pub wallet_id: String,
    pub address: String,
    pub binding: String,
    pub digest: String,
    pub session: String,
    pub expires_at: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    approval: Approval,
    sealed: String,
    nonce: String,
    signature_hash: String,
}
fn read<T: serde::de::DeserializeOwned>(
    c: &Connection,
    table: &str,
    id: &str,
) -> Result<Option<T>> {
    let sql = match table {
        "approvals" => "SELECT body,checksum FROM message_approvals WHERE id=?1",
        "receipts" => "SELECT body,checksum FROM message_receipts WHERE id=?1",
        _ => return Err(STORE),
    };
    let row: Option<(String, String)> = c
        .query_row(sql, [id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(|_| STORE)?;
    row.map(|(body, checksum)| {
        if body.len() > 8192 || hash(&body) != checksum {
            return Err(STORE);
        }
        serde_json::from_str(&body).map_err(|_| STORE)
    })
    .transpose()
}
fn put(c: &Connection, table: &str, id: &str, v: &impl Serialize) -> Result<()> {
    let sql = match table {
        "approvals" => {
            "INSERT INTO message_approvals VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET body=excluded.body,checksum=excluded.checksum"
        }
        "receipts" => "INSERT INTO message_receipts VALUES(?1,?2,?3)",
        _ => return Err(STORE),
    };
    let body = serde_json::to_string(v).map_err(|_| STORE)?;
    c.execute(sql, params![id, body, hash(&body)])
        .map_err(|_| STORE)?;
    Ok(())
}
pub fn initialize(c: &Connection) -> Result<()> {
    c.execute_batch("BEGIN IMMEDIATE;CREATE TABLE message_approvals (id TEXT PRIMARY KEY,body TEXT NOT NULL,checksum TEXT NOT NULL) STRICT;CREATE TABLE message_receipts (id TEXT PRIMARY KEY,body TEXT NOT NULL,checksum TEXT NOT NULL) STRICT;CREATE TABLE message_metadata (id INTEGER PRIMARY KEY CHECK(id=1),receipts INTEGER NOT NULL CHECK(receipts BETWEEN 0 AND 200000)) STRICT;INSERT INTO message_metadata VALUES(1,0);PRAGMA user_version=8;COMMIT;").map_err(|_| STORE)
}
fn counts(c: &Connection) -> Result<()> {
    let (actual,expected):(i64,i64) = c.query_row("SELECT (SELECT count(*) FROM message_receipts),receipts FROM message_metadata WHERE id=1",[],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_| STORE)?;
    if actual != expected {
        return Err(STORE);
    }
    Ok(())
}
pub fn validate(c: &Connection) -> Result<()> {
    counts(c)?;
    for table in ["message_approvals", "message_receipts"] {
        let mut query = c
            .prepare(&format!("SELECT id FROM {table}"))
            .map_err(|_| STORE)?;
        let mut rows = query.query([]).map_err(|_| STORE)?;
        while let Some(row) = rows.next().map_err(|_| STORE)? {
            let id: String = row.get(0).map_err(|_| STORE)?;
            if table == "message_receipts" {
                let _: Receipt = read(c, "receipts", &id)?.ok_or(STORE)?;
            } else {
                let _: Approval = read(c, "approvals", &id)?.ok_or(STORE)?;
            }
        }
    }
    Ok(())
}
fn denied(c: &Connection, id: &str) -> Result<bool> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM denials WHERE operation_id=?1)",
        [id],
        |r| r.get(0),
    )
    .map_err(|_| STORE)
}
pub fn approve(c: &Connection, id: &str, approval: &Approval) -> Result<()> {
    counts(c)?;
    let current = now()?;
    if approval.expires_at <= current || approval.expires_at - current > 600000 || denied(c, id)? {
        return Err("WALLET_MESSAGE_APPROVAL");
    }
    put(c, "approvals", id, approval)
}
fn check(c: &Connection, id: &str, approval: &Approval) -> Result<()> {
    let stored: Approval = read(c, "approvals", id)?.ok_or("WALLET_MESSAGE_APPROVAL")?;
    if denied(c, id)?
        || approval.expires_at <= now()?
        || serde_json::to_value(stored).map_err(|_| STORE)?
            != serde_json::to_value(approval).map_err(|_| STORE)?
    {
        return Err("WALLET_MESSAGE_APPROVAL");
    }
    Ok(())
}
fn key(bytes: &[u8], store: &str) -> Result<Zeroizing<[u8; 32]>> {
    let mut key = Zeroizing::new([0; 32]);
    hkdf::Hkdf::<Sha256>::new(Some(store.as_bytes()), bytes)
        .expand(b"CIBYP-WALLET-MESSAGE-RECEIPT/1", &mut *key)
        .map_err(|_| STORE)?;
    Ok(key)
}
fn aad(store: &str, operation: &str, approval: &Approval) -> Result<Vec<u8>> {
    serde_json::to_vec(&(store, operation, approval)).map_err(|_| STORE)
}
pub fn summary(c: &Connection, store: &str, id: &str) -> Result<Value> {
    Ok(match read::<Receipt>(c, "receipts", id)? {
        Some(r) => {
            json!({"found":true,"version":1,"storeId":store,"operationId":id,"walletId":r.approval.wallet_id,"address":r.approval.address,"digest":r.approval.digest,"binding":r.approval.binding,"signatureHash":r.signature_hash})
        }
        None => {
            validate(c)?;
            json!({"found":false,"version":1,"storeId":store})
        }
    })
}
pub fn sign(
    c: &Connection,
    store: &str,
    id: &str,
    approval: &Approval,
    private_key: &[u8],
) -> Result<Value> {
    counts(c)?;
    check(c, id, approval)?;
    let key = key(private_key, store)?;
    let aad = aad(store, id, approval)?;
    let signature = if let Some(r) = read::<Receipt>(c, "receipts", id)? {
        if r.approval.binding != approval.binding
            || r.approval.wallet_id != approval.wallet_id
            || r.approval.address != approval.address
        {
            return Err("WALLET_RECEIPT_CONFLICT");
        }
        // The encryption binding includes the original unlock session. Reapproval
        // may permit replay after unlock, but cannot rewrite the stored binding.
        let original_aad = self::aad(store, id, &r.approval)?;
        let nonce = hex::decode(&r.nonce).map_err(|_| STORE)?;
        if nonce.len() != 24 {
            return Err(STORE);
        }
        let ciphertext = hex::decode(&r.sealed).map_err(|_| STORE)?;
        let plain = Zeroizing::new(
            XChaCha20Poly1305::new((&*key).into())
                .decrypt(
                    XNonce::from_slice(&nonce),
                    Payload {
                        msg: &ciphertext,
                        aad: &original_aad,
                    },
                )
                .map_err(|_| STORE)?,
        );
        if plain.len() != 65 || hexhash(&*plain) != r.signature_hash {
            return Err(STORE);
        }
        Zeroizing::new("0x".to_owned() + &hex::encode(&*plain))
    } else {
        let digest =
            hex::decode(approval.digest.strip_prefix("0x").ok_or(INVALID)?).map_err(|_| INVALID)?;
        let (sig, recovery) = SigningKey::from_slice(private_key)
            .map_err(|_| INVALID)?
            .sign_prehash_recoverable(&digest)
            .map_err(|_| "WALLET_SIGN_FAILED")?;
        if recovery.to_byte() > 1 {
            return Err("WALLET_SIGN_FAILED");
        }
        let mut bytes = Zeroizing::new(sig.to_bytes().to_vec());
        bytes.push(27 + recovery.to_byte());
        let nonce = crate::random::<24>()?;
        let ciphertext = XChaCha20Poly1305::new((&*key).into())
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &bytes,
                    aad: &aad,
                },
            )
            .map_err(|_| STORE)?;
        let count: i64 = c
            .query_row(
                "SELECT receipts FROM message_metadata WHERE id=1",
                [],
                |r| r.get(0),
            )
            .map_err(|_| STORE)?;
        if count >= 200000 {
            return Err("WALLET_RECEIPT_STORE_FULL");
        }
        put(
            c,
            "receipts",
            id,
            &Receipt {
                approval: approval.clone(),
                sealed: hex::encode(ciphertext),
                nonce: hex::encode(nonce),
                signature_hash: hexhash(&*bytes),
            },
        )?;
        c.execute(
            "UPDATE message_metadata SET receipts=receipts+1 WHERE id=1",
            [],
        )
        .map_err(|_| STORE)?;
        Zeroizing::new("0x".to_owned() + &hex::encode(&*bytes))
    };
    Ok(json!({"signature":signature.as_str(),"receipt":summary(c,store,id)?}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn message(kind: &str, payload: String) -> Message {
        Message {
            kind: kind.into(),
            payload,
            origin: "https://example.com".into(),
            connection_id: "11111111-1111-1111-1111-111111111111".into(),
            chain_id: 1,
        }
    }
    #[test]
    fn official_mail_vector() {
        let data = json!({"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],"Person":[{"name":"name","type":"string"},{"name":"wallet","type":"address"}],"Mail":[{"name":"from","type":"Person"},{"name":"to","type":"Person"},{"name":"contents","type":"string"}]},"primaryType":"Mail","domain":{"name":"Ether Mail","version":"1","chainId":1,"verifyingContract":"0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"},"message":{"from":{"name":"Cow","wallet":"0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"},"to":{"name":"Bob","wallet":"0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"},"contents":"Hello, Bob!"}});
        assert_eq!(
            message("typed", data.to_string()).digest().unwrap(),
            "0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2"
        );
    }
    #[test]
    fn personal_prefix_is_distinct_from_raw_hash_and_binding_includes_site() {
        let mut m = message("personal", "0x68656c6c6f".into());
        assert_ne!(m.digest().unwrap(), hexhash(b"hello"));
        let digest = m.digest().unwrap();
        let binding = m.binding().unwrap();
        m.origin = "https://other.example".into();
        assert_eq!(m.digest().unwrap(), digest);
        assert_ne!(m.binding().unwrap(), binding);
        for origin in ["http://127.0.0.1", "http://localhost", "http://[::1]"] {
            m.origin = origin.into();
            assert_eq!(m.digest().unwrap(), digest);
        }
    }
    #[test]
    fn amplified_type_graph_is_bounded_before_library_expansion() {
        let array_bomb = json!({"types":{"EIP712Domain":[],"Bomb":[{"name":"value","type":format!("uint256{}","[]".repeat(1000))}]},"domain":{},"primaryType":"Bomb","message":{"value":[]}});
        assert_eq!(
            message("typed", array_bomb.to_string()).digest(),
            Err(INVALID)
        );
        let mut types = serde_json::Map::new();
        types.insert("EIP712Domain".into(), json!([]));
        types.insert("T0".into(), json!([{"name":"n","type":"uint256"}]));
        for n in 1..20 {
            types.insert(format!("T{n}"),json!([{"name":"a","type":format!("T{}",n-1)},{"name":"b","type":format!("T{}",n-1)}]));
        }
        assert_eq!(expansion(&types, "T19", 0, &mut 0), Err(INVALID));
        assert_eq!(
            message(
                "typed",
                json!({"types":types,"domain":{},"primaryType":"T19","message":{}}).to_string()
            )
            .digest(),
            Err(INVALID)
        );
    }
    #[test]
    fn encrypted_receipt_count_detects_missing_signatures() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE denials(operation_id TEXT PRIMARY KEY);")
            .unwrap();
        initialize(&c).unwrap();
        let m = message("personal", "0x6869".into());
        let private_key = hex::decode(format!("{:0>64}", "1")).unwrap();
        let a = Approval {
            wallet_id: "fixture".into(),
            address: crate::evm::address(&private_key).unwrap(),
            binding: m.binding().unwrap(),
            digest: m.digest().unwrap(),
            session: "fixture-session".into(),
            expires_at: now().unwrap() + 300000,
        };
        approve(&c, "message-one", &a).unwrap();
        let result = sign(&c, "fixture-store", "message-one", &a, &private_key).unwrap();
        let body: String = c
            .query_row("SELECT body FROM message_receipts", [], |r| r.get(0))
            .unwrap();
        assert!(!body.contains(result["signature"].as_str().unwrap()));
        assert_eq!(
            sign(&c, "fixture-store", "message-one", &a, &private_key).unwrap()["signature"],
            result["signature"]
        );
        validate(&c).unwrap();
        c.execute("DELETE FROM message_receipts", []).unwrap();
        assert_eq!(
            sign(&c, "fixture-store", "message-one", &a, &private_key),
            Err(STORE)
        );
        assert_eq!(approve(&c, "message-one", &a), Err(STORE));
        assert_eq!(validate(&c), Err(STORE));
        assert_eq!(summary(&c, "fixture-store", "message-one"), Err(STORE));
    }
}
