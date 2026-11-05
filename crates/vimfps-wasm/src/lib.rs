//! Practice mode in the browser: the same `Room` as the CLI host, behind a
//! tiny C ABI (no wasm-bindgen needed).
//!
//! JS side: `vf_new(seed, bots)`, then write a JSON `ClientMsg` into the
//! buffer returned by `vf_in(len)` and call `vf_send(len)`; `vf_tick(dt)`
//! advances the game and returns the length of a JSON array of `ServerMsg`
//! for the local player, readable at `vf_out()`.

use std::cell::RefCell;
use vimfps_core::{ClientId, ClientMsg, Config, Room, ServerMsg, Target};

struct State {
    room: Room,
    me: Option<ClientId>,
    pending: Vec<ServerMsg>,
    inbuf: Vec<u8>,
    outbuf: Vec<u8>,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
    static INBUF: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// Starts a new practice room.
#[unsafe(no_mangle)]
pub extern "C" fn vf_new(seed: u32, bots: u32) {
    let cfg = Config {
        seed: seed as u64,
        practice: true,
        bots,
        max_players: 1,
        ..Default::default()
    };
    STATE.with(|s| {
        *s.borrow_mut() = Some(State {
            room: Room::new(cfg),
            me: None,
            pending: Vec::new(),
            inbuf: Vec::new(),
            outbuf: Vec::new(),
        })
    });
}

/// Starts a practice room with options: mode bit 1 = firing range,
/// bit 2 = no respawn (last one standing).
#[unsafe(no_mangle)]
pub extern "C" fn vf_new_mode(seed: u32, bots: u32, mode: u32) {
    let cfg = Config {
        seed: seed as u64,
        practice: true,
        bots,
        max_players: 1,
        range: mode & 1 != 0,
        respawn: mode & 2 == 0,
        ..Default::default()
    };
    STATE.with(|s| {
        *s.borrow_mut() = Some(State {
            room: Room::new(cfg),
            me: None,
            pending: Vec::new(),
            inbuf: Vec::new(),
            outbuf: Vec::new(),
        })
    });
}

/// A custom practice match: mode bits as `vf_new_mode`, bot skill 1..=5,
/// match length (seconds) and kills to win (0: no limit).
#[unsafe(no_mangle)]
pub extern "C" fn vf_new_custom(
    seed: u32,
    bots: u32,
    mode: u32,
    skill: u32,
    time_limit: u32,
    frag_limit: u32,
) {
    let cfg = Config {
        seed: seed as u64,
        practice: true,
        bots,
        max_players: 1,
        range: mode & 1 != 0,
        respawn: mode & 2 == 0,
        bot_skill: skill.clamp(1, 5) as u8,
        time_limit: time_limit.max(30) as f32,
        frag_limit: if frag_limit == 0 {
            u32::MAX
        } else {
            frag_limit
        },
        ..Default::default()
    };
    STATE.with(|s| {
        *s.borrow_mut() = Some(State {
            room: Room::new(cfg),
            me: None,
            pending: Vec::new(),
            inbuf: Vec::new(),
            outbuf: Vec::new(),
        })
    });
}

/// Buffer of `len` bytes for the next `vf_send`.
#[unsafe(no_mangle)]
pub extern "C" fn vf_in(len: usize) -> *mut u8 {
    INBUF.with(|b| {
        let mut b = b.borrow_mut();
        b.clear();
        b.resize(len, 0);
        b.as_mut_ptr()
    })
}

/// Delivers the message written into the `vf_in` buffer.
#[unsafe(no_mangle)]
pub extern "C" fn vf_send(len: usize) {
    let bytes = INBUF.with(|b| {
        let b = b.borrow();
        b[..len.min(b.len())].to_vec()
    });
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let Some(st) = s.as_mut() else { return };
        st.inbuf = bytes;
        let Ok(msg) = serde_json::from_slice::<ClientMsg>(&st.inbuf) else {
            return;
        };
        match (msg, st.me) {
            (
                ClientMsg::Join {
                    name,
                    password,
                    protocol,
                    spectate,
                },
                None,
            ) => match st.room.join(&name, password.as_deref(), protocol, spectate) {
                Ok(id) => st.me = Some(id),
                Err(text) => st.pending.push(ServerMsg::Error { text }),
            },
            (ClientMsg::Join { .. }, Some(_)) => {}
            (m, Some(id)) => st.room.handle(id, m),
            (_, None) => {}
        }
    });
}

/// Advances the game by `dt` seconds. Returns the length of the output.
#[unsafe(no_mangle)]
pub extern "C" fn vf_tick(dt: f32) -> usize {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let Some(st) = s.as_mut() else { return 0 };
        st.room.tick(dt);
        let me = st.me;
        let mut msgs = std::mem::take(&mut st.pending);
        for (to, m) in st.room.drain() {
            if to == Target::All || Some(to) == me.map(Target::One) {
                msgs.push(m);
            }
        }
        st.outbuf = serde_json::to_vec(&msgs).unwrap_or_else(|_| b"[]".to_vec());
        st.outbuf.len()
    })
}

/// The game's numbers (`:spec` before joining). Returns the length of the
/// JSON written to the output buffer (`vf_out`).
#[unsafe(no_mangle)]
pub extern "C" fn vf_specs() -> usize {
    let json = serde_json::to_vec(&vimfps_core::protocol::Specs::current()).unwrap_or_default();
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        if s.is_none() {
            *s = Some(State {
                room: Room::new(Config {
                    practice: true,
                    max_players: 1,
                    ..Default::default()
                }),
                me: None,
                pending: Vec::new(),
                inbuf: Vec::new(),
                outbuf: Vec::new(),
            });
        }
        let st = s.as_mut().unwrap();
        st.outbuf = json;
        st.outbuf.len()
    })
}

/// The output of the last `vf_tick`.
#[unsafe(no_mangle)]
pub extern "C" fn vf_out() -> *const u8 {
    STATE.with(|s| {
        s.borrow()
            .as_ref()
            .map_or(std::ptr::null(), |st| st.outbuf.as_ptr())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn send(json: &str) {
        let p = vf_in(json.len());
        unsafe { std::ptr::copy_nonoverlapping(json.as_ptr(), p, json.len()) };
        vf_send(json.len());
    }

    fn tick() -> Vec<serde_json::Value> {
        let n = vf_tick(1.0 / 60.0);
        let out = unsafe { std::slice::from_raw_parts(vf_out(), n) };
        serde_json::from_slice(out).unwrap()
    }

    #[test]
    fn practice_round_trip() {
        vf_new(9, 3);
        send(&format!(
            r#"{{"t":"join","name":"me","protocol":{}}}"#,
            vimfps_core::PROTOCOL
        ));
        let first = tick();
        assert!(first.iter().any(|m| m["t"] == "welcome"));
        send(
            r#"{"t":"input","mx":0,"mz":1,"sneak":false,"yaw":0,"pitch":0,"ads":false,"fire":false}"#,
        );
        let mut snaps = 0;
        for _ in 0..10 {
            snaps += tick().iter().filter(|m| m["t"] == "snap").count();
        }
        assert!(snaps >= 2);
    }
}
