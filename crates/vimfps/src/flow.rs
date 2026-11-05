//! Progress of a few steps (uninstall, macOS network setup) as a flow of
//! circles joined by a line.

use std::io::Write;

/// The steps as a flow of circles joined by a line; each step's ○ turns
/// into ● when it is done (× when it fails):
///
/// ```text
/// ● Deleting /home/a/.local/bin/vimfps... done
/// │
/// ● Thank you for using vim-fps!
/// ```
pub struct Flow {
    tty: bool,
    started: bool,
}

impl Flow {
    pub fn new() -> Self {
        use std::io::IsTerminal;
        Flow {
            tty: std::io::stdout().is_terminal(),
            started: false,
        }
    }

    fn join(&mut self) {
        if self.started {
            println!("│");
        }
        self.started = true;
    }

    /// Runs one step. `Ok(Some(why))` = skipped.
    pub fn step(
        &mut self,
        label: &str,
        f: impl FnOnce() -> Result<Option<&'static str>, String>,
    ) -> Result<(), String> {
        self.join();
        // `\r` can only redraw a line that did not wrap.
        let redraw = self.tty && label.chars().count() + 16 < term_width();
        if redraw {
            print!("○ {label}...");
            let _ = std::io::stdout().flush();
            // Long enough to see each step complete.
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        let r = f();
        let line = flow_line(label, &r);
        if redraw {
            println!("\r{line}");
        } else {
            println!("{line}");
        }
        r.map(|_| ())
    }

    pub fn finish(&mut self, text: &str) {
        self.join();
        println!("● {text}");
    }
}

pub fn flow_line(label: &str, r: &Result<Option<&str>, String>) -> String {
    match r {
        Ok(None) => format!("● {label}... done"),
        Ok(Some(why)) => format!("● {label}... skipped ({why})"),
        Err(e) => format!("× {label}... failed: {e}"),
    }
}

fn term_width() -> usize {
    std::env::var("COLUMNS")
        .ok()
        .and_then(|c| c.parse().ok())
        .unwrap_or(80)
}
