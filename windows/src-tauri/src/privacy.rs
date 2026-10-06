// Is the camera or the microphone in use right now?
//
// Windows keeps a record per app in the registry (the same one behind its own
// camera / microphone indicator in the taskbar): when an app starts using a device
// it stamps "last used: start" and clears "last used: stop", and sets the stop once
// it lets go. Reading it needs no permission and sends nothing anywhere.

use serde::Serialize;

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Default)]
pub struct Privacy {
    pub camera: bool,
    pub mic: bool,
}

#[cfg(windows)]
pub fn status() -> Privacy {
    Privacy { camera: in_use("webcam"), mic: in_use("microphone") }
}

#[cfg(not(windows))]
pub fn status() -> Privacy {
    Privacy::default()
}

#[cfg(windows)]
fn in_use(capability: &str) -> bool {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let path = format!(
        r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\{capability}"
    );
    let Ok(root) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(&path) else { return false };

    let busy = |key: &RegKey| -> bool {
        let start: u64 = key.get_value("LastUsedTimeStart").unwrap_or(0);
        let stop: u64 = key.get_value("LastUsedTimeStop").unwrap_or(0);
        start != 0 && stop < start
    };

    for name in root.enum_keys().flatten() {
        let Ok(app) = root.open_subkey(&name) else { continue };
        if name == "NonPackaged" {
            // Classic desktop programs live one level down.
            for sub in app.enum_keys().flatten() {
                if app.open_subkey(&sub).map(|k| busy(&k)).unwrap_or(false) {
                    return true;
                }
            }
        } else if busy(&app) {
            return true;
        }
    }
    false
}
