//! Print a named lab's flyway key phrase and host, read out of the credential
//! vault — for a phone node (`phone-node/examples/`) to dial that lab, since a
//! phone links `flyway-core` and cannot read this machine's vault itself.
//!
//! ```powershell
//! cd src-tauri
//! cargo run --example lab-key -- dev.skein.lab.m5
//! #   phrase=…
//! #   host=lab-m5.<machine>
//! ```

fn main() {
    let mut args = std::env::args().skip(1);
    let identifier = args.next().unwrap_or_else(|| {
        eprintln!("usage: lab-key <identifier>   e.g. dev.skein.lab.m5");
        std::process::exit(1);
    });
    match skein_lib::flyway::key::lab_who(&identifier) {
        Some((phrase, host)) => {
            println!("phrase={phrase}");
            println!("host={host}");
        }
        None => {
            eprintln!("no flyway key held for {identifier} — bring that lab up first");
            std::process::exit(1);
        }
    }
}
