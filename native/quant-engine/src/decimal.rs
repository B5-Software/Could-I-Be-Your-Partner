//! Exact 18-place quantities. No floating point or JSON numbers represent money.
use ethnum::U256;
use serde::{Deserialize, Serialize};

pub const SCALE: i128 = 1_000_000_000_000_000_000;
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Fixed(pub i128);
impl TryFrom<String> for Fixed {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.is_empty() || value.len() > 60 {
            return Err("AMOUNT_FORMAT");
        }
        let (negative, digits) = value
            .strip_prefix('-')
            .map_or((false, value.as_str()), |s| (true, s));
        let mut parts = digits.split('.');
        let whole = parts.next().ok_or("AMOUNT_FORMAT")?;
        let fraction = parts.next().unwrap_or("");
        if parts.next().is_some()
            || whole.is_empty()
            || fraction.len() > 18
            || !whole.bytes().all(|c| c.is_ascii_digit())
            || !fraction.bytes().all(|c| c.is_ascii_digit())
        {
            return Err("AMOUNT_FORMAT");
        }
        let integer = whole.parse::<u128>().map_err(|_| "AMOUNT_OVERFLOW")?;
        let sub = if fraction.is_empty() {
            0
        } else {
            fraction.parse::<u128>().map_err(|_| "AMOUNT_FORMAT")?
                * 10_u128.pow(18 - fraction.len() as u32)
        };
        let raw = integer
            .checked_mul(SCALE as u128)
            .and_then(|v| v.checked_add(sub))
            .ok_or("AMOUNT_OVERFLOW")?;
        if negative && raw == i128::MAX as u128 + 1 {
            return Ok(Self(i128::MIN));
        }
        let signed = i128::try_from(raw).map_err(|_| "AMOUNT_OVERFLOW")?;
        Ok(Self(if negative { -signed } else { signed }))
    }
}
impl From<Fixed> for String {
    fn from(value: Fixed) -> Self {
        let magnitude = value.0.unsigned_abs();
        let sign = if value.0 < 0 { "-" } else { "" };
        let whole = magnitude / SCALE as u128;
        let remainder = magnitude % SCALE as u128;
        if remainder == 0 {
            return format!("{sign}{whole}");
        }
        let sub = format!("{remainder:018}");
        format!("{sign}{whole}.{}", sub.trim_end_matches('0'))
    }
}
impl Fixed {
    pub fn positive(self) -> Result<Self, &'static str> {
        if self.0 > 0 {
            Ok(self)
        } else {
            Err("POSITIVE_AMOUNT_REQUIRED")
        }
    }
    pub fn checked_add(self, other: Self) -> Result<Self, &'static str> {
        self.0
            .checked_add(other.0)
            .map(Self)
            .ok_or("AMOUNT_OVERFLOW")
    }
    pub fn checked_sub(self, other: Self) -> Result<Self, &'static str> {
        self.0
            .checked_sub(other.0)
            .map(Self)
            .ok_or("AMOUNT_OVERFLOW")
    }
    pub fn multiply(self, other: Self, ceil: bool) -> Result<Self, &'static str> {
        if self.0 < 0 || other.0 < 0 {
            return Err("NEGATIVE_NOTIONAL");
        }
        let numerator = U256::from(self.0 as u128) * U256::from(other.0 as u128);
        let divisor = U256::from(SCALE as u128);
        let mut result = numerator / divisor;
        if ceil && numerator % divisor != U256::ZERO {
            result += U256::ONE;
        }
        let raw = u128::try_from(result).map_err(|_| "AMOUNT_OVERFLOW")?;
        Ok(Self(i128::try_from(raw).map_err(|_| "AMOUNT_OVERFLOW")?))
    }
    pub fn multiple_of(self, step: Self) -> bool {
        step.0 > 0 && self.0 >= 0 && self.0 % step.0 == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn n(value: &str) -> Fixed {
        Fixed::try_from(value.to_string()).unwrap()
    }
    #[test]
    fn precision_and_rejection() {
        assert_eq!(
            Fixed::try_from(String::from(Fixed(i128::MIN))).unwrap(),
            Fixed(i128::MIN)
        );
        assert_eq!(n("0.000000000000000001").0, 1);
        assert_eq!(
            String::from(n("12345678901234567890.123456789012345678")),
            "12345678901234567890.123456789012345678"
        );
        for text in ["1e5", "NaN", "+1", ".5", "1.0000000000000000001", "1.2.3"] {
            assert!(Fixed::try_from(text.to_string()).is_err(), "{text}");
        }
        assert!(serde_json::from_str::<Fixed>("1.25").is_err());
    }
    #[test]
    fn widened_products_and_rounding() {
        assert_eq!(
            n("12345678901234567890.123456789012345678")
                .multiply(n("0.1"), false)
                .unwrap(),
            n("1234567890123456789.012345678901234567")
        );
        assert_eq!(
            n("0.000000000000000001").multiply(n("0.1"), true).unwrap(),
            n("0.000000000000000001")
        );
        assert_eq!(
            n("0.000000000000000001").multiply(n("0.1"), false).unwrap(),
            Fixed(0)
        );
        assert!(
            n("12345678901234567890")
                .multiply(n("12345678901234567890"), false)
                .is_err()
        );
    }
}
