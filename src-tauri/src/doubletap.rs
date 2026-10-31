#![cfg_attr(not(target_os = "macos"), allow(dead_code))]
//! Double tap on a modifier key (e.g. ⌥ ⌥) as a global hotkey.
//! Detection is platform independent; listening to the keyboard is macOS only (CGEventTap).

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const MASK_SHIFT: u64 = 0x0002_0000;
const MASK_CONTROL: u64 = 0x0004_0000;
const MASK_OPTION: u64 = 0x0008_0000;
const MASK_COMMAND: u64 = 0x0010_0000;
const ALL_MODS: u64 = MASK_SHIFT | MASK_CONTROL | MASK_OPTION | MASK_COMMAND;

/// Longest time a key may be held to count as a "tap"
const TAP_MAX: Duration = Duration::from_millis(300);
/// Longest gap between two taps
const GAP_MAX: Duration = Duration::from_millis(450);

#[derive(Clone, Copy, PartialEq, Debug)]
#[repr(u8)]
pub enum TapKey {
    Off = 0,
    Option = 1,
    RightOption = 2,
    Command = 3,
    RightCommand = 4,
    Control = 5,
    Shift = 6,
}

impl TapKey {
    pub fn parse(s: &str) -> TapKey {
        match s {
            "option" => TapKey::Option,
            "rightOption" => TapKey::RightOption,
            "command" => TapKey::Command,
            "rightCommand" => TapKey::RightCommand,
            "control" => TapKey::Control,
            "shift" => TapKey::Shift,
            _ => TapKey::Off,
        }
    }
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn from_u8(v: u8) -> TapKey {
        match v {
            1 => TapKey::Option,
            2 => TapKey::RightOption,
            3 => TapKey::Command,
            4 => TapKey::RightCommand,
            5 => TapKey::Control,
            6 => TapKey::Shift,
            _ => TapKey::Off,
        }
    }
    /// macOS key codes and flag mask
    fn codes_and_mask(self) -> (&'static [i64], u64) {
        match self {
            TapKey::Off => (&[], 0),
            TapKey::Option => (&[58, 61], MASK_OPTION),
            TapKey::RightOption => (&[61], MASK_OPTION),
            TapKey::Command => (&[55, 54], MASK_COMMAND),
            TapKey::RightCommand => (&[54], MASK_COMMAND),
            TapKey::Control => (&[59, 62], MASK_CONTROL),
            TapKey::Shift => (&[56, 60], MASK_SHIFT),
        }
    }
}

static CURRENT: AtomicU8 = AtomicU8::new(0);
static STATUS: Mutex<&'static str> = Mutex::new("off");

pub fn set_key(key: TapKey) {
    CURRENT.store(key as u8, Ordering::SeqCst);
}

pub fn status() -> &'static str {
    *STATUS.lock().unwrap()
}

fn set_status(s: &'static str) {
    *STATUS.lock().unwrap() = s;
}

/// Pure detection logic (testable without a keyboard)
#[derive(Default)]
pub struct Detector {
    down_at: Option<Instant>,
    last_tap: Option<Instant>,
    dirty: bool,
}

impl Detector {
    /// A modifier changed. Returns true when a double tap was detected.
    pub fn on_flags(&mut self, key: TapKey, keycode: i64, flags: u64, now: Instant) -> bool {
        let (codes, mask) = key.codes_and_mask();
        if codes.is_empty() {
            return false;
        }
        if !codes.contains(&keycode) {
            // another modifier key: cancel the sequence
            self.reset();
            return false;
        }
        let pressed = flags & mask != 0;
        let others = flags & (ALL_MODS & !mask) != 0;
        if pressed {
            if others {
                self.reset();
            } else {
                self.down_at = Some(now);
                self.dirty = false;
            }
            return false;
        }
        // released
        let was_tap = matches!(self.down_at, Some(d) if !self.dirty && now.duration_since(d) <= TAP_MAX);
        self.down_at = None;
        if !was_tap {
            self.last_tap = None;
            return false;
        }
        match self.last_tap {
            Some(t) if now.duration_since(t) <= GAP_MAX => {
                self.last_tap = None;
                true
            }
            _ => {
                self.last_tap = Some(now);
                false
            }
        }
    }

    /// A normal key was pressed: no double tap
    pub fn on_key(&mut self) {
        self.reset();
    }

    fn reset(&mut self) {
        self.down_at = None;
        self.last_tap = None;
        self.dirty = true;
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
    use core_graphics::event::{
        CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType, EventField,
    };

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightListenEventAccess() -> bool;
        fn CGRequestListenEventAccess() -> bool;
    }

    pub fn start<F: Fn() + Send + 'static>(on_double_tap: F) {
        std::thread::spawn(move || {
            let detector = Mutex::new(Detector::default());
            let mut asked = false;
            loop {
                // without "Input Monitoring" macOS delivers no keyboard events
                if !unsafe { CGPreflightListenEventAccess() } {
                    set_status("permission");
                    if !asked {
                        asked = true;
                        unsafe { CGRequestListenEventAccess() };
                    }
                    std::thread::sleep(Duration::from_secs(3));
                    continue;
                }
                let tap = CGEventTap::new(
                    CGEventTapLocation::Session,
                    CGEventTapPlacement::TailAppendEventTap,
                    CGEventTapOptions::ListenOnly,
                    vec![CGEventType::FlagsChanged, CGEventType::KeyDown],
                    |_proxy, etype, event| {
                        let key = TapKey::from_u8(CURRENT.load(Ordering::SeqCst));
                        let mut d = detector.lock().unwrap();
                        match etype {
                            CGEventType::FlagsChanged => {
                                let code = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
                                let flags = event.get_flags().bits();
                                if d.on_flags(key, code, flags, Instant::now()) {
                                    on_double_tap();
                                }
                            }
                            CGEventType::KeyDown => d.on_key(),
                            _ => {}
                        }
                        None
                    },
                );
                match tap {
                    Ok(tap) => unsafe {
                        let Ok(source) = tap.mach_port.create_runloop_source(0) else {
                            set_status("error");
                            return;
                        };
                        CFRunLoop::get_current().add_source(&source, kCFRunLoopCommonModes);
                        tap.enable();
                        set_status("active");
                        CFRunLoop::run_current();
                        return;
                    },
                    Err(_) => {
                        set_status("permission");
                        std::thread::sleep(Duration::from_secs(3));
                    }
                }
            }
        });
    }
}

/// Start listening (macOS only). The callback runs on the keyboard thread.
pub fn start<F: Fn() + Send + 'static>(on_double_tap: F) {
    #[cfg(target_os = "macos")]
    mac::start(on_double_tap);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = on_double_tap;
        set_status("unsupported");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(base: Instant, n: u64) -> Instant {
        base + Duration::from_millis(n)
    }

    #[test]
    fn double_tap_option() {
        let mut d = Detector::default();
        let t = Instant::now();
        let k = TapKey::Option;
        assert!(!d.on_flags(k, 58, MASK_OPTION, ms(t, 0)));
        assert!(!d.on_flags(k, 58, 0, ms(t, 80)));
        assert!(!d.on_flags(k, 58, MASK_OPTION, ms(t, 200)));
        assert!(d.on_flags(k, 58, 0, ms(t, 280)));
    }

    #[test]
    fn too_slow() {
        let mut d = Detector::default();
        let t = Instant::now();
        let k = TapKey::Option;
        d.on_flags(k, 58, MASK_OPTION, ms(t, 0));
        d.on_flags(k, 58, 0, ms(t, 80));
        d.on_flags(k, 58, MASK_OPTION, ms(t, 700));
        assert!(!d.on_flags(k, 58, 0, ms(t, 780)));
    }

    #[test]
    fn held_too_long() {
        let mut d = Detector::default();
        let t = Instant::now();
        let k = TapKey::Option;
        d.on_flags(k, 58, MASK_OPTION, ms(t, 0));
        d.on_flags(k, 58, 0, ms(t, 500));
        d.on_flags(k, 58, MASK_OPTION, ms(t, 600));
        assert!(!d.on_flags(k, 58, 0, ms(t, 650)));
    }

    #[test]
    fn key_in_between_cancels() {
        let mut d = Detector::default();
        let t = Instant::now();
        let k = TapKey::Option;
        d.on_flags(k, 58, MASK_OPTION, ms(t, 0));
        d.on_flags(k, 58, 0, ms(t, 80));
        d.on_key(); // e.g. ⌥ used to type a character
        d.on_flags(k, 58, MASK_OPTION, ms(t, 200));
        assert!(!d.on_flags(k, 58, 0, ms(t, 260)));
    }

    #[test]
    fn combo_with_other_modifier_cancels() {
        let mut d = Detector::default();
        let t = Instant::now();
        let k = TapKey::Option;
        d.on_flags(k, 58, MASK_OPTION, ms(t, 0));
        d.on_flags(k, 58, 0, ms(t, 80));
        d.on_flags(k, 58, MASK_OPTION | MASK_COMMAND, ms(t, 200));
        assert!(!d.on_flags(k, 58, MASK_COMMAND, ms(t, 260)));
    }

    #[test]
    fn right_option_only() {
        let mut d = Detector::default();
        let t = Instant::now();
        let k = TapKey::RightOption;
        d.on_flags(k, 58, MASK_OPTION, ms(t, 0));
        d.on_flags(k, 58, 0, ms(t, 80));
        d.on_flags(k, 61, MASK_OPTION, ms(t, 150));
        assert!(!d.on_flags(k, 61, 0, ms(t, 200)), "left + right is not a right double tap");
        d.on_flags(k, 61, MASK_OPTION, ms(t, 300));
        assert!(d.on_flags(k, 61, 0, ms(t, 350)));
    }
}
