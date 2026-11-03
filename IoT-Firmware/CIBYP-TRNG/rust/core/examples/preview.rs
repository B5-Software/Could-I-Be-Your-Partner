// SPDX-License-Identifier: GPL-3.0-or-later
// Host-only UI fixture. Deterministic bytes, never real hardware or wallet entropy.
use cibyp_trng_core::{Device, Hardware, OUTPUT};
use std::io::{self, BufRead};
struct Fixture {
    counter: u8,
    setup: bool,
}
impl Hardware for Fixture {
    fn random(&mut self, out: &mut [u8]) -> bool {
        for (i, v) in out.iter_mut().enumerate() {
            *v = self.counter.wrapping_add(i as u8);
        }
        if out.len() > 4 {
            out[4] = if self.counter % 2 == 0 { 240 } else { 32 };
        }
        self.counter = self.counter.wrapping_add(1);
        true
    }
    fn device_id(&self) -> [u8; 6] {
        [0xc1, 0xb1, 0x23, 0x45, 0x67, 0x89]
    }
    fn security_flags(&self) -> u32 {
        0
    }
    fn physical_presence(&mut self) -> bool {
        false
    }
    fn load_pair_key(&mut self, _: &mut [u8; 32]) -> bool {
        false
    }
    fn store_pair_key(&mut self, _: &[u8; 32]) -> bool {
        false
    }
    fn configure_network(&mut self, _: &[u8], _: &[u8]) -> bool {
        true
    }
    fn network_setup_required(&self) -> bool {
        self.setup
    }
}
fn main() {
    let mut device = Device::new();
    let mut hw = Fixture {
        counter: 0,
        setup: std::env::args().any(|s| s == "--setup"),
    };
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let (command, admin) = line
            .strip_prefix("ADMIN ")
            .map_or((line.as_str(), false), |s| (s, true));
        let mut output = [0; OUTPUT];
        let n = device.dispatch_network(command.as_bytes(), &mut hw, &mut output, admin);
        println!("{}", std::str::from_utf8(&output[..n]).unwrap());
    }
}
