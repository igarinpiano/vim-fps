//! vim-fps game core: map, weapons, protocol and the authoritative
//! simulation. Used natively by the CLI host and compiled to wasm for the
//! browser's practice mode, so both run the very same rules.

pub mod map;
pub mod math;
pub mod protocol;
pub mod rng;
pub mod sim;
pub mod weapons;

pub use protocol::{ClientId, ClientMsg, PROTOCOL, ServerMsg};
pub use sim::{Config, Room, Target};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
