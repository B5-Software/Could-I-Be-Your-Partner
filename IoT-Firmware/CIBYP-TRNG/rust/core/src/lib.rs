// SPDX-License-Identifier: GPL-3.0-or-later
#![no_std]
#![forbid(unsafe_code)]
use core::fmt::{self, Write};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use zeroize::{Zeroize, Zeroizing};

pub const MAX_FRAME: usize = 384;
pub const OUTPUT: usize = 8192;
pub const HARDENED: u32 = 31;
mod catalog;
type Hmac256 = Hmac<Sha256>;

/// RFC 5869 Extract: question digest is a salt, never an entropy replacement.
pub fn question_seed(entropy: &[u8; 64], question_digest: &[u8; 32]) -> [u8; 32] {
    let mut mac = Hmac256::new_from_slice(question_digest).expect("fixed-size HMAC key");
    mac.update(entropy);
    mac.finalize().into_bytes().into()
}
/// Two-block HKDF Expand; independent info per candidate keeps every expansion
/// within RFC 5869's 255-block limit, even during bounded rejection sampling.
pub fn question_block(seed: &[u8; 32], spread: &[u8], counter: u64) -> [u8; 64] {
    let mut first = Hmac256::new_from_slice(seed).expect("fixed-size HMAC key");
    first.update(b"CIBYP-TAROT/2/question\n");
    first.update(spread);
    first.update(b"\n");
    first.update(&counter.to_be_bytes());
    first.update(&[1]);
    let first = first.finalize().into_bytes();
    let mut second = Hmac256::new_from_slice(seed).expect("fixed-size HMAC key");
    second.update(&first);
    second.update(b"CIBYP-TAROT/2/question\n");
    second.update(spread);
    second.update(b"\n");
    second.update(&counter.to_be_bytes());
    second.update(&[2]);
    let second = second.finalize().into_bytes();
    let mut output = [0; 64];
    output[..32].copy_from_slice(&first);
    output[32..].copy_from_slice(&second);
    output
}

// The IDF boundary owns hardware. This core has no allocator, network,
// arbitrary flash writes, eFuse writes, wallet keys or signing operations.
pub trait Hardware {
    fn random(&mut self, output: &mut [u8]) -> bool;
    fn device_id(&self) -> [u8; 6];
    fn security_flags(&self) -> u32;
    fn physical_presence(&mut self) -> bool;
    fn load_pair_key(&mut self, key: &mut [u8; 32]) -> bool;
    fn store_pair_key(&mut self, key: &[u8; 32]) -> bool;
    fn configure_network(&mut self, _ssid: &[u8], _password: &[u8]) -> bool {
        false
    }
    fn network_setup_required(&self) -> bool {
        false
    }
}

pub struct Response<'a> {
    bytes: &'a mut [u8],
    length: usize,
}
impl Write for Response<'_> {
    fn write_str(&mut self, value: &str) -> fmt::Result {
        let end = self.length.checked_add(value.len()).ok_or(fmt::Error)?;
        let out = self.bytes.get_mut(self.length..end).ok_or(fmt::Error)?;
        out.copy_from_slice(value.as_bytes());
        self.length = end;
        Ok(())
    }
}
fn hex(out: &mut impl Write, data: &[u8]) -> fmt::Result {
    for byte in data {
        write!(out, "{byte:02x}")?;
    }
    Ok(())
}
pub fn decode<const N: usize>(text: &[u8]) -> Option<[u8; N]> {
    if text.len() != N.checked_mul(2)? {
        return None;
    }
    let mut result = [0; N];
    fn nibble(c: u8) -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            _ => None,
        }
    }
    for (out, pair) in result.iter_mut().zip(text.chunks_exact(2)) {
        *out = nibble(pair[0])?.checked_mul(16)? + nibble(pair[1])?;
    }
    Some(result)
}
fn mac_hex(mac: &mut Hmac256, value: &[u8]) {
    const H: &[u8] = b"0123456789abcdef";
    for b in value {
        mac.update(&[H[usize::from(b >> 4)], H[usize::from(b & 15)]]);
    }
}
pub fn request_mac(key: &[u8; 32], device: &[u8; 6], nonce: &[u8; 32]) -> [u8; 32] {
    let mut mac = Hmac256::new_from_slice(key).expect("fixed-size HMAC key");
    mac.update(b"CIBYP-TRNG/2/request\n");
    mac_hex(&mut mac, device);
    mac.update(b"\n");
    mac_hex(&mut mac, nonce);
    mac.finalize().into_bytes().into()
}
pub fn response_mac(
    key: &[u8; 32],
    device: &[u8; 6],
    nonce: &[u8; 32],
    entropy: &[u8; 64],
    flags: u32,
) -> [u8; 32] {
    let mut mac = Hmac256::new_from_slice(key).expect("fixed-size HMAC key");
    mac.update(b"CIBYP-TRNG/2/response\n");
    mac_hex(&mut mac, device);
    mac.update(b"\n");
    mac_hex(&mut mac, nonce);
    mac.update(b"\n");
    mac_hex(&mut mac, entropy);
    mac.update(b"\n");
    mac.update(&flags.to_be_bytes());
    mac.finalize().into_bytes().into()
}
fn healthy(bytes: &[u8]) -> bool {
    bytes.len() >= 32 && bytes.iter().any(|b| *b != bytes[0])
}
pub struct Device {
    last_entropy: [u8; 64],
    last_nonce: [u8; 32],
    has_entropy: bool,
    has_nonce: bool,
}
impl Default for Device {
    fn default() -> Self {
        Self::new()
    }
}
impl Device {
    pub const fn new() -> Self {
        Self {
            last_entropy: [0; 64],
            last_nonce: [0; 32],
            has_entropy: false,
            has_nonce: false,
        }
    }
    pub fn dispatch(&mut self, input: &[u8], hw: &mut impl Hardware, output: &mut [u8]) -> usize {
        let mut out = Response {
            bytes: output,
            length: 0,
        };
        let result = if input.len() > MAX_FRAME {
            Err("FRAME_TOO_LARGE")
        } else {
            self.command(input, hw, &mut out)
        };
        if let Err(error) = result {
            out.length = 0;
            let _ = write!(out, "{{\"error\":\"{error}\"}}");
        }
        out.length
    }
    /// Network callers can never reach wallet pairing, challenge entropy, or
    /// USB credential discovery. Administrator permission applies to NETCFG only.
    pub fn dispatch_network(
        &mut self,
        input: &[u8],
        hw: &mut impl Hardware,
        output: &mut [u8],
        admin: bool,
    ) -> usize {
        if hw.network_setup_required()
            && !matches!(input, b"PING" | b"INFO")
            && !(admin && input.starts_with(b"NETCFG "))
        {
            let message = b"{\"error\":\"SETUP_REQUIRED\"}";
            if let Some(target) = output.get_mut(..message.len()) {
                target.copy_from_slice(message);
                return message.len();
            }
            return 0;
        }
        let allowed = matches!(input, b"PING" | b"INFO" | b"DRAW" | b"RANDOM")
            || input.starts_with(b"SPREAD:")
            || input.starts_with(b"SPREAD2 ")
            || input.starts_with(b"DRAW2 ")
            || (admin && input.starts_with(b"NETCFG "));
        if allowed {
            return self.dispatch(input, hw, output);
        }
        let message = b"{\"error\":\"NETWORK_COMMAND_FORBIDDEN\"}";
        if let Some(target) = output.get_mut(..message.len()) {
            target.copy_from_slice(message);
            message.len()
        } else {
            0
        }
    }
    fn sample(&mut self, hw: &mut impl Hardware) -> Result<[u8; 64], &'static str> {
        let mut result = [0; 64];
        if !hw.random(&mut result)
            || !healthy(&result)
            || (self.has_entropy && result == self.last_entropy)
        {
            result.zeroize();
            return Err("ENTROPY_UNAVAILABLE");
        }
        self.last_entropy = result;
        self.has_entropy = true;
        Ok(result)
    }
    fn command(
        &mut self,
        input: &[u8],
        hw: &mut impl Hardware,
        out: &mut Response<'_>,
    ) -> Result<(), &'static str> {
        let print_error = |_| "RESPONSE_LIMIT";
        if input == b"PING" {
            out.write_str("{\"pong\":true,\"protocol\":2}")
                .map_err(print_error)?;
        } else if input == b"INFO" {
            out.write_str("{\"device\":\"ESP32\",\"protocol\":2,\"firmware\":\"2.0.0\",\"transport\":\"usb+http+websocket\",\"deviceId\":\"").map_err(print_error)?;
            hex(out, &hw.device_id()).map_err(print_error)?;
            write!(
                out,
                "\",\"securityFlags\":{},\"setupRequired\":{},\"physicalConfirmation\":\"hold-board-button\"}}",
                hw.security_flags(), hw.network_setup_required()
            )
            .map_err(print_error)?;
        } else if let Some(config) = input.strip_prefix(b"NETCFG ") {
            let split = config
                .iter()
                .position(|v| *v == b' ')
                .ok_or("NETWORK_CONFIG_FORMAT")?;
            let mut ssid = [0; 32];
            let mut password = [0; 63];
            let name =
                decode_variable(&config[..split], &mut ssid).ok_or("NETWORK_CONFIG_FORMAT")?;
            let pass = decode_variable(&config[split + 1..], &mut password)
                .ok_or("NETWORK_CONFIG_FORMAT")?;
            let valid_name = core::str::from_utf8(&ssid[..name]).is_ok()
                && name > 0
                && !ssid[..name].iter().any(|v| *v < 32 || *v == 127);
            let valid_pass = pass >= 8 && password[..pass].iter().all(|v| (32..=126).contains(v));
            let saved =
                valid_name && valid_pass && hw.configure_network(&ssid[..name], &password[..pass]);
            ssid.zeroize();
            password.zeroize();
            if !saved {
                return Err("NETWORK_CONFIG_REJECTED");
            }
            out.write_str("{\"ok\":true,\"restartRequired\":true}")
                .map_err(print_error)?;
        } else if let Some(secret) = input.strip_prefix(b"PAIR2 ") {
            if hw.security_flags() != HARDENED {
                return Err("DEVICE_NOT_HARDENED");
            }
            if !hw.physical_presence() {
                return Err("PHYSICAL_CONFIRMATION_REQUIRED");
            }
            let mut key = decode::<32>(secret).ok_or("PAIR_FORMAT")?;
            let saved = hw.store_pair_key(&key);
            key.zeroize();
            if !saved {
                return Err("PAIR_STORAGE_FAILED");
            }
            out.write_str("{\"paired\":true,\"protocol\":2}")
                .map_err(print_error)?;
        } else if let Some(args) = input.strip_prefix(b"ENTROPY2 ") {
            if hw.security_flags() != HARDENED {
                return Err("DEVICE_NOT_HARDENED");
            }
            let split = args
                .iter()
                .position(|v| *v == b' ')
                .ok_or("ENTROPY_FORMAT")?;
            let nonce = decode::<32>(&args[..split]).ok_or("ENTROPY_FORMAT")?;
            let proof = decode::<32>(&args[split + 1..]).ok_or("ENTROPY_FORMAT")?;
            if self.has_nonce && nonce == self.last_nonce {
                return Err("REPLAYED_CHALLENGE");
            }
            let mut key = [0; 32];
            if !hw.load_pair_key(&mut key) {
                key.zeroize();
                return Err("DEVICE_NOT_PAIRED");
            }
            let device = hw.device_id();
            // HMAC verification uses the library's constant-time comparison.
            let mut verifier = Hmac256::new_from_slice(&key).map_err(|_| "PAIR_FORMAT")?;
            verifier.update(b"CIBYP-TRNG/2/request\n");
            mac_hex(&mut verifier, &device);
            verifier.update(b"\n");
            mac_hex(&mut verifier, &nonce);
            if verifier.verify_slice(&proof).is_err() {
                key.zeroize();
                return Err("DEVICE_AUTHENTICATION_FAILED");
            }
            self.last_nonce = nonce;
            self.has_nonce = true;
            let mut entropy = match self.sample(hw) {
                Ok(value) => value,
                Err(error) => {
                    key.zeroize();
                    return Err(error);
                }
            };
            let flags = hw.security_flags();
            let tag = response_mac(&key, &device, &nonce, &entropy, flags);
            key.zeroize();
            out.write_str("{\"protocol\":2,\"deviceId\":\"")
                .map_err(print_error)?;
            hex(out, &device).map_err(print_error)?;
            out.write_str("\",\"nonce\":\"").map_err(print_error)?;
            hex(out, &nonce).map_err(print_error)?;
            out.write_str("\",\"entropy\":\"").map_err(print_error)?;
            hex(out, &entropy).map_err(print_error)?;
            entropy.zeroize();
            write!(out, "\",\"securityFlags\":{flags},\"mac\":\"").map_err(print_error)?;
            hex(out, &tag).map_err(print_error)?;
            out.write_str("\"}").map_err(print_error)?;
        } else if input == b"RANDOM" {
            let mut entropy = self.sample(hw)?;
            let value =
                u32::from_be_bytes(entropy[..4].try_into().map_err(|_| "ENTROPY_UNAVAILABLE")?);
            entropy.zeroize();
            write!(out, "{{\"value\":{value},\"entropySource\":\"TRNG\"}}").map_err(print_error)?;
        } else if input == b"DRAW"
            || input.starts_with(b"SPREAD:")
            || input.starts_with(b"SPREAD2 ")
            || input.starts_with(b"DRAW2 ")
        {
            let single = input == b"DRAW" || input.starts_with(b"DRAW2 ");
            let (kind, question): (&[u8], Option<[u8; 32]>) =
                if let Some(args) = input.strip_prefix(b"SPREAD2 ") {
                    let split = args
                        .iter()
                        .position(|v| *v == b' ')
                        .ok_or("QUESTION_FORMAT")?;
                    (
                        &args[..split],
                        Some(decode::<32>(&args[split + 1..]).ok_or("QUESTION_FORMAT")?),
                    )
                } else if let Some(digest) = input.strip_prefix(b"DRAW2 ") {
                    (
                        b"single",
                        Some(decode::<32>(digest).ok_or("QUESTION_FORMAT")?),
                    )
                } else {
                    (input.strip_prefix(b"SPREAD:").unwrap_or(b"single"), None)
                };
            let count = match kind {
                b"single" | b"yes_no" => 1,
                b"three" | b"three-card" | b"choice" | b"body-mind-spirit" => 3,
                b"celtic" | b"celtic-cross" => 10,
                b"horseshoe" | b"hexagram" => 7,
                b"star" | b"relationship" => 5,
                b"zodiac" => 12,
                _ => return Err("UNKNOWN_SPREAD"),
            };
            let seed = if let Some(digest) = question {
                let mut raw = self.sample(hw)?;
                let key = question_seed(&raw, &digest);
                raw.zeroize();
                Some(Zeroizing::new(key))
            } else {
                None
            };
            let mut counter = 0u64;
            let mixed = seed.is_some();
            let mut used = [false; 78];
            if !single {
                out.write_str("{\"cards\":[").map_err(print_error)?;
            }
            for n in 0..count {
                let mut drawn = None;
                for _ in 0..128 {
                    let mut bytes = if let Some(key) = seed.as_ref() {
                        let block = question_block(key, kind, counter);
                        counter += 1;
                        block
                    } else {
                        self.sample(hw)?
                    };
                    let number = u32::from_be_bytes(
                        bytes[..4].try_into().map_err(|_| "ENTROPY_UNAVAILABLE")?,
                    );
                    let reversed = bytes[4] < 128;
                    bytes.zeroize();
                    if number >= u32::MAX - (u32::MAX % 78) {
                        continue;
                    }
                    let index = (number % 78) as usize;
                    if !used[index] {
                        used[index] = true;
                        drawn = Some((index, reversed));
                        break;
                    }
                }
                let (index, reversed) = drawn.ok_or("ENTROPY_UNAVAILABLE")?;
                if n > 0 {
                    out.write_char(',').map_err(print_error)?;
                }
                out.write_str(catalog::CARDS[index]).map_err(print_error)?;
                write!(out, ",\"cardIndex\":{index},\"isReversed\":{reversed},\"orientation\":\"{}\",\"entropySource\":\"TRNG\",\"questionMixed\":{mixed}}}", if reversed { "reversed" } else { "upright" }).map_err(print_error)?;
            }
            if !single {
                write!(
                    out,
                    "],\"entropySource\":\"TRNG\",\"questionMixed\":{mixed},\"device\":\"ESP32\"}}"
                )
                .map_err(print_error)?;
            }
        } else {
            return Err("UNKNOWN_COMMAND");
        }
        Ok(())
    }
}

fn decode_variable(text: &[u8], output: &mut [u8]) -> Option<usize> {
    if text.len() % 2 != 0 || text.len() / 2 > output.len() {
        return None;
    }
    for (out, pair) in output.iter_mut().zip(text.chunks_exact(2)) {
        *out = decode::<1>(pair)?[0];
    }
    Some(text.len() / 2)
}
