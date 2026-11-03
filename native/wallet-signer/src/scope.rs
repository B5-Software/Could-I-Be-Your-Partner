// SPDX-License-Identifier: GPL-3.0-or-later
//! Outer transaction budgets plus independently decoded declared token effects.
use crate::{Result, authority::quantity, evm::Transaction};
use ethnum::U256;
use serde::{Deserialize, Serialize};
fn zero() -> String {
    "0".into()
}
fn yes() -> bool {
    true
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rules {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub period: Option<crate::periods::Policy>,
    #[serde(default = "zero")]
    pub max_value_wei: String,
    #[serde(default = "zero")]
    pub max_total_value_wei: String,
    #[serde(default = "zero")]
    pub max_total_fee_wei: String,
    #[serde(default)]
    pub max_transactions: u64,
    #[serde(default)]
    pub targets: Vec<String>,
    #[serde(default)]
    pub selectors: Vec<String>,
    #[serde(default = "yes")]
    pub allow_calldata: bool,
    #[serde(default)]
    pub allow_replacement: bool,
    #[serde(default)]
    pub tokens: Vec<crate::tokens::Rule>,
}
impl Default for Rules {
    fn default() -> Self {
        Self {
            period: None,
            max_value_wei: zero(),
            max_total_value_wei: zero(),
            max_total_fee_wei: zero(),
            max_transactions: 0,
            targets: vec![],
            selectors: vec![],
            allow_calldata: true,
            allow_replacement: false,
            tokens: vec![],
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Usage {
    pub value_wei: String,
    pub fee_wei: String,
    pub transactions: u64,
    #[serde(default)]
    pub tokens: crate::tokens::Usage,
}
impl Default for Usage {
    fn default() -> Self {
        Self {
            value_wei: zero(),
            fee_wei: zero(),
            transactions: 0,
            tokens: Default::default(),
        }
    }
}
fn bounded(value: U256, limit: &str) -> Result<()> {
    let limit = quantity(limit)?;
    if limit != U256::ZERO && value > limit {
        return Err("WALLET_NATIVE_SCOPE_LIMIT");
    }
    Ok(())
}
impl Rules {
    pub fn subset_of(&self, parent: &Self) -> Result<()> {
        if let Some(parent) = &parent.period {
            self.period
                .as_ref()
                .ok_or("WALLET_AGENT_SCOPE_WIDENING")?
                .subset_of(parent)?;
        }
        let denied = "WALLET_AGENT_SCOPE_WIDENING";
        let amount = |child: &str, limit: &str| -> Result<()> {
            let c = quantity(child)?;
            let p = quantity(limit)?;
            if p != U256::ZERO && (c == U256::ZERO || c > p) {
                return Err(denied);
            }
            Ok(())
        };
        let list = |child: &[String], limit: &[String]| -> Result<()> {
            if !limit.is_empty()
                && (child.is_empty()
                    || child
                        .iter()
                        .any(|c| !limit.iter().any(|p| p.eq_ignore_ascii_case(c))))
            {
                return Err(denied);
            }
            Ok(())
        };
        amount(&self.max_value_wei, &parent.max_value_wei)?;
        amount(&self.max_total_value_wei, &parent.max_total_value_wei)?;
        amount(&self.max_total_fee_wei, &parent.max_total_fee_wei)?;
        if (parent.max_transactions != 0
            && (self.max_transactions == 0 || self.max_transactions > parent.max_transactions))
            || (!parent.allow_calldata && self.allow_calldata)
            || (!parent.allow_replacement && self.allow_replacement)
        {
            return Err(denied);
        }
        list(&self.targets, &parent.targets)?;
        list(&self.selectors, &parent.selectors)?;
        if !parent.tokens.is_empty() {
            if self.tokens.is_empty() {
                return Err(denied);
            }
            for child in &self.tokens {
                let p = parent
                    .tokens
                    .iter()
                    .find(|p| {
                        p.chain_id == child.chain_id
                            && p.address.eq_ignore_ascii_case(&child.address)
                    })
                    .ok_or(denied)?;
                if child.decimals != p.decimals
                    || child.symbol != p.symbol
                    || (!p.allow_approvals && child.allow_approvals)
                {
                    return Err(denied);
                }
                amount(&child.max_amount_atoms, &p.max_amount_atoms)?;
                amount(&child.max_signed_atoms, &p.max_signed_atoms)?;
                amount(&child.max_approval_atoms, &p.max_approval_atoms)?;
                list(&child.recipients, &p.recipients)?;
                list(&child.spenders, &p.spenders)?;
            }
        }
        Ok(())
    }
    pub fn validate(&self) -> Result<()> {
        if let Some(period) = &self.period {
            period.validate()?;
        }
        for value in [
            &self.max_value_wei,
            &self.max_total_value_wei,
            &self.max_total_fee_wei,
        ] {
            quantity(value)?;
        }
        if self.max_transactions > 1000000
            || self.tokens.len() > 16
            || self.targets.len() > 64
            || self.selectors.len() > 64
            || self.targets.iter().any(|v| {
                v.len() != 42
                    || !v.starts_with("0x")
                    || !v[2..].bytes().all(|b| b.is_ascii_hexdigit())
            })
            || self.selectors.iter().any(|v| {
                v.len() != 10
                    || !v.starts_with("0x")
                    || !v[2..].bytes().all(|b| b.is_ascii_hexdigit())
            })
        {
            return Err("WALLET_NATIVE_AUTH_INVALID");
        }
        let mut assets = std::collections::BTreeSet::new();
        for token in &self.tokens {
            token.validate()?;
            if !assets.insert(crate::tokens::key(token.chain_id, &token.address)) {
                return Err("WALLET_NATIVE_AUTH_INVALID");
            }
        }
        Ok(())
    }
    pub fn check(&self, tx: &Transaction, fee: U256, usage: &Usage, replay: bool) -> Result<()> {
        if !self.targets.is_empty() && !self.targets.iter().any(|v| v.eq_ignore_ascii_case(&tx.to))
        {
            return Err("WALLET_NATIVE_TARGET_LIMIT");
        }
        let permitted_selector = tx.data.get(..10).is_some_and(|selector| {
            self.selectors
                .iter()
                .any(|v| v.eq_ignore_ascii_case(selector))
        });
        if tx.data != "0x"
            && (!self.allow_calldata || (!self.selectors.is_empty() && !permitted_selector))
        {
            return Err("WALLET_NATIVE_CALLDATA_LIMIT");
        }
        bounded(quantity(&tx.value)?, &self.max_value_wei)?;
        if !replay {
            bounded(
                quantity(&usage.value_wei)?
                    .checked_add(quantity(&tx.value)?)
                    .ok_or("WALLET_NATIVE_SCOPE_LIMIT")?,
                &self.max_total_value_wei,
            )?;
            bounded(
                quantity(&usage.fee_wei)?
                    .checked_add(fee)
                    .ok_or("WALLET_NATIVE_SCOPE_LIMIT")?,
                &self.max_total_fee_wei,
            )?;
            if self.max_transactions != 0 && usage.transactions >= self.max_transactions {
                return Err("WALLET_NATIVE_SCOPE_LIMIT");
            }
        }
        Ok(())
    }
}
