//! A conservative host-time projection; retain the exchange timestamp as evidence.
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SourceClock {
    pub offset_ns: String,
    pub uncertainty_ns: String,
    pub calibrated_at_ns: String,
}
fn unsigned(value: &str) -> Result<u128, &'static str> {
    if value.is_empty() || value.len() > 39 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err("SOURCE_CLOCK_INVALID");
    }
    value.parse().map_err(|_| "SOURCE_CLOCK_INVALID")
}
pub fn validate(
    normalized: u128,
    provider: Option<&str>,
    clock: Option<&SourceClock>,
    now: u128,
) -> Result<(), &'static str> {
    let (Some(provider), Some(clock)) = (provider, clock) else {
        return if provider.is_none() && clock.is_none() {
            Ok(())
        } else {
            Err("SOURCE_CLOCK_INVALID")
        };
    };
    let digits = clock
        .offset_ns
        .strip_prefix('-')
        .unwrap_or(&clock.offset_ns);
    let magnitude = unsigned(digits)?;
    if magnitude > 60_000_000_000 || unsigned(&clock.uncertainty_ns)? > 2_000_000_000 {
        return Err("SOURCE_CLOCK_INVALID");
    }
    let offset = clock
        .offset_ns
        .parse::<i128>()
        .map_err(|_| "SOURCE_CLOCK_INVALID")?;
    let provider = i128::try_from(unsigned(provider)?).map_err(|_| "SOURCE_CLOCK_INVALID")?;
    let expected = provider.checked_sub(offset).ok_or("SOURCE_CLOCK_INVALID")?;
    let calibrated = unsigned(&clock.calibrated_at_ns)?;
    if u128::try_from(expected).ok() != Some(normalized)
        || calibrated > now.saturating_add(250_000_000)
        || now.saturating_sub(calibrated) > 120_000_000_000
    {
        return Err("SOURCE_CLOCK_INVALID");
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn projection_is_verified_and_expired_mapping_is_rejected() {
        let now = 1_000_000_000_000_000_000u128;
        let clock = SourceClock {
            offset_ns: "-1500000000".into(),
            uncertainty_ns: "50000000".into(),
            calibrated_at_ns: now.to_string(),
        };
        let provider = (now - 1_500_000_000).to_string();
        assert!(validate(now, Some(&provider), Some(&clock), now).is_ok());
        assert_eq!(
            validate(now + 1, Some(&provider), Some(&clock), now),
            Err("SOURCE_CLOCK_INVALID")
        );
        assert_eq!(
            validate(now, Some(&provider), Some(&clock), now + 121_000_000_000),
            Err("SOURCE_CLOCK_INVALID")
        );
        assert_eq!(
            validate(now, Some(&provider), None, now),
            Err("SOURCE_CLOCK_INVALID")
        );
    }
}
