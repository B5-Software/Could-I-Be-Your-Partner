// SPDX-License-Identifier: GPL-3.0-or-later
//! Declared ABI effects, not an on-chain execution simulator. Tokens and router
//! implementations remain trusted dependencies; pre-existing allowances persist.
use crate::{
    Result,
    authority::{now, quantity},
    evm::Transaction,
};
use alloy_sol_types::{SolCall, sol};
use ethnum::U256;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
const UNKNOWN: &str = "WALLET_NATIVE_TOKEN_UNCLASSIFIED";
sol! {
    function transfer(address to,uint256 amount) external returns(bool);
    function approve(address spender,uint256 amount) external returns(bool);
    function transferFrom(address from,address to,uint256 amount) external returns(bool);
    struct ExactInputSingleParams {address tokenIn;address tokenOut;uint24 fee;address recipient;uint256 amountIn;uint256 amountOutMinimum;uint160 sqrtPriceLimitX96;}
    function exactInputSingle(ExactInputSingleParams params) external payable returns(uint256);
    function multicall(uint256 deadline,bytes[] data) external payable returns(bytes[]);
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    pub chain_id: u64,
    pub address: String,
    pub symbol: String,
    pub decimals: u8,
    pub max_amount_atoms: String,
    pub max_signed_atoms: String,
    pub max_approval_atoms: String,
    pub allow_approvals: bool,
    pub recipients: Vec<String>,
    pub spenders: Vec<String>,
}
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Used {
    pub transfer_atoms: String,
    pub approval_atoms: String,
    pub signatures: u64,
}
pub type Usage = BTreeMap<String, Used>;
pub fn key(chain: u64, address: &str) -> String {
    format!("eip155:{chain}/erc20:{}", address.to_ascii_lowercase())
}
fn address(text: &str) -> bool {
    text.len() == 42 && text.starts_with("0x") && text[2..].bytes().all(|b| b.is_ascii_hexdigit())
}
impl Rule {
    pub fn validate(&self) -> Result<()> {
        if ![8453, 84532].contains(&self.chain_id)
            || !address(&self.address)
            || self.symbol.chars().count() > 24
            || self.recipients.len() > 16
            || self.spenders.len() > 16
            || self
                .recipients
                .iter()
                .chain(&self.spenders)
                .any(|v| !address(v))
        {
            return Err("WALLET_NATIVE_AUTH_INVALID");
        }
        quantity(&self.max_amount_atoms)?;
        quantity(&self.max_signed_atoms)?;
        quantity(&self.max_approval_atoms)?;
        Ok(())
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Effect {
    pub chain_id: u64,
    pub token: String,
    pub kind: String,
    pub amount_atoms: String,
    pub recipient: String,
    pub spender: Option<String>,
    pub token_out: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    pub classified: bool,
    pub adapter: &'static str,
    pub effects: Vec<Effect>,
}
fn decode<C: SolCall>(data: &[u8]) -> Result<C> {
    let call = C::abi_decode_validate(data).map_err(|_| UNKNOWN)?;
    if call.abi_encode() != data {
        return Err(UNKNOWN);
    }
    Ok(call)
}
fn small_word(data: &[u8], offset: usize) -> Result<usize> {
    let word = data.get(offset..offset + 32).ok_or(UNKNOWN)?;
    if word[..28].iter().any(|b| *b != 0) {
        return Err(UNKNOWN);
    }
    Ok(u32::from_be_bytes(word[28..].try_into().map_err(|_| UNKNOWN)?) as usize)
}
fn router(chain: u64) -> Option<&'static str> {
    match chain {
        8453 => Some("0x2626664c2603336e57b271c5c0b26f421741e481"),
        84532 => Some("0x94cc0aac535ccdb3c01d6787d6413c739ae12bc4"),
        _ => None,
    }
}
fn swap(tx: &Transaction, sender: &str, data: &[u8]) -> Result<Effect> {
    let call = decode::<exactInputSingleCall>(data)?.params;
    let recipient = call.recipient.to_string().to_ascii_lowercase();
    // Reject balance sentinels, implicit recipients and router-held balances.
    if !recipient.eq_ignore_ascii_case(sender)
        || call.amountIn.is_zero()
        || call.amountOutMinimum.is_zero()
        || call.tokenIn == call.tokenOut
        || call.fee.to::<u32>() == 0
        || call.fee.to::<u32>() >= 1000000
    {
        return Err(UNKNOWN);
    }
    Ok(Effect {
        chain_id: tx.chain_id,
        token: call.tokenIn.to_string().to_ascii_lowercase(),
        kind: "swap-input".into(),
        amount_atoms: call.amountIn.to_string(),
        recipient,
        spender: Some(tx.to.to_ascii_lowercase()),
        token_out: Some(call.tokenOut.to_string().to_ascii_lowercase()),
    })
}
fn inspect(tx: &Transaction, sender: &str, data: &[u8]) -> Result<Analysis> {
    if data.is_empty() {
        return Ok(Analysis {
            // Empty calldata can invoke an arbitrary contract fallback. With
            // strict token rules, no RPC/code proof is available to whitelist it.
            classified: false,
            adapter: "empty-calldata",
            effects: vec![],
        });
    }
    if quantity(&tx.value)? != U256::ZERO {
        return Err(UNKNOWN);
    }
    let selector = data.get(..4).ok_or(UNKNOWN)?;
    let basic = |kind: &str, amount: String, recipient: String, spender: Option<String>| Analysis {
        classified: true,
        adapter: "erc20",
        effects: vec![Effect {
            chain_id: tx.chain_id,
            token: tx.to.to_ascii_lowercase(),
            kind: kind.into(),
            amount_atoms: amount,
            recipient,
            spender,
            token_out: None,
        }],
    };
    if selector == transferCall::SELECTOR {
        let call = decode::<transferCall>(data)?;
        return Ok(basic(
            "transfer",
            call.amount.to_string(),
            call.to.to_string().to_ascii_lowercase(),
            None,
        ));
    }
    if selector == approveCall::SELECTOR {
        let call = decode::<approveCall>(data)?;
        return Ok(basic(
            "approval",
            call.amount.to_string(),
            sender.into(),
            Some(call.spender.to_string().to_ascii_lowercase()),
        ));
    }
    if selector == transferFromCall::SELECTOR {
        let call = decode::<transferFromCall>(data)?;
        if !call.from.to_string().eq_ignore_ascii_case(sender) {
            return Err(UNKNOWN);
        }
        return Ok(basic(
            "transfer",
            call.amount.to_string(),
            call.to.to_string().to_ascii_lowercase(),
            Some(sender.into()),
        ));
    }
    if !router(tx.chain_id).is_some_and(|r| r.eq_ignore_ascii_case(&tx.to)) {
        return Err(UNKNOWN);
    }
    if selector == exactInputSingleCall::SELECTOR {
        return Ok(Analysis {
            classified: true,
            adapter: "uniswap-v3-router02",
            effects: vec![swap(tx, sender, data)?],
        });
    }
    if selector != multicallCall::SELECTOR || small_word(data, 36)? != 64 {
        return Err(UNKNOWN);
    }
    let count = small_word(data, 68)?;
    if count == 0 || count > 16 {
        return Err(UNKNOWN);
    }
    // Bound allocation and canonical offsets before invoking the ABI decoder.
    let mut cursor = count * 32;
    for index in 0..count {
        let offset = small_word(data, 100 + index * 32)?;
        if offset != cursor {
            return Err(UNKNOWN);
        }
        let length = small_word(data, 100 + offset)?;
        if length > 16384 {
            return Err(UNKNOWN);
        }
        cursor = cursor
            .checked_add(32 + length.div_ceil(32) * 32)
            .ok_or(UNKNOWN)?;
        if 100 + cursor > data.len() {
            return Err(UNKNOWN);
        }
    }
    if 100 + cursor != data.len() {
        return Err(UNKNOWN);
    }
    let call = decode::<multicallCall>(data)?;
    if U256::from_be_bytes(call.deadline.to_be_bytes::<32>()) <= U256::from(now()? / 1000) {
        return Err(UNKNOWN);
    }
    let effects = call
        .data
        .iter()
        .map(|data| swap(tx, sender, data))
        .collect::<Result<Vec<_>>>()?;
    Ok(Analysis {
        classified: true,
        adapter: "uniswap-v3-router02-batch",
        effects,
    })
}
pub fn analyze(tx: &Transaction, sender: &str) -> Analysis {
    let result = tx
        .data
        .strip_prefix("0x")
        .and_then(|v| hex::decode(v).ok())
        .filter(|bytes| bytes.len() <= 16384)
        .ok_or(UNKNOWN)
        .and_then(|bytes| inspect(tx, sender, &bytes));
    result.unwrap_or_else(|_| Analysis {
        classified: false,
        adapter: "unclassified",
        effects: vec![],
    })
}
fn cap(value: U256, limit: &str) -> Result<()> {
    let limit = quantity(limit)?;
    if limit != U256::ZERO && value > limit {
        return Err("WALLET_NATIVE_TOKEN_LIMIT");
    }
    Ok(())
}
pub fn consume(rules: &[Rule], usage: &mut Usage, analysis: &Analysis, replay: bool) -> Result<()> {
    if rules.is_empty() {
        return Ok(());
    }
    if !analysis.classified {
        return Err(UNKNOWN);
    }
    let mut amounts: BTreeMap<String, (U256, U256)> = BTreeMap::new();
    for effect in &analysis.effects {
        let rule = rules
            .iter()
            .find(|r| {
                r.chain_id == effect.chain_id && r.address.eq_ignore_ascii_case(&effect.token)
            })
            .ok_or("WALLET_NATIVE_TOKEN_SCOPE")?;
        if effect.token_out.as_ref().is_some_and(|out| {
            !rules
                .iter()
                .any(|r| r.chain_id == effect.chain_id && r.address.eq_ignore_ascii_case(out))
        }) {
            return Err("WALLET_NATIVE_TOKEN_SCOPE");
        }
        let amount = quantity(&effect.amount_atoms)?;
        if effect.kind == "approval" {
            if amount != U256::ZERO && !rule.allow_approvals {
                return Err("WALLET_NATIVE_TOKEN_APPROVAL");
            }
            cap(amount, &rule.max_approval_atoms)?;
        } else if !rule.recipients.is_empty()
            && !rule
                .recipients
                .iter()
                .any(|v| v.eq_ignore_ascii_case(&effect.recipient))
        {
            return Err("WALLET_NATIVE_TOKEN_RECIPIENT");
        }
        if amount != U256::ZERO
            && effect.spender.as_ref().is_some_and(|spender| {
                !rule.spenders.is_empty()
                    && !rule
                        .spenders
                        .iter()
                        .any(|v| v.eq_ignore_ascii_case(spender))
            })
        {
            return Err("WALLET_NATIVE_TOKEN_SPENDER");
        }
        let entry = amounts
            .entry(key(rule.chain_id, &rule.address))
            .or_default();
        let target = if effect.kind == "approval" {
            &mut entry.1
        } else {
            &mut entry.0
        };
        *target = target
            .checked_add(amount)
            .ok_or("WALLET_NATIVE_TOKEN_LIMIT")?;
    }
    for (asset, (transfer, approval)) in amounts {
        let rule = rules
            .iter()
            .find(|r| key(r.chain_id, &r.address) == asset)
            .ok_or("WALLET_NATIVE_TOKEN_SCOPE")?;
        let signed = transfer
            .checked_add(approval)
            .ok_or("WALLET_NATIVE_TOKEN_LIMIT")?;
        cap(signed, &rule.max_amount_atoms)?;
        let previous = usage.get(&asset);
        let used_transfer = previous
            .map(|v| quantity(&v.transfer_atoms))
            .transpose()?
            .unwrap_or(U256::ZERO);
        let used_approval = previous
            .map(|v| quantity(&v.approval_atoms))
            .transpose()?
            .unwrap_or(U256::ZERO);
        if !replay {
            cap(
                used_transfer
                    .checked_add(used_approval)
                    .and_then(|v| v.checked_add(signed))
                    .ok_or("WALLET_NATIVE_TOKEN_LIMIT")?,
                &rule.max_signed_atoms,
            )?;
            usage.insert(
                asset,
                Used {
                    transfer_atoms: used_transfer
                        .checked_add(transfer)
                        .ok_or("WALLET_NATIVE_TOKEN_LIMIT")?
                        .to_string(),
                    approval_atoms: used_approval
                        .checked_add(approval)
                        .ok_or("WALLET_NATIVE_TOKEN_LIMIT")?
                        .to_string(),
                    signatures: previous
                        .map_or(0, |v| v.signatures)
                        .checked_add(1)
                        .ok_or("WALLET_NATIVE_TOKEN_LIMIT")?,
                },
            );
        }
    }
    Ok(())
}
