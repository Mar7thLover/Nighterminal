// Keep the console window away from release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    nighterminal_lib::run()
}
