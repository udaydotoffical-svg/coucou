// Mochi feels the PC: a busy processor makes him sweat and panic, short memory puffs him up, a low
// battery makes him tired, then asleep (the Mac's MachineVitals.swift, MochiMood.swift).
//
// It only reads while Mochi is on screen (the island showing, or Mochi on the desktop; the island
// page says so with `vitals_active`), every few seconds: a hidden island costs nothing. Everything
// stays on this computer.
//
// Windows only for now: the other systems keep a calm Mochi.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::AppHandle;

/// Mochi is on screen, so the PC is worth reading.
static ACTIVE: AtomicBool = AtomicBool::new(false);
#[cfg(windows)]
static STARTED: AtomicBool = AtomicBool::new(false);

/// What the page draws, and the line shown while the pointer is on Mochi.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Vitals {
    pub busy: f64,
    pub hot: f64,
    pub full: f64,
    pub tired: f64,
    pub asleep: bool,
    pub summary: Option<String>,
}

/// The processor is above this for two readings in a row: he sweats. A short spike does not.
const BUSY_FROM: f64 = 0.8;

/// The levels for what was read. Memory is a percentage in use, the battery `(percent, on power)`.
pub fn mood_from(cpu: f64, busy_samples: u32, memory_load: u32, battery: Option<(u32, bool)>) -> Vitals {
    let mut v = Vitals::default();
    if busy_samples >= 2 {
        v.busy = ((cpu - 0.6) / 0.3).clamp(0.0, 1.0);
    }
    v.full = match memory_load {
        95..=100 => 1.0,
        90..=94 => 0.6,
        _ => 0.0,
    };
    if let Some((percent, on_power)) = battery {
        if !on_power {
            v.tired = if percent < 20 { 1.0 } else { 0.0 };
            v.asleep = percent < 10;
        }
    }
    v
}

/// The words under Mochi, the most telling first.
pub fn describe(v: &Vitals, cpu: f64, battery: Option<(u32, bool)>, top: &[String]) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if v.busy > 0.0 {
        let pct = (cpu * 100.0).round() as i64;
        parts.push(if top.is_empty() {
            format!("CPU {pct} %")
        } else {
            format!("CPU {pct} % · {}", top.iter().take(2).cloned().collect::<Vec<_>>().join(", "))
        });
    }
    if v.full >= 1.0 {
        parts.push("Memory full".into());
    } else if v.full > 0.0 {
        parts.push("Memory short".into());
    }
    if let Some((percent, _)) = battery {
        if v.tired > 0.0 || v.asleep {
            parts.push(format!("Battery {percent} %"));
        }
    }
    if parts.is_empty() { None } else { Some(parts.into_iter().take(2).collect::<Vec<_>>().join(" · ")) }
}

/// The island says whether Mochi is on screen. The reader starts with the first "yes".
#[allow(unused_variables)]
pub fn set_active(app: &AppHandle, on: bool) {
    ACTIVE.store(on, Ordering::Relaxed);
    #[cfg(windows)]
    if on && !STARTED.swap(true, Ordering::SeqCst) {
        let app = app.clone();
        std::thread::spawn(move || windows_reader::run(app));
    }
}

#[cfg(windows)]
mod windows_reader {
    use std::collections::HashMap;
    use std::mem::size_of;
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    use tauri::{AppHandle, Emitter, Manager};
    use windows::Win32::Foundation::{CloseHandle, FILETIME};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows::Win32::System::Threading::{
        GetProcessTimes, GetSystemTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    use super::{describe, mood_from, Vitals, ACTIVE, BUSY_FROM};
    use crate::island::WINDOW_LABEL;

    fn ticks(ft: FILETIME) -> u64 {
        ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64
    }

    /// All the processor time since boot: (busy, total) over every core.
    fn cpu_ticks() -> Option<(u64, u64)> {
        let (mut idle, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
        unsafe { GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)).ok()? };
        // The kernel's time includes the idle time.
        let total = ticks(kernel) + ticks(user);
        Some((total.saturating_sub(ticks(idle)), total))
    }

    fn memory_load() -> u32 {
        let mut status = MEMORYSTATUSEX { dwLength: size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
        if unsafe { GlobalMemoryStatusEx(&mut status) }.is_ok() { status.dwMemoryLoad } else { 0 }
    }

    /// The internal battery: its charge and whether the computer is plugged in. None on a desktop.
    fn battery() -> Option<(u32, bool)> {
        let mut s = SYSTEM_POWER_STATUS::default();
        unsafe { GetSystemPowerStatus(&mut s).ok()? };
        // 128: no battery; 255: unknown.
        if s.BatteryFlag & 128 != 0 || s.BatteryLifePercent > 100 {
            return None;
        }
        Some((s.BatteryLifePercent as u32, s.ACLineStatus == 1))
    }

    /// The programs that used the processor the most since the last reading.
    fn top_processes(last: &mut HashMap<u32, u64>) -> Vec<String> {
        let mut times: HashMap<u32, u64> = HashMap::new();
        let mut deltas: Vec<(u64, String)> = Vec::new();
        let own = std::process::id();
        unsafe {
            let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return Vec::new() };
            let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            let mut more = Process32FirstW(snap, &mut entry).is_ok();
            while more {
                let pid = entry.th32ProcessID;
                if pid != 0 && pid != own {
                    if let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                        let (mut c, mut e, mut k, mut u) =
                            (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
                        if GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u).is_ok() {
                            let total = ticks(k) + ticks(u);
                            times.insert(pid, total);
                            if let Some(before) = last.get(&pid) {
                                if total > *before {
                                    let len = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
                                    let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
                                    let name = name.strip_suffix(".exe").unwrap_or(&name).to_string();
                                    deltas.push((total - before, name));
                                }
                            }
                        }
                        let _ = CloseHandle(h);
                    }
                }
                more = Process32NextW(snap, &mut entry).is_ok();
            }
            let _ = CloseHandle(snap);
        }
        *last = times;
        // One line per program (a browser has dozens of processes): the sum of its processes.
        let mut by_name: HashMap<String, u64> = HashMap::new();
        for (delta, name) in deltas {
            *by_name.entry(name).or_default() += delta;
        }
        let mut sorted: Vec<(String, u64)> = by_name.into_iter().collect();
        sorted.sort_by(|a, b| b.1.cmp(&a.1));
        sorted.into_iter().take(2).map(|(n, _)| n).collect()
    }

    fn enabled(app: &AppHandle) -> bool {
        app.try_state::<crate::Shared>().map(|s| s.settings.lock().unwrap().mochi_feels_pc).unwrap_or(false)
    }

    pub fn run(app: AppHandle) {
        let mut last_ticks: Option<(u64, u64)> = None;
        let mut cpu = 0.0;
        let mut busy_samples = 0u32;
        let mut last_procs: HashMap<u32, u64> = HashMap::new();
        let mut was_low = false;
        let mut sent = Vitals::default();
        loop {
            if !ACTIVE.load(Ordering::Relaxed) || !enabled(&app) {
                // Off or out of sight: nothing is read, and he goes back to calm once.
                if sent != Vitals::default() {
                    sent = Vitals::default();
                    let _ = app.emit_to(WINDOW_LABEL, "vitals", &sent);
                }
                last_ticks = None;
                busy_samples = 0;
                last_procs.clear();
                std::thread::sleep(Duration::from_secs(1));
                continue;
            }
            if let Some(now) = cpu_ticks() {
                if let Some(before) = last_ticks {
                    if now.1 > before.1 {
                        cpu = (now.0.saturating_sub(before.0)) as f64 / (now.1 - before.1) as f64;
                    }
                }
                last_ticks = Some(now);
            }
            busy_samples = if cpu >= BUSY_FROM { busy_samples + 1 } else { 0 };
            let battery = battery();
            let low = matches!(battery, Some((p, false)) if p < 20);
            if was_low && !low && matches!(battery, Some((_, true))) {
                // Plugged in while tired: he wakes up.
                let _ = app.emit_to(WINDOW_LABEL, "vitals-woke", true);
            }
            was_low = low;
            let top = if busy_samples >= 2 {
                top_processes(&mut last_procs)
            } else {
                last_procs.clear();
                Vec::new()
            };
            let mut next = mood_from(cpu, busy_samples, memory_load(), battery);
            next.summary = describe(&next, cpu, battery, &top);
            if next != sent {
                let _ = app.emit_to(WINDOW_LABEL, "vitals", &next);
                sent = next;
            }
            std::thread::sleep(Duration::from_secs(3));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_short_spike_does_not_make_him_sweat_but_two_readings_do() {
        assert_eq!(mood_from(0.95, 1, 40, None).busy, 0.0);
        assert!((mood_from(0.95, 2, 40, None).busy - 1.0).abs() < 1e-9);
        assert!(mood_from(0.8, 2, 40, None).busy > 0.5);
        assert_eq!(mood_from(0.5, 0, 40, None).busy, 0.0);
    }

    #[test]
    fn short_memory_puffs_him_up() {
        assert_eq!(mood_from(0.1, 0, 80, None).full, 0.0);
        assert_eq!(mood_from(0.1, 0, 91, None).full, 0.6);
        assert_eq!(mood_from(0.1, 0, 97, None).full, 1.0);
    }

    #[test]
    fn a_low_battery_tires_him_only_when_unplugged() {
        let on_battery = mood_from(0.1, 0, 40, Some((15, false)));
        assert_eq!((on_battery.tired, on_battery.asleep), (1.0, false));
        let nearly_empty = mood_from(0.1, 0, 40, Some((8, false)));
        assert!(nearly_empty.asleep);
        let plugged = mood_from(0.1, 0, 40, Some((5, true)));
        assert_eq!((plugged.tired, plugged.asleep), (0.0, false));
        assert_eq!(mood_from(0.1, 0, 40, Some((60, false))).tired, 0.0);
    }

    #[test]
    fn the_line_names_the_busiest_programs() {
        let v = mood_from(0.94, 2, 40, None);
        let top = vec!["node".to_string(), "chrome".to_string(), "other".to_string()];
        assert_eq!(describe(&v, 0.94, None, &top).as_deref(), Some("CPU 94 % · node, chrome"));
        assert_eq!(describe(&mood_from(0.2, 0, 40, None), 0.2, None, &[]), None);
        let tired = mood_from(0.2, 0, 40, Some((12, false)));
        assert_eq!(describe(&tired, 0.2, Some((12, false)), &[]).as_deref(), Some("Battery 12 %"));
    }
}
