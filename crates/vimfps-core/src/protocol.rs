//! Messages between the browser and the simulation (JSON, tagged by "t").
//! The same messages travel over a WebSocket (CLI host) or through the wasm
//! boundary (practice mode).

use crate::map::{Map, PickupKind};
use crate::math::Vec3;
use crate::weapons::{Gun, Inventory, Slot};
use serde::{Deserialize, Serialize};

/// Bumped whenever a message changes shape. Client and server must agree.
pub const PROTOCOL: u32 = 1;

pub type ClientId = u32;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ClientMsg {
    Join {
        name: String,
        #[serde(default)]
        password: Option<String>,
        protocol: u32,
    },
    /// Held state, sent whenever it changes and a few times a second.
    Input {
        /// -1, 0 or 1: left/right.
        mx: i8,
        /// -1, 0 or 1: back/forward.
        mz: i8,
        sneak: bool,
        yaw: f32,
        pitch: f32,
        /// VIEW mode (aiming down sights); the player cannot walk.
        ads: bool,
        /// 0 = hip, 1 = ADS, 2 = scope.
        #[serde(default)]
        zoom: u8,
        /// `f` held down (automatic guns keep firing).
        fire: bool,
        /// No acceleration: velocity changes at once (`:set nomoveaccel`).
        #[serde(default)]
        instant: bool,
    },
    /// `f` pressed: one shot, or use the selected item.
    Trigger,
    Reload,
    /// `{count}dd`
    Throw {
        power: u32,
    },
    Select {
        slot: Slot,
    },
    /// `y`: pick up the gun at your feet.
    Pickup,
    Chat {
        text: String,
    },
    Ping {
        id: u32,
    },
    /// Practice mode only: number of bots.
    Bots {
        n: u32,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RosterEntry {
    pub id: ClientId,
    pub name: String,
    pub kills: u32,
    pub deaths: u32,
    pub bot: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlayerState {
    pub id: ClientId,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub yaw: f32,
    pub pitch: f32,
    pub alive: bool,
    pub sneak: bool,
    pub ads: bool,
    /// Walking (for footstep sounds).
    pub mv: bool,
    pub gun: Option<Gun>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeState {
    pub hp: f32,
    pub inv: Inventory,
    /// Reload progress 0..1, or -1 when not reloading.
    pub reload: f32,
    /// Medkit progress 0..1, or -1.
    pub heal: f32,
    pub protect: bool,
    /// Seconds until respawn while dead.
    pub respawn: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GrenadeState {
    pub id: u32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PickupState {
    pub id: u32,
    pub kind: PickupKind,
    pub x: f32,
    pub z: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Cause {
    Gun(Gun),
    Grenade,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ServerMsg {
    Welcome {
        id: ClientId,
        version: String,
        protocol: u32,
        map: Box<Map>,
        time_limit: f32,
        frag_limit: u32,
        practice: bool,
    },
    Error {
        text: String,
    },
    Snap {
        /// Seconds left in the match.
        left: f32,
        /// Seconds until the next match during the result screen.
        intermission: Option<f32>,
        players: Vec<PlayerState>,
        grenades: Vec<GrenadeState>,
        me: Option<MeState>,
    },
    Roster {
        players: Vec<RosterEntry>,
    },
    Pickups {
        list: Vec<PickupState>,
    },
    Shot {
        id: ClientId,
        from: Vec3,
        to: Vec3,
        gun: Gun,
    },
    Hit {
        attacker: ClientId,
        victim: ClientId,
        head: bool,
        dmg: f32,
        from: Vec3,
    },
    Kill {
        killer: ClientId,
        victim: ClientId,
        cause: Cause,
        head: bool,
    },
    Explode {
        pos: Vec3,
    },
    Chat {
        from: ClientId,
        name: String,
        text: String,
    },
    Respawn {
        pos: Vec3,
        yaw: f32,
    },
    Item {
        text: String,
    },
    Sys {
        text: String,
    },
    MatchEnd {
        ranking: Vec<RosterEntry>,
        next_in: f32,
    },
    MatchStart,
    Pong {
        id: u32,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_json_shape() {
        let m: ClientMsg = serde_json::from_str(
            r#"{"t":"input","mx":1,"mz":0,"sneak":false,"yaw":0.5,"pitch":0,"ads":false,"fire":true}"#,
        )
        .unwrap();
        assert!(matches!(
            m,
            ClientMsg::Input {
                mx: 1,
                fire: true,
                instant: false,
                ..
            }
        ));
        let t: ClientMsg = serde_json::from_str(r#"{"t":"throw","power":4}"#).unwrap();
        assert_eq!(t, ClientMsg::Throw { power: 4 });
        let s: ClientMsg = serde_json::from_str(r#"{"t":"select","slot":"medkit"}"#).unwrap();
        assert_eq!(s, ClientMsg::Select { slot: Slot::Medkit });
    }
}
