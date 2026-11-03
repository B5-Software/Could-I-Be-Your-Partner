// SPDX-License-Identifier: GPL-3.0-or-later
#![forbid(unsafe_code)]
use cibyp_wallet_signer::{Input, Signer, wipe_json};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    io::{self, BufRead, Read, Write},
    sync::mpsc,
    time::Duration,
};
use zeroize::Zeroizing;
const LIMIT: usize = 131072;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    protocol: u8,
    id: String,
    action: String,
    input: Input,
}
fn send(mut result: Value) -> io::Result<()> {
    let mut bytes = Zeroizing::new(serde_json::to_vec(&result)?);
    wipe_json(&mut result);
    bytes.push(b'\n');
    let mut output = io::stdout().lock();
    output.write_all(&bytes)?;
    output.flush()
}
fn main() {
    // No panic/debug dumps of request values. All protocol errors are fixed codes.
    std::panic::set_hook(Box::new(|_| {}));
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut input = io::stdin().lock();
        loop {
            let mut line = Zeroizing::new(Vec::new());
            let result = (&mut input)
                .take((LIMIT + 1) as u64)
                .read_until(b'\n', &mut line);
            match result {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if line.len() > LIMIT || !line.ends_with(b"\n") {
                        break;
                    }
                    if sender.send(line).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    if arguments.len() != 2 || arguments[0] != "--store" {
        return;
    }
    let mut signer = match Signer::open(std::path::Path::new(&arguments[1])) {
        Ok(signer) => signer,
        Err(code) => {
            let _ = send(json!({"type":"startup-error","error":code}));
            return;
        }
    };
    if send(json!({"type":"ready","protocol":7,"version":"0.1.0","vault":"CIBYP-WALLET/1","receipts":1,"authority":2,"portfolios":1,"agentScopes":1,"periodBudgets":1}))
        .is_err()
    {
        return;
    }
    loop {
        for id in signer.expired() {
            if send(json!({"type":"locked","walletId":id})).is_err() {
                return;
            }
        }
        match receiver.recv_timeout(Duration::from_secs(1)) {
            Ok(line) => {
                let request: Request = match serde_json::from_slice(&line) {
                    Ok(value) => value,
                    Err(_) => return,
                };
                if request.protocol != 7
                    || request.id.is_empty()
                    || request.id.len() > 80
                    || !request
                        .id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                {
                    return;
                }
                let response = match signer.request(&request.action, &request.input) {
                    Ok(value) => json!({"id":request.id,"result":value}),
                    Err(code) => json!({"id":request.id,"error":code}),
                };
                if send(response).is_err() {
                    return;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
    }
}
