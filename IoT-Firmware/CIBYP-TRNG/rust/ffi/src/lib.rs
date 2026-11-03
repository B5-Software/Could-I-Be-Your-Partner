// SPDX-License-Identifier: GPL-3.0-or-later
#![no_std]
#![deny(unsafe_op_in_unsafe_fn)]
use cibyp_trng_core::{Device, Hardware, MAX_FRAME, OUTPUT};
use core::{
    cell::UnsafeCell,
    sync::atomic::{AtomicBool, Ordering},
};
unsafe extern "C" {
    fn cibyp_rng(out: *mut u8, length: usize) -> bool;
    fn cibyp_id(out: *mut u8);
    fn cibyp_security() -> u32;
    fn cibyp_presence() -> bool;
    fn cibyp_load_pair(out: *mut u8) -> bool;
    fn cibyp_store_pair(key: *const u8) -> bool;
    fn cibyp_network_setup_required() -> bool;
    fn cibyp_configure_network(
        ssid: *const u8,
        ssid_len: usize,
        password: *const u8,
        password_len: usize,
    ) -> bool;
    fn abort() -> !;
}
struct Port;
impl Hardware for Port {
    fn random(&mut self, out: &mut [u8]) -> bool {
        unsafe { cibyp_rng(out.as_mut_ptr(), out.len()) }
    }
    fn device_id(&self) -> [u8; 6] {
        let mut id = [0; 6];
        unsafe {
            cibyp_id(id.as_mut_ptr());
        }
        id
    }
    fn security_flags(&self) -> u32 {
        unsafe { cibyp_security() }
    }
    fn physical_presence(&mut self) -> bool {
        unsafe { cibyp_presence() }
    }
    fn load_pair_key(&mut self, key: &mut [u8; 32]) -> bool {
        unsafe { cibyp_load_pair(key.as_mut_ptr()) }
    }
    fn store_pair_key(&mut self, key: &[u8; 32]) -> bool {
        unsafe { cibyp_store_pair(key.as_ptr()) }
    }
    fn configure_network(&mut self, ssid: &[u8], password: &[u8]) -> bool {
        unsafe {
            cibyp_configure_network(ssid.as_ptr(), ssid.len(), password.as_ptr(), password.len())
        }
    }
    fn network_setup_required(&self) -> bool {
        unsafe { cibyp_network_setup_required() }
    }
}
struct Shared {
    busy: AtomicBool,
    device: UnsafeCell<Device>,
}
// Every access to device is guarded by the atomic single-caller gate.
unsafe impl Sync for Shared {}
static STATE: Shared = Shared {
    busy: AtomicBool::new(false),
    device: UnsafeCell::new(Device::new()),
};
/// # Safety
/// Called only by port.c with disjoint, live input/output arrays of the stated
/// lengths. No host/network pointer or unbounded C string crosses this boundary.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cibyp_dispatch(
    input: *const u8,
    length: usize,
    output: *mut u8,
    capacity: usize,
) -> usize {
    unsafe { dispatch(input, length, output, capacity, None) }
}
/// # Safety
/// IDF supplies bounded, disjoint buffers. Only authenticated HTTP configuration
/// can set admin. Even an admin cannot access USB wallet commands.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cibyp_dispatch_network(
    input: *const u8,
    length: usize,
    output: *mut u8,
    capacity: usize,
    admin: bool,
) -> usize {
    unsafe { dispatch(input, length, output, capacity, Some(admin)) }
}
unsafe fn dispatch(
    input: *const u8,
    length: usize,
    output: *mut u8,
    capacity: usize,
    network: Option<bool>,
) -> usize {
    if input.is_null() || output.is_null() || length > MAX_FRAME || capacity < OUTPUT {
        return 0;
    }
    if STATE
        .busy
        .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
        .is_err()
    {
        return 0;
    }
    // SAFETY: fixed arrays in port.c satisfy the contract; the gate serializes
    // callbacks and is also held while hardware is accessed.
    let result = unsafe {
        let device = &mut *STATE.device.get();
        let input = core::slice::from_raw_parts(input, length);
        let output = core::slice::from_raw_parts_mut(output, OUTPUT);
        match network {
            Some(admin) => device.dispatch_network(input, &mut Port, output, admin),
            None => device.dispatch(input, &mut Port, output),
        }
    };
    STATE.busy.store(false, Ordering::Release);
    result
}
#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    unsafe { abort() }
}
