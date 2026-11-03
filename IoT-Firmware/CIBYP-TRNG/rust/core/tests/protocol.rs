// SPDX-License-Identifier: GPL-3.0-or-later
use cibyp_trng_core::{Device, HARDENED, Hardware, OUTPUT, request_mac, response_mac};
struct Board {
    flags: u32,
    presence: bool,
    key: Option<[u8; 32]>,
    counter: u8,
    stuck: bool,
    network: Option<(Vec<u8>, Vec<u8>)>,
    setup_required: bool,
}
impl Default for Board {
    fn default() -> Self {
        Self {
            flags: HARDENED,
            presence: true,
            key: None,
            counter: 0,
            stuck: false,
            network: None,
            setup_required: false,
        }
    }
}
impl Hardware for Board {
    fn random(&mut self, out: &mut [u8]) -> bool {
        for (i, v) in out.iter_mut().enumerate() {
            *v = if self.stuck {
                0
            } else {
                self.counter.wrapping_add(i as u8)
            }
        }
        self.counter = self.counter.wrapping_add(1);
        true
    }
    fn device_id(&self) -> [u8; 6] {
        [1, 2, 3, 4, 5, 6]
    }
    fn security_flags(&self) -> u32 {
        self.flags
    }
    fn physical_presence(&mut self) -> bool {
        self.presence
    }
    fn load_pair_key(&mut self, out: &mut [u8; 32]) -> bool {
        if let Some(key) = self.key {
            *out = key;
            true
        } else {
            false
        }
    }
    fn store_pair_key(&mut self, key: &[u8; 32]) -> bool {
        self.key = Some(*key);
        true
    }
    fn configure_network(&mut self, ssid: &[u8], password: &[u8]) -> bool {
        self.network = Some((ssid.to_vec(), password.to_vec()));
        true
    }
    fn network_setup_required(&self) -> bool {
        self.setup_required
    }
}
fn send(device: &mut Device, board: &mut Board, command: &str) -> String {
    let mut out = [0; OUTPUT];
    let n = device.dispatch(command.as_bytes(), board, &mut out);
    String::from_utf8(out[..n].to_vec()).unwrap()
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|v| format!("{v:02x}")).collect()
}
#[test]
fn pairing_requires_actual_hardening_and_physical_presence() {
    let mut d = Device::default();
    let mut b = Board::default();
    let pair = format!("PAIR2 {}", hex(&[7; 32]));
    b.flags = 0;
    assert!(send(&mut d, &mut b, &pair).contains("DEVICE_NOT_HARDENED"));
    b.flags = HARDENED;
    b.presence = false;
    assert!(send(&mut d, &mut b, &pair).contains("PHYSICAL_CONFIRMATION_REQUIRED"));
    b.presence = true;
    assert!(send(&mut d, &mut b, &pair).contains("\"paired\":true"));
    assert_eq!(b.key, Some([7; 32]));
}
#[test]
fn authenticated_challenge_binds_device_nonce_entropy_flags() {
    let mut d = Device::default();
    let mut b = Board {
        key: Some([7; 32]),
        ..Board::default()
    };
    let nonce = [8; 32];
    let mac = request_mac(&[7; 32], &b.device_id(), &nonce);
    let request = format!("ENTROPY2 {} {}", hex(&nonce), hex(&mac));
    let response = send(&mut d, &mut b, &request);
    let entropy = core::array::from_fn::<_, 64, _>(|i| i as u8);
    assert!(response.contains(&hex(&response_mac(
        &[7; 32],
        &b.device_id(),
        &nonce,
        &entropy,
        HARDENED
    ))));
    assert!(!response.contains(&hex(&[7; 32])));
    assert!(send(&mut d, &mut b, &request).contains("REPLAYED_CHALLENGE"));
}
#[test]
fn spoofed_request_and_stuck_entropy_fail_closed() {
    let mut d = Device::default();
    let mut b = Board {
        key: Some([7; 32]),
        ..Board::default()
    };
    let nonce = [8; 32];
    let forged = format!("ENTROPY2 {} {}", hex(&nonce), hex(&[0; 32]));
    assert!(send(&mut d, &mut b, &forged).contains("DEVICE_AUTHENTICATION_FAILED"));
    b.stuck = true;
    let request = format!(
        "ENTROPY2 {} {}",
        hex(&nonce),
        hex(&request_mac(&[7; 32], &b.device_id(), &nonce))
    );
    assert!(send(&mut d, &mut b, &request).contains("ENTROPY_UNAVAILABLE"));
    assert!(send(&mut d, &mut b, "DRAW").contains("ENTROPY_UNAVAILABLE"));
}
#[test]
fn malformed_frames_and_rejection_loops_are_bounded() {
    let mut d = Device::default();
    let mut b = Board::default();
    for command in [
        "PAIR2 00",
        "ENTROPY2 ff",
        "SPREAD:../../secret",
        &"A".repeat(385),
    ] {
        assert!(send(&mut d, &mut b, command).contains("error"));
    }
    assert!(send(&mut d, &mut b, "DRAW").contains("cardIndex"));
    assert!(send(&mut d, &mut b, "SPREAD:celtic").contains("cards"));
    assert!(send(&mut d, &mut b, "OTA").contains("UNKNOWN_COMMAND"));
}

#[test]
fn network_never_reaches_wallet_commands_even_for_an_admin() {
    let mut d = Device::new();
    let mut b = Board::default();
    let mut output = [0; OUTPUT];
    for admin in [true, false] {
        for command in [
            "NETWORK".to_owned(),
            format!("PAIR2 {}", hex(&[7; 32])),
            format!("ENTROPY2 {} {}", hex(&[8; 32]), hex(&[9; 32])),
            "OTA".to_owned(),
        ] {
            let n = d.dispatch_network(command.as_bytes(), &mut b, &mut output, admin);
            assert!(
                core::str::from_utf8(&output[..n])
                    .unwrap()
                    .contains("NETWORK_COMMAND_FORBIDDEN")
            );
            assert_eq!(b.key, None);
        }
    }
    let n = d.dispatch_network(b"SPREAD:zodiac", &mut b, &mut output, false);
    let result = core::str::from_utf8(&output[..n]).unwrap();
    assert!(!result.contains("error"));
    assert_eq!(result.matches("cardIndex").count(), 12);
    assert!(result.contains("meaningOfUpright"));
    assert!(result.contains("nameEn"));
}

#[test]
fn network_configuration_is_bounded_and_requires_admin() {
    let mut d = Device::new();
    let mut b = Board::default();
    let mut output = [0; OUTPUT];
    let command = format!(
        "NETCFG {} {}",
        hex("新热点".as_bytes()),
        hex(b"correct horse battery staple")
    );
    let n = d.dispatch_network(command.as_bytes(), &mut b, &mut output, false);
    assert!(
        core::str::from_utf8(&output[..n])
            .unwrap()
            .contains("NETWORK_COMMAND_FORBIDDEN")
    );
    assert!(b.network.is_none());
    let n = d.dispatch_network(command.as_bytes(), &mut b, &mut output, true);
    assert!(
        core::str::from_utf8(&output[..n])
            .unwrap()
            .contains("restartRequired")
    );
    assert_eq!(b.network.as_ref().unwrap().0, "新热点".as_bytes());
    for (name, pass) in [
        (vec![b'x'; 33], vec![b'a'; 8]),
        (vec![0xff], vec![b'a'; 8]),
        (vec![b'\n'], vec![b'a'; 8]),
        (b"test".to_vec(), vec![b'a'; 7]),
        (b"test".to_vec(), vec![0; 8]),
    ] {
        let command = format!("NETCFG {} {}", hex(&name), hex(&pass));
        assert!(send(&mut d, &mut b, &command).contains("error"));
    }
}

#[test]
fn open_first_use_network_is_configuration_only() {
    let mut d = Device::new();
    let mut b = Board {
        setup_required: true,
        ..Board::default()
    };
    let mut output = [0; OUTPUT];
    for command in ["DRAW", "SPREAD:three", "RANDOM", "PAIR2 00", "NETWORK"] {
        let n = d.dispatch_network(command.as_bytes(), &mut b, &mut output, false);
        assert!(
            core::str::from_utf8(&output[..n])
                .unwrap()
                .contains("SETUP_REQUIRED")
        );
    }
    let n = d.dispatch_network(b"INFO", &mut b, &mut output, false);
    assert!(
        core::str::from_utf8(&output[..n])
            .unwrap()
            .contains("\"setupRequired\":true")
    );
    let command = format!("NETCFG {} {}", hex(b"My Tarot"), hex(b"my password"));
    let n = d.dispatch_network(command.as_bytes(), &mut b, &mut output, true);
    assert!(
        core::str::from_utf8(&output[..n])
            .unwrap()
            .contains("\"ok\":true")
    );
    // Saving is not enough to unlock an open AP. Only the WPA2 boot does so.
    let n = d.dispatch_network(b"DRAW", &mut b, &mut output, false);
    assert!(
        core::str::from_utf8(&output[..n])
            .unwrap()
            .contains("SETUP_REQUIRED")
    );
}

#[test]
fn question_mix_matches_independent_hkdf_vector_and_requires_fresh_hardware() {
    use cibyp_trng_core::{question_block, question_seed};
    let raw = core::array::from_fn::<_, 64, _>(|i| i as u8);
    let seed = question_seed(&raw, &[8; 32]);
    assert_eq!(
        hex(&seed),
        "5e998f558ddecd815d71058188d20711f8779b704e976326917c04b369fbd153"
    );
    let block = question_block(&seed, b"three", 0);
    assert_eq!(
        hex(&block),
        "208fd830298e461d0adc331f8a30b7109847331e4962e282f997cf10f48e7cbd3e40accd3bfa07e5e8e52a31f2d672eac926b382129375797b6b06a332f2fd10"
    );
    assert_ne!(question_block(&seed, b"three", 1), block);
    assert_ne!(question_block(&seed, b"single", 0), block);
    assert_ne!(question_seed(&raw, &[9; 32]), seed);
    let command = format!("SPREAD2 zodiac {}", hex(&[8; 32]));
    let mut d = Device::new();
    let mut b = Board::default();
    let first = send(&mut d, &mut b, &command);
    let second = send(&mut d, &mut b, &command);
    assert_ne!(first, second);
    assert_eq!(
        b.counter, 2,
        "Each mixed spread obtains a fresh hardware block"
    );
    assert_eq!(first.matches("cardIndex").count(), 12);
    assert!(first.contains("\"questionMixed\":true"));
    assert!(!first.contains(&hex(&[8; 32])));
    b.stuck = true;
    assert!(send(&mut d, &mut b, &command).contains("ENTROPY_UNAVAILABLE"));
    for input in ["SPREAD2 three 00", "SPREAD2 bad aa", "DRAW2 invalid"] {
        assert!(send(&mut d, &mut b, input).contains("error"));
    }
    let mut output = [0; OUTPUT];
    b.setup_required = true;
    let n = d.dispatch_network(command.as_bytes(), &mut b, &mut output, false);
    assert!(
        core::str::from_utf8(&output[..n])
            .unwrap()
            .contains("SETUP_REQUIRED")
    );
}
