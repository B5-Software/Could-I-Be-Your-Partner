// SPDX-License-Identifier: GPL-3.0-or-later
#![forbid(unsafe_code)]
pub mod agent_scopes;
pub mod authority;
pub mod evm;
pub mod legacy;
pub mod periods;
pub mod portfolio;
pub mod portfolio_history;
pub mod receipts;
pub mod scope;
pub mod tokens;
pub mod vault;
pub type Result<T> = core::result::Result<T, &'static str>;
pub const PATH: &str = "m/44'/60'/0'/0/0";
pub fn random<const N: usize>() -> Result<[u8; N]> {
    let mut bytes = [0; N];
    getrandom::getrandom(&mut bytes).map_err(|_| "WALLET_ENTROPY_UNAVAILABLE")?;
    Ok(bytes)
}

use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};
#[derive(Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    pub id: String,
    pub password: Option<String>,
    pub source_password: Option<String>,
    pub new_password: Option<String>,
    pub secret: Option<String>,
    pub kind: Option<String>,
    pub keystore: Option<String>,
    pub expected_address: Option<String>,
    pub operation_id: Option<String>,
    pub store_id: Option<String>,
    pub policy_id: Option<String>,
    pub budget_id: Option<String>,
    pub agent_scope_id: Option<String>,
    pub agent_subject: Option<String>,
    pub fee_reserve_wei: Option<String>,
    pub replacement_of: Option<String>,
    #[zeroize(skip)]
    pub expires_at: Option<u64>,
    #[zeroize(skip)]
    pub grant: Option<authority::Grant>,
    #[zeroize(skip)]
    pub portfolio: Option<portfolio::Portfolio>,
    #[zeroize(skip)]
    pub scope: Option<agent_scopes::Scope>,
    #[zeroize(skip)]
    pub offset: Option<u32>,
    #[zeroize(skip)]
    pub limit: Option<u32>,
    #[zeroize(skip)]
    pub expected_revision: Option<u64>,
    #[zeroize(skip)]
    pub execution: Option<authority::Execution>,
    #[zeroize(skip)]
    pub minutes: Option<u16>,
    #[zeroize(skip)]
    pub transaction: Option<evm::Transaction>,
}
struct Unlocked {
    key: Zeroizing<Vec<u8>>,
    until: Option<Instant>,
    session: String,
}
pub struct Signer {
    unlocked: BTreeMap<String, Unlocked>,
    store: receipts::Store,
}
fn material(phrase: &str) -> Result<vault::Secret> {
    let mnemonic = bip39::Mnemonic::parse(phrase).map_err(|_| "WALLET_MNEMONIC_FORMAT")?;
    let seed = Zeroizing::new(mnemonic.to_seed(""));
    let path = PATH.parse().map_err(|_| "WALLET_OPERATION_FAILED")?;
    let derived = bip32::XPrv::derive_from_path(seed.as_slice(), &path)
        .map_err(|_| "WALLET_OPERATION_FAILED")?;
    let derived_bytes = Zeroizing::new(derived.to_bytes());
    Ok(vault::Secret {
        private_key: hex::encode(derived_bytes.as_slice()),
        mnemonic: Some(mnemonic.to_string()),
        derivation_path: Some(PATH.into()),
    })
}
fn decrypt(text: &str, password: &str) -> Result<vault::Secret> {
    if text.len() > 65536 {
        return Err("WALLET_KEYSTORE_LIMIT");
    }
    let is_native = serde_json::from_str::<Value>(text)
        .map_err(|_| "WALLET_KEYSTORE_FORMAT")?
        .get("header")
        .is_some();
    if is_native {
        vault::decrypt(text, password)
    } else {
        legacy::decrypt(text, password)
    }
}
impl Signer {
    pub fn open(directory: &std::path::Path) -> Result<Self> {
        Ok(Self {
            unlocked: BTreeMap::new(),
            store: receipts::Store::open(directory)?,
        })
    }
    pub fn expired(&mut self) -> Vec<String> {
        let now = Instant::now();
        let ids: Vec<_> = self
            .unlocked
            .iter()
            .filter(|(_, entry)| entry.until.is_some_and(|until| now >= until))
            .map(|(id, _)| id.clone())
            .collect();
        for id in &ids {
            self.unlocked.remove(id);
        }
        ids
    }
    pub fn request(&mut self, action: &str, input: &Input) -> Result<Value> {
        self.expired();
        if input.id.is_empty()
            || input.id.len() > 80
            || !input
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err("WALLET_ID");
        }
        match action {
            "scope.ensure" => {
                let scope = input.scope.as_ref().ok_or("WALLET_AGENT_SCOPE_INVALID")?;
                if scope.id != input.id {
                    return Err("WALLET_AGENT_SCOPE_INVALID");
                }
                self.store
                    .edit(|connection| agent_scopes::ensure(connection, scope))
            }
            "scope.list" => agent_scopes::list(
                &self.store.connection,
                input.offset.unwrap_or(0),
                input.agent_scope_id.as_deref(),
            ),
            "scope.get" => agent_scopes::get(&self.store.connection, &input.id),
            "scope.state" => self.store.edit(|connection| {
                agent_scopes::state(
                    connection,
                    &input.id,
                    input.kind.as_deref().ok_or("WALLET_AGENT_SCOPE_INVALID")?,
                    input
                        .expected_revision
                        .ok_or("WALLET_AGENT_SCOPE_INVALID")?,
                    input.agent_scope_id.as_deref(),
                )
            }),
            "portfolio.list" => portfolio::list(&self.store.connection, input.offset.unwrap_or(0)),
            "portfolio.get" => portfolio::get(&self.store.connection, &input.id),
            "portfolio.revisions" => portfolio_history::list(
                &self.store.connection,
                &input.id,
                input.offset.unwrap_or(0),
            ),
            "portfolio.revision" => portfolio_history::get(
                &self.store.connection,
                &input.id,
                input.expected_revision.ok_or("WALLET_PORTFOLIO_INVALID")?,
            ),
            "portfolio.update" => {
                let value = input.portfolio.as_ref().ok_or("WALLET_PORTFOLIO_INVALID")?;
                if value.id != input.id {
                    return Err("WALLET_PORTFOLIO_INVALID");
                }
                self.store.edit(|c| {
                    portfolio::update(
                        c,
                        value,
                        input.expected_revision.ok_or("WALLET_PORTFOLIO_INVALID")?,
                    )
                })
            }
            "portfolio.create" => {
                let value = input.portfolio.as_ref().ok_or("WALLET_PORTFOLIO_INVALID")?;
                if value.id != input.id {
                    return Err("WALLET_PORTFOLIO_INVALID");
                }
                self.store
                    .edit(|connection| portfolio::create(connection, value))
            }
            "portfolio.state" => self.store.edit(|connection| {
                portfolio::state(
                    connection,
                    &input.id,
                    input.kind.as_deref().ok_or("WALLET_PORTFOLIO_INVALID")?,
                    input.expected_revision.ok_or("WALLET_PORTFOLIO_INVALID")?,
                )
            }),
            "authority.inspect" => {
                self.store
                    .check(input.store_id.as_deref().ok_or("WALLET_RECEIPT_REQUIRED")?)?;
                authority::inspect(
                    &self.store.connection,
                    &input.id,
                    input
                        .policy_id
                        .as_deref()
                        .ok_or("WALLET_NATIVE_AUTH_INVALID")?,
                )
            }
            "transaction.inspect" => {
                let entry = self.unlocked.get(&input.id).ok_or("WALLET_LOCKED")?;
                let tx = input
                    .transaction
                    .as_ref()
                    .ok_or("WALLET_TRANSACTION_FORMAT")?;
                evm::unsigned_hash(tx)?;
                serde_json::to_value(tokens::analyze(tx, &evm::address(&entry.key)?))
                    .map_err(|_| "WALLET_TRANSACTION_FORMAT")
            }
            "authority.grant" => {
                let grant = input.grant.as_ref().ok_or("WALLET_NATIVE_AUTH_INVALID")?;
                if grant.wallet_id != input.id {
                    return Err("WALLET_NATIVE_AUTH_INVALID");
                }
                self.store
                    .edit(|connection| authority::grant(connection, grant))?;
                Ok(json!({"ok":true,"storeId":self.store.id}))
            }
            "authority.revoke" => {
                let generation = self
                    .store
                    .edit(|connection| authority::revoke(connection, &input.id))?;
                Ok(json!({"ok":true,"generation":generation}))
            }
            "operation.deny" => {
                let operation = operation_id(input)?;
                self.store.edit(|connection| {
                    connection
                        .execute("INSERT OR IGNORE INTO denials VALUES(?1)", [operation])
                        .map_err(|_| "WALLET_RECEIPT_STORE_FAILED")?;
                    Ok(())
                })?;
                Ok(json!({"ok":true}))
            }
            "nonce.inspect" => {
                let tx = input
                    .transaction
                    .as_ref()
                    .ok_or("WALLET_TRANSACTION_FORMAT")?;
                evm::unsigned_hash(tx)?;
                let address = input
                    .expected_address
                    .as_deref()
                    .ok_or("WALLET_NATIVE_AUTH_INVALID")?;
                Ok(
                    json!({"hash":authority::nonce(&self.store.connection,address,tx.chain_id,tx.nonce)?}),
                )
            }
            "operation.approve" => {
                let entry = self.unlocked.get(&input.id).ok_or("WALLET_LOCKED")?;
                let operation = operation_id(input)?;
                let tx = input
                    .transaction
                    .as_ref()
                    .ok_or("WALLET_TRANSACTION_FORMAT")?;
                let value = authority::Approval {
                    wallet_id: input.id.clone(),
                    address: evm::address(&entry.key)?,
                    unsigned_hash: evm::unsigned_hash(tx)?,
                    session: entry.session.clone(),
                    expires_at: input.expires_at.ok_or("WALLET_NATIVE_AUTH_INVALID")?,
                    fee_reserve_wei: input
                        .fee_reserve_wei
                        .clone()
                        .ok_or("WALLET_NATIVE_AUTH_INVALID")?,
                    replacement_of: input.replacement_of.clone(),
                    agent_scope_id: input.agent_scope_id.clone(),
                    agent_subject: input.agent_subject.clone(),
                };
                self.store
                    .edit(|connection| authority::approve(connection, operation, &value))?;
                Ok(json!({"ok":true,"storeId":self.store.id}))
            }
            "period.history" => periods::history(
                &self.store.connection,
                input.kind.as_deref().ok_or("WALLET_PERIOD_INVALID")?,
                input.budget_id.as_deref().ok_or("WALLET_PERIOD_INVALID")?,
                input.offset.unwrap_or(0),
                input.limit.unwrap_or(2),
            ),
            "receipt.status" => Ok(json!({"version":1,"storeId":self.store.id})),
            "receipt.get" => {
                self.store
                    .check(input.store_id.as_deref().ok_or("WALLET_RECEIPT_REQUIRED")?)?;
                let operation = operation_id(input)?;
                Ok(match self.store.get(operation)? {
                    Some(receipt) => {
                        json!({"found":true,"receipt":receipt.summary(&self.store.id)})
                    }
                    None => {
                        self.store.prove_absent(operation)?;
                        json!({"found":false,"version":1,"storeId":self.store.id})
                    }
                })
            }
            "create" | "import" => {
                self.unlocked.remove(&input.id);
                let password = input.password.as_deref().ok_or("WALLET_PASSWORD_LENGTH")?;
                let mut reveal = false;
                let secret = if action == "create" {
                    reveal = true;
                    let entropy = Zeroizing::new(random::<32>()?);
                    let phrase = bip39::Mnemonic::from_entropy(&*entropy)
                        .map_err(|_| "WALLET_OPERATION_FAILED")?;
                    let text = Zeroizing::new(phrase.to_string());
                    material(&text)?
                } else {
                    let text = input.secret.as_deref().ok_or("WALLET_IMPORT_KIND")?;
                    match input.kind.as_deref() {
                        Some("privateKey") => {
                            let key = Zeroizing::new(
                                hex::decode(text.strip_prefix("0x").unwrap_or(text))
                                    .map_err(|_| "WALLET_PRIVATE_KEY_FORMAT")?,
                            );
                            evm::address(&key)?;
                            vault::Secret {
                                private_key: hex::encode(&*key),
                                mnemonic: None,
                                derivation_path: None,
                            }
                        }
                        Some("mnemonic") => material(text)?,
                        Some("keystore") => decrypt(
                            text,
                            input
                                .source_password
                                .as_deref()
                                .filter(|s| !s.is_empty())
                                .unwrap_or(password),
                        )?,
                        _ => return Err("WALLET_IMPORT_KIND"),
                    }
                };
                let keystore = vault::encrypt(&secret, password)?;
                let key = Zeroizing::new(
                    hex::decode(&secret.private_key).map_err(|_| "WALLET_PRIVATE_KEY_FORMAT")?,
                );
                let mut result = json!({"address":evm::address(&key)?,"keystore":keystore,"format":"CIBYP-WALLET/1"});
                if reveal {
                    result["mnemonic"] = json!(
                        secret
                            .mnemonic
                            .as_deref()
                            .ok_or("WALLET_OPERATION_FAILED")?
                    );
                }
                Ok(result)
            }
            "unlock" | "reencrypt" => {
                self.unlocked.remove(&input.id);
                let secret = decrypt(
                    input.keystore.as_deref().ok_or("WALLET_KEYSTORE_FORMAT")?,
                    input.password.as_deref().ok_or("WALLET_PASSWORD_LENGTH")?,
                )?;
                let key = Zeroizing::new(
                    hex::decode(&secret.private_key).map_err(|_| "WALLET_PRIVATE_KEY_FORMAT")?,
                );
                let address = evm::address(&key)?;
                if input
                    .expected_address
                    .as_deref()
                    .is_some_and(|expected| !expected.eq_ignore_ascii_case(&address))
                {
                    return Err("WALLET_ADDRESS_MISMATCH");
                }
                if action == "reencrypt" {
                    return Ok(
                        json!({"address":address,"keystore":vault::encrypt(&secret,input.new_password.as_deref().ok_or("WALLET_PASSWORD_LENGTH")?)?,"format":"CIBYP-WALLET/1"}),
                    );
                }
                let minutes = input.minutes.unwrap_or(15);
                if minutes > 1440 {
                    return Err("WALLET_UNLOCK_DURATION");
                }
                let ttl = Duration::from_secs(u64::from(minutes) * 60);
                let until = if minutes == 0 {
                    0
                } else {
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map_err(|_| "WALLET_CLOCK_UNAVAILABLE")?
                        .as_millis() as u64
                        + ttl.as_millis() as u64
                };
                self.unlocked.insert(
                    input.id.clone(),
                    Unlocked {
                        key,
                        session: hex::encode(random::<32>()?),
                        until: if minutes == 0 {
                            None
                        } else {
                            Some(Instant::now() + ttl)
                        },
                    },
                );
                Ok(json!({"address":address,"until":until}))
            }
            "lock" => {
                self.unlocked.remove(&input.id);
                Ok(json!({"locked":true}))
            }
            "sign" => {
                let entry = self.unlocked.get(&input.id).ok_or("WALLET_LOCKED")?;
                self.store
                    .check(input.store_id.as_deref().ok_or("WALLET_RECEIPT_REQUIRED")?)?;
                let operation = operation_id(input)?;
                let tx = input
                    .transaction
                    .as_ref()
                    .ok_or("WALLET_TRANSACTION_FORMAT")?;
                let unsigned_hash = evm::unsigned_hash(tx)?;
                let address = evm::address(&entry.key)?;
                let existing = self.store.get(operation)?;
                if let Some(receipt) = existing.as_ref()
                    && (receipt.wallet_id != input.id
                        || receipt.address != address
                        || receipt.unsigned_hash != unsigned_hash)
                {
                    return Err("WALLET_RECEIPT_CONFLICT");
                }
                let check = authority::Check {
                    checked_at_ms: authority::now()?,
                    expires_at: input.expires_at.ok_or("WALLET_NATIVE_AUTH_INVALID")?,
                    wallet_id: &input.id,
                    address: &address,
                    operation_id: operation,
                    session: &entry.session,
                    transaction: tx,
                    unsigned_hash: &unsigned_hash,
                    fee_reserve_wei: input
                        .fee_reserve_wei
                        .as_deref()
                        .ok_or("WALLET_NATIVE_AUTH_REQUIRED")?,
                    policy_id: input.policy_id.as_deref(),
                    execution: input.execution.as_ref(),
                    replay: existing.is_some(),
                    replacement_of: input.replacement_of.as_deref(),
                    agent_scope_id: input.agent_scope_id.as_deref(),
                    agent_subject: input.agent_subject.as_deref(),
                };
                authority::check(&self.store.connection, &check)?;
                if let Some(receipt) = existing {
                    if receipt.wallet_id != input.id
                        || receipt.address != address
                        || receipt.unsigned_hash != unsigned_hash
                    {
                        return Err("WALLET_RECEIPT_CONFLICT");
                    }
                    let raw = receipt.open_raw(&entry.key, &self.store.id)?;
                    return Ok(
                        json!({"raw":raw.as_str(),"receipt":receipt.summary(&self.store.id)}),
                    );
                }
                let raw = Zeroizing::new(evm::sign(&entry.key, tx)?);
                let mut receipt = receipts::Receipt {
                    operation_id: operation.into(),
                    wallet_id: input.id.clone(),
                    address: address.clone(),
                    unsigned_hash: unsigned_hash.clone(),
                    hash: evm::raw_hash(&raw)?,
                    sealed_raw: String::new(),
                    nonce_hex: String::new(),
                    chain_id: tx.chain_id,
                    nonce: tx.nonce,
                };
                receipt.seal(&entry.key, &self.store.id, &raw)?;
                self.store.commit_checked(&receipt, Some(&check))?;
                Ok(json!({"raw":raw.as_str(),"receipt":receipt.summary(&self.store.id)}))
            }
            _ => Err("WALLET_SIGNER_ACTION"),
        }
    }
}
fn operation_id(input: &Input) -> Result<&str> {
    let operation = input
        .operation_id
        .as_deref()
        .ok_or("WALLET_RECEIPT_REQUIRED")?;
    if operation.is_empty()
        || operation.len() > 80
        || !operation
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("WALLET_RECEIPT_REQUIRED");
    }
    Ok(operation)
}
pub fn wipe_json(value: &mut Value) {
    match value {
        Value::String(text) => text.zeroize(),
        Value::Array(items) => items.iter_mut().for_each(wipe_json),
        Value::Object(map) => map.values_mut().for_each(wipe_json),
        _ => {}
    }
}
