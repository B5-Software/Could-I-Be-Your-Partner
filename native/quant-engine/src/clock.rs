//! A virtual clock exists only on the offline replay owner's thread.
//! Live processes never accept clock control through their public protocol.
use std::{
    cell::Cell,
    marker::PhantomData,
    rc::Rc,
    sync::OnceLock,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
#[derive(Clone, Copy)]
struct Sample {
    wall: u128,
    mono: u128,
}
thread_local! { static VIRTUAL: Cell<Option<Sample>> = const { Cell::new(None) }; }
pub struct ReplayClock(PhantomData<Rc<()>>);
impl ReplayClock {
    pub fn enter() -> Result<Self, String> {
        VIRTUAL.with(|clock| {
            if clock.get().is_some() {
                return Err("REPLAY_CLOCK_ALREADY_OWNED".into());
            }
            clock.set(Some(Sample { wall: 0, mono: 0 }));
            Ok(Self(PhantomData))
        })
    }
    pub fn advance(&self, wall: u128, mono: u128) -> Result<(), String> {
        VIRTUAL.with(|clock| {
            let old = clock.get().ok_or("REPLAY_CLOCK_REQUIRED")?;
            if mono < old.mono || wall > u64::MAX as u128 * 1_000_000_000 {
                return Err("REPLAY_TIME_REGRESSED_OR_RANGE".into());
            }
            clock.set(Some(Sample { wall, mono }));
            Ok(())
        })
    }
}
impl Drop for ReplayClock {
    fn drop(&mut self) {
        VIRTUAL.with(|clock| clock.set(None));
    }
}
pub fn now_ns() -> u128 {
    VIRTUAL.with(|clock| {
        clock.get().map_or_else(
            || {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            },
            |sample| sample.wall,
        )
    })
}
pub fn mono_ns() -> u128 {
    static ORIGIN: OnceLock<Instant> = OnceLock::new();
    VIRTUAL.with(|clock| {
        clock.get().map_or_else(
            || ORIGIN.get_or_init(Instant::now).elapsed().as_nanos(),
            |sample| sample.mono,
        )
    })
}
pub fn elapsed_ns(mark: u128) -> u128 {
    mono_ns().saturating_sub(mark)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn virtual_time_is_thread_scoped_monotonic_and_restored_on_drop() {
        let real = now_ns();
        {
            let clock = ReplayClock::enter().unwrap();
            clock.advance(1_700_000_000_000_000_000, 100).unwrap();
            assert!(ReplayClock::enter().is_err());
            assert_eq!(mono_ns(), 100);
            assert_eq!(now_ns(), 1_700_000_000_000_000_000);
            assert!(std::thread::spawn(now_ns).join().unwrap() >= real);
            assert!(clock.advance(0, 99).is_err());
            assert_eq!(mono_ns(), 100);
            let mut book = crate::book::Book::default();
            let n = |v: &str| crate::decimal::Fixed::try_from(v.to_owned()).unwrap();
            book.snapshot(
                "virtual".into(),
                1,
                vec![[n("99"), n("1")]],
                vec![[n("101"), n("1")]],
            )
            .unwrap();
            assert!(book.eligible(1000));
            clock
                .advance(1_700_000_002_000_000_000, 2_000_000_100)
                .unwrap();
            assert!(!book.eligible(1000));
        }
        assert!(now_ns() >= real);
    }
}
