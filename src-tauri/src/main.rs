// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    /* The observer that outlives a wall and says how it died, first of the two,
       because `hooks::intercept` **refuses argv it does not recognise** with
       exit 2 — a guard added after a typo opened eighteen walls — and
       `--watch-wall` would have been read as that typo. Measured, in the lab
       and by hand: the observer started and exited 2 without writing a thing,
       which is the one failure a crash recorder must not have. It may not open
       a store or a window either. See `crash.rs`. */
    if skein_lib::crash::intercept() {
        return;
    }

    /* Before anything else that could open one, because this binary is also the
       `PreToolUse` hook it hands its cards and a hook invocation must not open a
       store or a window. See `hooks.rs`. The GUI subsystem above does not get in
       the way: with no console attached the standard handles are the ones the
       parent redirected, which for a hook is always a pipe. */
    if skein_lib::hooks::intercept() {
        return;
    }

    skein_lib::run()
}
