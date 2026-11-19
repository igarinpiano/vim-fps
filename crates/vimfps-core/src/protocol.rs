//! Messages between the browser and the simulation (JSON, tagged by "t").
//! The same messages travel over a WebSocket (CLI host) or through the wasm
//! boundary (practice mode).

use crate::map::{Map, PickupKind};
use crate::math::Vec3;
use crate::weapons::{Gun, Inventory, Slot};
use serde::{Deserialize, Serialize};

/// Bumped whenever a message changes shape. Client and server must agree.
pub const PROTOCOL: u32 = 5;

fn default_bot_skill() -> u8 {
    3
}

fn yes() -> bool {
    true
}

fn default_countdown() -> f32 {
    5.0
}

pub type ClientId = u32;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ClientMsg {
    Join {
        name: String,
        #[serde(default)]
        password: Option<String>,
        protocol: u32,
        /// Join to watch only (no body, not in the match).
        #[serde(default)]
        spectate: bool,
    },
    /// `:watch`: stop playing and watch.
    Watch,
    /// `:play`: from watching back into the match (in a no-respawn match:
    /// from the next round).
    Play,
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
    /// `e`: get into the tank next to you, or out of the one you drive.
    Use,
    Chat {
        text: String,
    },
    Ping {
        id: u32,
        /// The round trip this client measured last (ms): the host shows it
        /// to its admin.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rtt: Option<f32>,
    },
    /// Practice mode only: number of bots.
    Bots {
        n: u32,
    },
    /// Practice mode only: bot skill 1..=5.
    BotSkill {
        level: u8,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RosterEntry {
    pub id: ClientId,
    pub name: String,
    pub kills: u32,
    pub deaths: u32,
    pub bot: bool,
    /// Watching only (joined as a spectator, or `:watch`).
    #[serde(default)]
    pub spectator: bool,
    /// Out of this round (no-respawn match).
    #[serde(default)]
    pub out: bool,
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
    /// Health, sent only to those who are watching.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hp: Option<f32>,
    /// The tank this player drives (they sit inside: no body to see or hit).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tank: Option<u32>,
}

/// A tank on the field (destroyed ones are not listed until they come back).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TankState {
    pub id: u32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    /// Where the hull points.
    pub yaw: f32,
    /// Where the turret points (the driver's view), and the gun's elevation.
    pub aim: f32,
    pub pitch: f32,
    pub hp: f32,
    pub driver: Option<ClientId>,
    /// Loading the next shell: 0..1, or -1 when ready.
    pub reload: f32,
}

/// The ring: outside the circle (x, z, r) everyone loses `dps` health a
/// second. It shrinks in stages toward (nx, nz, nr).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RingState {
    pub x: f32,
    pub z: f32,
    pub r: f32,
    pub nx: f32,
    pub nz: f32,
    pub nr: f32,
    /// Seconds until it starts shrinking (or, while shrinking, until it
    /// stops); -1 once it has reached its last size.
    pub t: f32,
    pub shrinking: bool,
    pub dps: f32,
    pub stage: u32,
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

/// One gun's numbers, as shown by `:spec`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GunSpec {
    pub id: Gun,
    pub name: String,
    pub damage: f32,
    pub head_mult: f32,
    pub pellets: u32,
    /// Rounds per minute.
    pub rpm: f32,
    pub auto: bool,
    pub mag: u32,
    pub reserve_max: u32,
    pub reload: f32,
    pub spread_hip: f32,
    pub spread_ads: f32,
    pub spread_scope: f32,
    pub falloff_start: f32,
    pub falloff_end: f32,
    pub min_factor: f32,
    pub range: f32,
    /// Bullet speed when it leaves the barrel (m/s).
    pub muzzle_velocity: f32,
}

/// Every number a player may want to know, sent with the welcome so the
/// client always shows the rules of the server it plays on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Specs {
    pub guns: Vec<GunSpec>,
    pub hp: f32,
    pub run_speed: f32,
    pub sneak_speed: f32,
    pub accel: f32,
    pub respawn: f32,
    pub protect: f32,
    pub medkit_heal: f32,
    pub medkit_time: f32,
    pub max_medkits: u32,
    pub grenade_fuse: f32,
    pub grenade_radius: f32,
    pub grenade_damage: f32,
    pub max_grenades: u32,
    /// Throw speed (m/s) for power 1..=5.
    pub throw_speeds: Vec<f32>,
    pub head_radius: f32,
    /// m/s² pulling bullets and grenades down.
    pub gravity: f32,
    pub tick_rate: f32,
    pub snap_rate: f32,
    // Tanks.
    #[serde(default)]
    pub tank_hp: f32,
    #[serde(default)]
    pub tank_speed: f32,
    #[serde(default)]
    pub tank_reverse: f32,
    /// Hull turn rate (degrees a second).
    #[serde(default)]
    pub tank_turn: f32,
    /// Share of a bullet's damage that gets through the armour.
    #[serde(default)]
    pub tank_bullet_factor: f32,
    #[serde(default)]
    pub tank_respawn: f32,
    #[serde(default)]
    pub shell_speed: f32,
    #[serde(default)]
    pub shell_reload: f32,
    #[serde(default)]
    pub shell_radius: f32,
    #[serde(default)]
    pub shell_damage: f32,
    // The ring: radius of each stage (metres) and damage a second outside.
    #[serde(default)]
    pub ring_radii: Vec<f32>,
    #[serde(default)]
    pub ring_dps: Vec<f32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Cause {
    Gun(Gun),
    Grenade,
    /// A tank: its shell, or being run over.
    Tank,
    /// Outside the ring for too long.
    Ring,
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
        /// Numbers behind the game, for `:spec`.
        specs: Box<Specs>,
        /// false: a no-respawn match (last one standing wins the round).
        respawn: bool,
        /// The firing range (practice targets, every gun on the rack).
        range: bool,
        /// Joined as a spectator.
        spectator: bool,
        /// Bot skill 1..=5.
        #[serde(default = "default_bot_skill")]
        bot_skill: u8,
        /// The ring is on (a shrinking circle; outside it hurts).
        #[serde(default)]
        ring: bool,
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
        /// None while watching.
        me: Option<MeState>,
        /// Watching (spectator, or out of a no-respawn round).
        #[serde(default)]
        watching: bool,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tanks: Vec<TankState>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ring: Option<RingState>,
        /// Waiting for the host's admin to start the match (no one is on
        /// the field; everyone watches).
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        lobby: bool,
        /// Seconds until the match the admin started begins.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        countdown: Option<f32>,
        /// After these results, back to the waiting room (the admin may
        /// turn "next match by itself" on or off meanwhile).
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        to_lobby: bool,
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
        /// Where the bullet will hit the world (players aside).
        to: Vec3,
        /// Its initial velocity: the client draws the same falling arc.
        /// (Older clients ignore it and draw a straight line.)
        #[serde(default)]
        vel: Vec3,
        gun: Gun,
    },
    /// A tank fired: the shell flies the arc from `from` at `vel` and bursts
    /// at `to` (or earlier, on whoever it meets: an `Explode` says where).
    Shell {
        id: ClientId,
        from: Vec3,
        to: Vec3,
        vel: Vec3,
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
        /// Metres between killer and victim (0 for a suicide). Clients that
        /// predate it ignore it, so the protocol number stays.
        #[serde(default)]
        dist: f32,
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
        /// After the results: back to the waiting room (the admin starts
        /// the next match), not straight into the next match.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        to_lobby: bool,
    },
    /// A match began: its rules (the admin may have changed them).
    MatchStart {
        #[serde(default = "yes")]
        respawn: bool,
        #[serde(default)]
        ring: bool,
        #[serde(default)]
        time_limit: f32,
        #[serde(default)]
        frag_limit: u32,
        #[serde(default = "default_bot_skill")]
        bot_skill: u8,
    },
    Pong {
        id: u32,
    },
}

// ---------------------------------------------------------------- admin
//
// The host's admin does not play: they watch everything and run the
// matches, from the admin page (`/admin.html`, with a key) or the host's
// terminal. Players have no message that starts, ends or changes a match.

/// The rules of a match that the admin may change. They take effect when
/// the next match starts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MatchSettings {
    /// Minutes.
    pub time_limit: f32,
    pub frag_limit: u32,
    pub bots: u32,
    pub bot_skill: u8,
    pub respawn: bool,
    pub ring: bool,
    pub tanks: bool,
}

/// From the admin page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum AdminMsg {
    /// First message: the admin key.
    Hello { key: String },
    /// Start the match after `countdown` seconds (from the waiting room or
    /// the result screen).
    Start {
        #[serde(default = "default_countdown")]
        countdown: f32,
    },
    /// Call off the countdown.
    Cancel,
    /// End the match now (results, then the waiting room).
    End,
    /// Back to the waiting room at once (no results).
    Lobby,
    /// Rules of the next match.
    Settings { settings: MatchSettings },
    /// Go on to the next match by itself after the results.
    Auto { on: bool },
    /// The number of bots, at once.
    Bots { n: u32 },
    /// One bot's skill 1..=5, at once (None: the room's skill).
    BotLevel {
        id: ClientId,
        #[serde(default)]
        level: Option<u8>,
    },
    /// Disconnect a player.
    Kick { id: ClientId },
    /// Move a player to the spectators.
    Spectate { id: ClientId },
    /// A message to everyone, from the admin.
    Say { text: String },
    /// A command line, as typed into the host's terminal (`start 5`,
    /// `set time=5`, `status` ...).
    Command { line: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Waiting for the admin to start.
    Lobby,
    /// Started: counting down.
    Countdown,
    Live,
    /// The result screen after a match.
    Results,
}

/// What anyone may know about the host's match (`/match.json`): a page
/// practising offline watches it to join when the admin starts a match.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MatchStatus {
    pub phase: Phase,
    /// Seconds until the match starts (counting down).
    pub countdown: Option<f32>,
    /// Seconds left in the match.
    pub left: f32,
    /// People in the match (not bots, not spectators).
    pub players: u32,
    /// Matches wait for an admin.
    pub managed: bool,
}

/// Everything about one player, for the admin.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AdminPlayer {
    pub id: ClientId,
    pub name: String,
    pub bot: bool,
    pub spectator: bool,
    pub out: bool,
    pub alive: bool,
    pub hp: f32,
    pub kills: u32,
    pub deaths: u32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub yaw: f32,
    pub pitch: f32,
    pub sneak: bool,
    pub ads: bool,
    /// 0 hip, 1 ADS, 2 scope.
    pub zoom: u8,
    pub gun: Option<Gun>,
    pub tank: Option<u32>,
    /// Seconds until respawn while dead.
    pub respawn: f32,
    /// Round trip to the host (ms), measured by the host. None for bots.
    #[serde(default)]
    pub ping: Option<f32>,
    /// A bot's skill 1..=5 (None for people).
    #[serde(default)]
    pub level: Option<u8>,
    /// The bot has a skill of its own (not the room's).
    #[serde(default)]
    pub own_level: bool,
}

/// The whole match at a glance, sent to admins 20 times a second.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AdminState {
    pub phase: Phase,
    /// Seconds left in the match.
    pub left: f32,
    pub countdown: Option<f32>,
    pub intermission: Option<f32>,
    /// Next match starts by itself after the results.
    pub auto: bool,
    /// Rules of the match being played (or the last one).
    pub settings: MatchSettings,
    /// Rules of the next match.
    pub next: MatchSettings,
    /// Ranked as in the match.
    pub players: Vec<AdminPlayer>,
    pub tanks: Vec<TankState>,
    pub grenades: Vec<GrenadeState>,
    pub ring: Option<RingState>,
}

/// To the admin page (besides every message sent to all players).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum AdminOut {
    AdminWelcome {
        /// Who this key belongs to.
        name: String,
        server: String,
        version: String,
        map: Box<Map>,
        specs: Box<Specs>,
    },
    AdminState {
        #[serde(flatten)]
        state: Box<AdminState>,
    },
    AdminReply {
        ok: bool,
        text: String,
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

    #[test]
    fn admin_json_shape() {
        let m: AdminMsg = serde_json::from_str(r#"{"t":"start"}"#).unwrap();
        assert_eq!(m, AdminMsg::Start { countdown: 5.0 });
        let m: AdminMsg = serde_json::from_str(r#"{"t":"kick","id":3}"#).unwrap();
        assert_eq!(m, AdminMsg::Kick { id: 3 });
        // A bare match_start (older shape) still reads.
        let s: ServerMsg = serde_json::from_str(r#"{"t":"match_start"}"#).unwrap();
        assert!(matches!(s, ServerMsg::MatchStart { respawn: true, .. }));
    }
}
