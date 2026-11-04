//! Records the target triple (the self-updater downloads the matching
//! release archive) and rebuilds when the embedded web client changes.
use std::path::Path;

fn main() {
    let target = std::env::var("TARGET").unwrap_or_default();
    println!("cargo:rustc-env=VIMFPS_TARGET={target}");
    let web = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web");
    println!("cargo:rerun-if-changed={}", web.display());
    for sub in ["js", "pkg", "vendor"] {
        println!("cargo:rerun-if-changed={}", web.join(sub).display());
    }
    if !web.join("pkg/vimfps.wasm").exists() {
        println!(
            "cargo:warning=web/pkg/vimfps.wasm is missing: run scripts/build-wasm.sh first (practice mode will be unavailable)"
        );
    }
}
