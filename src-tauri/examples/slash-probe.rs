//! What does a directory actually offer under a slash?
//!
//! Drives the real `slash::ask` — the spawn, the control request, the wait and
//! the parse — rather than a copy of it, which is the arrangement
//! `examples/find-probe.rs` and `examples/azdo-probe.rs` already have and the
//! convention `tools/probe-context.ts` sets for questions of the form "what does
//! this actually do".
//!
//! ```powershell
//! cd src-tauri
//! cargo run --example slash-probe                 # this checkout
//! cargo run --example slash-probe -- C:\some\repo # somewhere else
//! ```
//!
//! `tools/probe-skills.ts initialize` asks the same question of the CLI
//! directly. The difference is what is being checked: that one is about the
//! *wire*, and this is about the wrapper — that the child is spawned in the
//! right directory with an argv that answers, that closing stdin does not lose
//! the reply, and that the whole thing comes back inside the timeout with the
//! fields the palette draws.
//!
//! Costs nothing: the CLI answers `initialize` itself, before any prompt.

fn main() {
    let cwd = std::env::args().nth(1).unwrap_or_else(|| {
        /* The repository this example lives in, which is a directory that
           certainly exists and has a `.claude/` of its own. */
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_string_lossy()
            .into_owned()
    });

    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .expect("no home directory in the environment");
    let program = skein_lib::claude::program(std::path::Path::new(&home));
    println!("claude:  {program}");
    println!("cwd:     {cwd}");

    let began = std::time::Instant::now();
    match skein_lib::slash::ask(&program, &cwd) {
        Err(why) => println!("\nfailed after {:?}: {why}", began.elapsed()),
        Ok(found) => {
            println!("\n{} commands in {:?}\n", found.len(), began.elapsed());
            let described = found.iter().filter(|c| !c.description.is_empty()).count();
            let hinted = found.iter().filter(|c| !c.argument_hint.is_empty()).count();
            let aliased = found.iter().filter(|c| !c.aliases.is_empty()).count();
            for c in &found {
                let mut tail = String::new();
                if !c.argument_hint.is_empty() {
                    tail.push_str(&format!("  hint={:?}", c.argument_hint));
                }
                if !c.aliases.is_empty() {
                    tail.push_str(&format!("  aliases={:?}", c.aliases));
                }
                println!("  {:<34}{tail}", c.name);
                if !c.description.is_empty() {
                    println!("      {}", c.description);
                }
            }
            /* The three claims the palette rests on, counted rather than
               assumed — a summary column that is sometimes empty is the thing
               this whole path exists to avoid. */
            println!(
                "\ndescribed {described}/{}, hinted {hinted}, aliased {aliased}",
                found.len()
            );
        }
    }
}
