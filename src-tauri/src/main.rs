// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod scanner;

use scanner::Snapshot;

#[tauri::command]
fn scan() -> Result<Snapshot, String> {
    scanner::scan_all().map_err(|e| e.to_string())
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read {path}: {e}"))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![scan, read_text_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
