//! The temperature extension for Pi: its bundled source and the installation on a host (local or SSH).
//! PiBar writes it to ~/.pi/agent/extensions/pibar-temperature.ts; Pi loads it on the next start of a session and
//! then offers /temperature (see src/shared/temperature.ts and SessionTab.setTemperature).

use crate::config::HostCfg;
use crate::hostexec;

/// Source of the extension, written to the host unchanged.
pub const EXTENSION: &str = include_str!("../extensions/pibar-temperature.ts");

/// Shell script that writes the extension (its content arrives on stdin) into Pi's extensions folder.
pub fn install_script() -> String {
    "mkdir -p \"$HOME/.pi/agent/extensions\" && cat > \"$HOME/.pi/agent/extensions/pibar-temperature.ts\"".into()
}

/// Install (or update) the extension on the host. Pi picks it up on the next start of a session.
pub fn install(h: &HostCfg) -> Result<(), String> {
    hostexec::run_shell(h, &install_script(), Some(EXTENSION.as_bytes())).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_writes_into_the_extensions_folder() {
        let s = install_script();
        assert!(s.contains("mkdir -p \"$HOME/.pi/agent/extensions\""));
        assert!(s.contains("cat > \"$HOME/.pi/agent/extensions/pibar-temperature.ts\""));
    }

    #[test]
    fn extension_registers_command_flag_and_hook() {
        assert!(EXTENSION.contains("registerCommand(\"temperature\""));
        assert!(EXTENSION.contains("registerFlag(\"temperature\""));
        assert!(EXTENSION.contains("before_provider_request"));
        assert!(EXTENSION.contains("pibar-temperature"));
    }
}
