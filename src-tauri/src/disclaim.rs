//! macOS: start child processes as their own "responsible process".
//!
//! macOS attributes network access of child processes to the app that started them. For a self-built (not
//! notarised) app it often never asks for the "Local Network" permission and silently blocks addresses in the LAN
//! (EHOSTUNREACH) – Pi then reports "Connection error" for model servers in the local network, while the same Pi
//! works from the terminal. Terminal apps and IDEs avoid this by "disclaiming" responsibility for their children:
//! PiBar re-runs itself as `PiBar --pibar-disclaim <program> <args…>`, and that helper replaces itself with the
//! program (posix_spawn with POSIX_SPAWN_SETEXEC + responsibility_spawnattrs_setdisclaim). Same process id, same
//! pipes and environment – only macOS no longer counts the program as part of PiBar.

/// Argument that makes the PiBar binary act as the helper (checked first thing in main)
pub const FLAG: &str = "--pibar-disclaim";

/// If PiBar was started as helper: exec the program; otherwise return and start the app normally
pub fn run_if_requested() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some(FLAG) && args.len() > 2 {
        exec(&args[2..]);
    }
}

/// Command for a child process; on macOS wrapped in the helper (falls back to the program itself)
pub fn command(program: &str) -> std::process::Command {
    #[cfg(target_os = "macos")]
    if let Ok(me) = std::env::current_exe() {
        let mut c = std::process::Command::new(me);
        c.arg(FLAG).arg(program);
        return c;
    }
    std::process::Command::new(program)
}

#[cfg(target_os = "macos")]
fn exec(args: &[String]) -> ! {
    use std::ffi::CString;
    type Disclaim = unsafe extern "C" fn(*mut libc::posix_spawnattr_t, libc::c_int) -> libc::c_int;
    let cargs: Vec<CString> = args.iter().filter_map(|a| CString::new(a.as_str()).ok()).collect();
    let mut argv: Vec<*mut libc::c_char> = cargs.iter().map(|c| c.as_ptr() as *mut libc::c_char).collect();
    argv.push(std::ptr::null_mut());
    // SAFETY: plain libc calls with valid, NUL-terminated arguments; on success posix_spawnp does not return
    unsafe {
        let mut attr: libc::posix_spawnattr_t = std::ptr::null_mut();
        libc::posix_spawnattr_init(&mut attr);
        libc::posix_spawnattr_setflags(&mut attr, libc::POSIX_SPAWN_SETEXEC as libc::c_short);
        // private API (macOS 10.14+), looked up at runtime so a missing symbol only skips the disclaim
        let name = CString::new("responsibility_spawnattrs_setdisclaim").unwrap_or_default();
        let sym = libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr());
        if !sym.is_null() {
            let disclaim: Disclaim = std::mem::transmute(sym);
            disclaim(&mut attr, 1);
        }
        let env = *libc::_NSGetEnviron();
        let mut pid: libc::pid_t = 0;
        let rc = libc::posix_spawnp(&mut pid, argv[0], std::ptr::null(), &attr, argv.as_ptr(), env);
        eprintln!("PiBar: could not start {}: error {rc}", args[0]);
    }
    std::process::exit(127)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn exec(args: &[String]) -> ! {
    use std::os::unix::process::CommandExt;
    let err = std::process::Command::new(&args[0]).args(&args[1..]).exec();
    eprintln!("PiBar: could not start {}: {err}", args[0]);
    std::process::exit(127)
}

#[cfg(not(unix))]
fn exec(args: &[String]) -> ! {
    let code = std::process::Command::new(&args[0]).args(&args[1..]).status().map(|s| s.code().unwrap_or(1));
    std::process::exit(code.unwrap_or(127))
}
