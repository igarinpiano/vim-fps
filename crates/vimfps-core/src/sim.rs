//! The authoritative game: a free-for-all deathmatch room. Transport-free:
//! feed it messages and time, collect what it wants to send.

use crate::map::{Map, PickupKind};
use crate::math::{Aabb, Vec3, ray_sphere, wrap_angle};
use crate::protocol::*;
use crate::rng::Rng;
use crate::weapons::*;
use std::collections::BTreeMap;

pub const TICK_RATE: f32 = 60.0;
pub const SNAP_RATE: f32 = 20.0;
pub const RUN_SPEED: f32 = 6.0;
pub const SNEAK_SPEED: f32 = 2.6;
pub const ACCEL: f32 = 40.0;
pub const RESPAWN_TIME: f32 = 3.0;
pub const PROTECT_TIME: f32 = 3.0;
/// A spawn point in sight of someone alive this close is avoided.
pub const SPAWN_SIGHT: f32 = 250.0;
/// Bots use a medkit below this much health (when no enemy is in sight),
/// and go for one lying nearby below BOT_SEEK_MEDKIT with none on them.
pub const BOT_HEAL_BELOW: f32 = 70.0;
pub const BOT_SEEK_MEDKIT: f32 = 60.0;
pub const INTERMISSION: f32 = 10.0;
pub const MAX_HP: f32 = 100.0;
pub const NAME_MAX: usize = 16;
pub const CHAT_MAX: usize = 120;
pub const WEAPON_RESPAWN: f32 = 30.0;
pub const ITEM_RESPAWN: f32 = 20.0;
pub const DROP_TTL: f32 = 30.0;
pub const MAX_BOTS: u32 = 15;
/// Bots see enemies this far (with a clear line of sight).
pub const BOT_SIGHT: f32 = 150.0;
/// Bots hear gunshots this far, and running footsteps within BOT_FOOTSTEPS.
pub const BOT_HEARING: f32 = 120.0;
pub const BOT_FOOTSTEPS: f32 = 22.0;

pub const HEAD_RADIUS: f32 = 0.25;
/// Standard gravity (m/s²): bullets and grenades fall at this rate.
pub const GRAVITY: f32 = 9.81;
/// Bullets live at most this long (seconds).
pub const BULLET_LIFE: f32 = 3.0;

// ---- tanks ----
pub const TANK_HP: f32 = 400.0;
/// Forward and reverse speed (m/s), acceleration (m/s²), hull turn (rad/s).
pub const TANK_SPEED: f32 = 9.0;
pub const TANK_REVERSE: f32 = 4.0;
pub const TANK_ACCEL: f32 = 6.0;
pub const TANK_TURN: f32 = 0.9;
/// Collision radius and height of a tank.
pub const TANK_RADIUS: f32 = 2.0;
pub const TANK_HEIGHT: f32 = 2.4;
/// The driver looks out from this high above the ground.
pub const TANK_EYE: f32 = 2.6;
/// `e` gets you in from this close (to the tank's centre).
pub const TANK_ENTER: f32 = 4.5;
/// A destroyed tank is back at its parking spot after this long.
pub const TANK_RESPAWN: f32 = 45.0;
/// Bullets do this share of their damage to a tank.
pub const TANK_BULLET_FACTOR: f32 = 0.15;
/// The gun's elevation limits (radians).
pub const TANK_PITCH: (f32, f32) = (-0.17, 0.5);
/// Being run over by a tank moving at least TANK_RAM_SPEED.
pub const TANK_RAM_DAMAGE: f32 = 200.0;
pub const TANK_RAM_SPEED: f32 = 3.0;
/// A destroyed tank blows up.
pub const TANK_BLAST_RADIUS: f32 = 6.0;
pub const TANK_BLAST_DAMAGE: f32 = 80.0;
pub const SHELL_SPEED: f32 = 200.0;
pub const SHELL_RELOAD: f32 = 3.0;
pub const SHELL_RADIUS: f32 = 6.0;
pub const SHELL_DAMAGE: f32 = 150.0;
/// Extra damage to a tank the shell hits squarely.
pub const SHELL_DIRECT: f32 = 100.0;

// ---- the ring ----
/// Radius after each stage, as a share of the field's half side.
pub const RING_RADII: [f32; 5] = [0.9, 0.6, 0.38, 0.24, 0.15];
/// Health lost per second outside, by stage (the last one from then on).
pub const RING_DPS: [f32; 6] = [2.0, 3.0, 5.0, 8.0, 12.0, 15.0];
/// Before the first stage the ring holds the whole field.
pub const RING_START: f32 = 1.45;

/// Where a bullet fired at `vel` from `from` is after `t` seconds (no air
/// resistance: v·t + ½·g·t²).
pub fn ballistic(from: Vec3, vel: Vec3, t: f32) -> Vec3 {
    from + vel * t + Vec3::new(0.0, -0.5 * GRAVITY * t * t, 0.0)
}

/// How far below the line of sight a bullet is after `distance` metres
/// (fired horizontally at `speed` m/s).
pub fn drop_at(distance: f32, speed: f32) -> f32 {
    let t = distance / speed;
    0.5 * GRAVITY * t * t
}

/// Grenade speed (m/s) for `{power}dd`.
pub fn throw_speed(power: u32) -> f32 {
    6.0 + 3.5 * power as f32
}

impl Specs {
    pub fn current() -> Specs {
        Specs {
            guns: Gun::ALL
                .iter()
                .map(|&g| {
                    let s = g.stats();
                    GunSpec {
                        id: g,
                        name: s.name.into(),
                        damage: s.damage,
                        head_mult: s.head_mult,
                        pellets: s.pellets,
                        rpm: (60.0 / s.interval).round(),
                        auto: s.auto,
                        mag: s.mag,
                        reserve_max: s.reserve_max,
                        reload: s.reload,
                        spread_hip: s.spread_hip,
                        spread_ads: s.spread_ads,
                        spread_scope: s.spread_scope,
                        falloff_start: s.falloff.0,
                        falloff_end: s.falloff.1,
                        min_factor: s.min_factor,
                        range: s.range,
                        muzzle_velocity: s.muzzle_velocity,
                    }
                })
                .collect(),
            hp: MAX_HP,
            run_speed: RUN_SPEED,
            sneak_speed: SNEAK_SPEED,
            accel: ACCEL,
            respawn: RESPAWN_TIME,
            protect: PROTECT_TIME,
            medkit_heal: MEDKIT_HEAL,
            medkit_time: MEDKIT_TIME,
            max_medkits: MAX_MEDKITS,
            grenade_fuse: GRENADE_FUSE,
            grenade_radius: GRENADE_RADIUS,
            grenade_damage: GRENADE_DAMAGE,
            max_grenades: MAX_GRENADES,
            throw_speeds: (1..=MAX_THROW).map(throw_speed).collect(),
            head_radius: HEAD_RADIUS,
            gravity: GRAVITY,
            tick_rate: TICK_RATE,
            snap_rate: SNAP_RATE,
            tank_hp: TANK_HP,
            tank_speed: TANK_SPEED,
            tank_reverse: TANK_REVERSE,
            tank_turn: TANK_TURN.to_degrees().round(),
            tank_bullet_factor: TANK_BULLET_FACTOR,
            tank_respawn: TANK_RESPAWN,
            shell_speed: SHELL_SPEED,
            shell_reload: SHELL_RELOAD,
            shell_radius: SHELL_RADIUS,
            shell_damage: SHELL_DAMAGE,
            ring_radii: RING_RADII
                .iter()
                .map(|k| (k * crate::map::HALF).round())
                .collect(),
            ring_dps: RING_DPS.to_vec(),
        }
    }
}

pub fn eye_height(sneak: bool) -> f32 {
    if sneak { 1.15 } else { 1.6 }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub seed: u64,
    /// Seconds per match.
    pub time_limit: f32,
    pub frag_limit: u32,
    /// Humans (bots do not count).
    pub max_players: usize,
    pub password: Option<String>,
    /// Practice mode (browser): bots may be changed with `:bots`.
    pub practice: bool,
    pub bots: u32,
    /// false: no respawn. A round ends when one player is left standing;
    /// the fallen watch (by default through their killer's eyes).
    pub respawn: bool,
    /// The firing range (practice targets on a long field).
    pub range: bool,
    /// How good the bots are, 1 (very weak) ..= 5 (very strong).
    pub bot_skill: u8,
    /// The ring: a circle that shrinks in stages; outside it hurts.
    pub ring: bool,
    /// Tanks parked on the field.
    pub tanks: bool,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            seed: 1,
            time_limit: 600.0,
            frag_limit: 25,
            max_players: 12,
            password: None,
            practice: false,
            bots: 0,
            respawn: true,
            range: false,
            bot_skill: 3,
            ring: true,
            tanks: true,
        }
    }
}

pub const BOT_SKILL_NAMES: [&str; 5] = ["とても弱い", "弱い", "普通", "強い", "とても強い"];

/// What a bot skill level means.
#[derive(Debug, Clone, Copy)]
pub struct BotSkill {
    /// How far it sees (m).
    pub sight: f32,
    /// Seconds before it fires at a new target (plus distance / 250).
    pub reaction: f32,
    /// Aim error multiplier (1 = normal).
    pub aim_error: f32,
    /// How fast it turns (rad/s).
    pub turn: f32,
    /// Leads moving targets and aims over the bullet drop.
    pub lead: bool,
    /// Goes for an empty tank from this far (m), and how often it sets out
    /// for one from anywhere on the field (share of its wanderings).
    pub tank_reach: f32,
    pub tank_chance: f32,
    /// Fights with its head: gets into a tank standing near a fight, takes
    /// cover behind one when hurt, holds still to heal, throws grenades at
    /// tanks.
    pub tactics: bool,
    /// Sees that a wall stands between it and where it is going, and plans
    /// the way round (out through the door) before walking. Without this it
    /// walks straight at the goal and finds the way only after bumping into
    /// something for a while.
    pub plans: bool,
}

pub fn bot_skill(level: u8) -> BotSkill {
    match level.clamp(1, 5) {
        1 => BotSkill {
            sight: 70.0,
            reaction: 0.9,
            aim_error: 2.4,
            turn: 1.6,
            lead: false,
            tank_reach: 30.0,
            tank_chance: 0.3,
            tactics: false,
            plans: false,
        },
        2 => BotSkill {
            sight: 110.0,
            reaction: 0.6,
            aim_error: 1.6,
            turn: 2.2,
            lead: false,
            tank_reach: 30.0,
            tank_chance: 0.3,
            tactics: false,
            plans: false,
        },
        3 => BotSkill {
            sight: BOT_SIGHT,
            reaction: 0.35,
            aim_error: 1.0,
            turn: 2.8,
            lead: false,
            tank_reach: 30.0,
            tank_chance: 0.3,
            tactics: false,
            plans: true,
        },
        4 => BotSkill {
            sight: 170.0,
            reaction: 0.25,
            aim_error: 0.6,
            turn: 3.6,
            lead: true,
            tank_reach: 60.0,
            tank_chance: 0.6,
            tactics: true,
            plans: true,
        },
        _ => BotSkill {
            sight: 200.0,
            reaction: 0.15,
            aim_error: 0.3,
            turn: 4.8,
            lead: true,
            tank_reach: 90.0,
            tank_chance: 0.8,
            tactics: true,
            plans: true,
        },
    }
}

/// Firing range: dummies come back this fast, and so does everything on
/// the rack.
pub const RANGE_RESPAWN: f32 = 1.0;
/// How many spectators may watch at once (on top of max_players).
pub const MAX_SPECTATORS: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    All,
    One(ClientId),
}

#[derive(Debug, Clone, Default)]
struct InputState {
    mx: i8,
    mz: i8,
    sneak: bool,
    ads: bool,
    zoom: u8,
    fire: bool,
    instant: bool,
}

#[derive(Debug, Clone)]
struct Bot {
    waypoint: Vec3,
    wander_timer: f32,
    target: Option<ClientId>,
    reaction: f32,
    aim_err: (f32, f32),
    err_timer: f32,
    last_pos: Vec3,
    stuck_timer: f32,
    /// How many checks in a row it has not moved (a stuck tank is left).
    stuck_n: u8,
    /// No getting into a tank for this long (it just left one, or could not
    /// reach one).
    no_tank: f32,
    /// Stuck on the way somewhere: go by the waypoint for this long.
    detour: f32,
    /// The walking route (nav.rs) it follows: corners still ahead, and the
    /// goal they lead to.
    path: Vec<Vec3>,
    path_to: Vec3,
    /// Until it next checks whether the straight way is blocked.
    path_check: f32,
    /// No route found: no new try for this long.
    path_fail: f32,
    /// Plan a route at the next chance (it got stuck).
    replan: bool,
    /// Hurt, it went behind a tank: that spot, and how much longer to stay
    /// there once the enemy is out of sight (strong bots).
    cover: Option<(Vec3, f32)>,
    /// Until the next grenade may be thrown.
    throw_cd: f32,
    /// Where a shot was heard, and for how much longer it is interesting.
    heard: Option<(Vec3, f32)>,
    /// Firing-range dummy: stands at `home` (strafing ±strafe m) and never
    /// shoots.
    dummy: Option<(Vec3, f32)>,
}

#[derive(Debug, Clone)]
struct Player {
    id: ClientId,
    name: String,
    bot: Option<Bot>,
    pos: Vec3,
    vel: Vec3,
    yaw: f32,
    pitch: f32,
    input: InputState,
    hp: f32,
    alive: bool,
    respawn: f32,
    protect: f32,
    inv: Inventory,
    cooldown: f32,
    reload: Option<f32>,
    heal: Option<f32>,
    trigger: f32,
    kills: u32,
    deaths: u32,
    chat_budget: f32,
    /// Watching only: joined as a spectator or `:watch`.
    spectator: bool,
    /// Out of the current no-respawn round (watching until the next).
    out: bool,
    /// When it went out (match clock), for the round's ranking.
    out_at: f32,
    /// The tank it drives.
    tank: Option<u32>,
}

impl Player {
    fn watching(&self) -> bool {
        self.spectator || self.out
    }
}

#[derive(Debug, Clone)]
struct Pickup {
    id: u32,
    kind: PickupKind,
    pos: Vec3,
    active: bool,
    timer: f32,
    /// Dropped guns keep their ammunition and disappear after a while.
    dropped: Option<GunSlot>,
}

/// A bullet in flight.
#[derive(Debug, Clone)]
struct Bullet {
    owner: ClientId,
    gun: Gun,
    /// Where it was fired from (the victim's hit direction).
    origin: Vec3,
    pos: Vec3,
    vel: Vec3,
    /// Path length so far (damage falloff and range).
    traveled: f32,
    age: f32,
}

#[derive(Debug, Clone)]
struct Tank {
    id: u32,
    /// Where it is parked at the start (and comes back to).
    home: Vec3,
    pos: Vec3,
    /// Hull heading; the turret follows the driver's view (`aim`, `pitch`).
    yaw: f32,
    aim: f32,
    pitch: f32,
    /// Along the hull: + forward, - reverse (m/s).
    speed: f32,
    hp: f32,
    alive: bool,
    respawn: f32,
    driver: Option<ClientId>,
    cooldown: f32,
}

/// A tank shell in flight.
#[derive(Debug, Clone)]
struct Shell {
    owner: ClientId,
    tank: u32,
    pos: Vec3,
    vel: Vec3,
    age: f32,
}

/// The ring: the circle now (`c`, `r`), and the stage it is heading for.
#[derive(Debug, Clone)]
struct Ring {
    c: (f32, f32),
    r: f32,
    from_c: (f32, f32),
    from_r: f32,
    to_c: (f32, f32),
    to_r: f32,
    /// Stages finished so far.
    stage: usize,
    /// Until the shrink starts (or, while shrinking, ends).
    timer: f32,
    shrinking: bool,
    /// Length of a wait and of a shrink (s).
    unit: f32,
    /// Damage is dealt in steps of half a second.
    acc: f32,
}

/// What a bullet or shell met.
#[derive(Debug, Clone, Copy)]
enum Struck {
    Player(ClientId, bool),
    Tank(usize),
}

#[derive(Debug, Clone)]
struct Grenade {
    id: u32,
    owner: ClientId,
    pos: Vec3,
    vel: Vec3,
    fuse: f32,
}

pub struct Room {
    pub cfg: Config,
    pub map: Map,
    rng: Rng,
    players: BTreeMap<ClientId, Player>,
    next_id: ClientId,
    next_obj: u32,
    pickups: Vec<Pickup>,
    pickups_dirty: bool,
    roster_dirty: bool,
    grenades: Vec<Grenade>,
    bullets: Vec<Bullet>,
    tanks: Vec<Tank>,
    shells: Vec<Shell>,
    ring: Option<Ring>,
    left: f32,
    intermission: Option<f32>,
    snap_acc: f32,
    out: Vec<(Target, ServerMsg)>,
    bots_wanted: u32,
    /// Walking routes for bots (built from the map on first use).
    nav: std::sync::OnceLock<crate::nav::NavGrid>,
}

fn gun_of(kind: PickupKind) -> Option<Gun> {
    match kind {
        PickupKind::Ar => Some(Gun::Ar),
        PickupKind::Smg => Some(Gun::Smg),
        PickupKind::Sg => Some(Gun::Sg),
        PickupKind::Sr => Some(Gun::Sr),
        _ => None,
    }
}

fn pickup_of(gun: Gun) -> PickupKind {
    match gun {
        Gun::Ar => PickupKind::Ar,
        Gun::Smg => PickupKind::Smg,
        Gun::Sg => PickupKind::Sg,
        Gun::Sr => PickupKind::Sr,
    }
}

/// Removes control characters and trims to `max` characters.
pub fn sanitize(text: &str, max: usize) -> String {
    text.chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect::<String>()
        .trim()
        .to_string()
}

fn r2(v: f32) -> f32 {
    (v * 100.0).round() / 100.0
}

impl Room {
    pub fn new(mut cfg: Config) -> Room {
        if cfg.range {
            // One dummy per lane, no clock, nothing to win.
            let map = Map::firing_range();
            cfg.bots = map.targets.len() as u32;
            cfg.time_limit = 1.0e9;
            cfg.frag_limit = u32::MAX;
            cfg.respawn = true;
            return Room::with_map(cfg, map);
        }
        let map = Map::generate(cfg.seed);
        Room::with_map(cfg, map)
    }

    /// A room on a given map (tests use a flat, empty one).
    pub fn with_map(cfg: Config, map: Map) -> Room {
        let pickups = map
            .pickups
            .iter()
            .enumerate()
            .map(|(i, p)| Pickup {
                id: i as u32,
                kind: p.kind,
                pos: p.pos,
                active: true,
                timer: 0.0,
                dropped: None,
            })
            .collect::<Vec<_>>();
        let next_obj = pickups.len() as u32;
        let mut room = Room {
            rng: Rng::new(cfg.seed.wrapping_mul(31).wrapping_add(17)),
            left: cfg.time_limit,
            bots_wanted: if cfg.range {
                cfg.bots
            } else {
                cfg.bots.min(MAX_BOTS)
            },
            cfg,
            map,
            players: BTreeMap::new(),
            next_id: 1,
            next_obj,
            pickups,
            pickups_dirty: true,
            roster_dirty: true,
            grenades: Vec::new(),
            bullets: Vec::new(),
            tanks: Vec::new(),
            shells: Vec::new(),
            ring: None,
            intermission: None,
            snap_acc: 0.0,
            out: Vec::new(),
            nav: std::sync::OnceLock::new(),
        };
        room.reset_field();
        room.sync_bots();
        room
    }

    /// Tanks back on their parking spots and the ring wide open (a new
    /// match).
    fn reset_field(&mut self) {
        for p in self.players.values_mut() {
            p.tank = None;
        }
        self.shells.clear();
        self.tanks = if self.cfg.tanks {
            self.map
                .tanks
                .iter()
                .enumerate()
                .map(|(i, &home)| {
                    let yaw = home.x.atan2(home.z);
                    Tank {
                        id: i as u32,
                        home,
                        pos: home,
                        yaw,
                        aim: yaw,
                        pitch: 0.0,
                        speed: 0.0,
                        hp: TANK_HP,
                        alive: true,
                        respawn: 0.0,
                        driver: None,
                        cooldown: 0.0,
                    }
                })
                .collect()
        } else {
            Vec::new()
        };
        self.ring = if self.cfg.ring && !self.cfg.range {
            // A match runs through every stage in four fifths of its time;
            // a no-respawn round (over much sooner) in at most four minutes.
            let total = if self.cfg.respawn {
                self.cfg.time_limit
            } else {
                self.cfg.time_limit.min(300.0)
            };
            let unit = (total * 0.08).clamp(10.0, 60.0);
            let r = self.map.half * RING_START;
            let mut ring = Ring {
                c: (0.0, 0.0),
                r,
                from_c: (0.0, 0.0),
                from_r: r,
                to_c: (0.0, 0.0),
                to_r: r,
                stage: 0,
                timer: unit,
                shrinking: false,
                unit,
                acc: 0.0,
            };
            self.aim_ring(&mut ring);
            Some(ring)
        } else {
            None
        };
    }

    /// Picks the circle of the ring's next stage: inside the present one.
    fn aim_ring(&mut self, ring: &mut Ring) {
        let half = self.map.half;
        let to_r = half * RING_RADII[ring.stage.min(RING_RADII.len() - 1)];
        // Stage 0 starts from a circle wider than the field: centre the
        // first one near the middle. After that, anywhere it fits inside.
        let slack = if ring.stage == 0 {
            half * 0.25
        } else {
            (ring.r - to_r).max(0.0)
        };
        let ang = self.rng.range(0.0, std::f32::consts::TAU);
        let d = slack * self.rng.range(0.0, 1.0).sqrt();
        let lim = (half - to_r * 0.6).max(0.0);
        ring.to_c = (
            (ring.c.0 + ang.cos() * d).clamp(-lim, lim),
            (ring.c.1 + ang.sin() * d).clamp(-lim, lim),
        );
        ring.to_r = to_r;
    }

    fn update_ring(&mut self, dt: f32) {
        let Some(mut ring) = self.ring.take() else {
            return;
        };
        if ring.stage < RING_RADII.len() {
            ring.timer -= dt;
            if ring.shrinking {
                let k = (1.0 - ring.timer / ring.unit).clamp(0.0, 1.0);
                ring.c = (
                    ring.from_c.0 + (ring.to_c.0 - ring.from_c.0) * k,
                    ring.from_c.1 + (ring.to_c.1 - ring.from_c.1) * k,
                );
                ring.r = ring.from_r + (ring.to_r - ring.from_r) * k;
            }
            if ring.timer <= 0.0 {
                if ring.shrinking {
                    ring.shrinking = false;
                    ring.c = ring.to_c;
                    ring.r = ring.to_r;
                    ring.stage += 1;
                    ring.timer = ring.unit;
                    if ring.stage < RING_RADII.len() {
                        self.aim_ring(&mut ring);
                    } else {
                        self.sys("リングは最後の大きさになりました".into());
                    }
                } else {
                    ring.shrinking = true;
                    ring.from_c = ring.c;
                    ring.from_r = ring.r;
                    ring.timer = ring.unit;
                    self.sys(format!(
                        "リングが縮み始めました (第 {} 段階 / {})",
                        ring.stage + 1,
                        RING_RADII.len()
                    ));
                }
            }
        }
        // Outside: health drains, whatever you are in.
        ring.acc += dt;
        let mut burn = Vec::new();
        if ring.acc >= 0.5 {
            ring.acc -= 0.5;
            let dps = RING_DPS[ring.stage.min(RING_DPS.len() - 1)];
            for p in self.players.values() {
                let d = (p.pos.x - ring.c.0).hypot(p.pos.z - ring.c.1);
                if p.alive && d > ring.r {
                    burn.push((p.id, dps * 0.5, Vec3::new(ring.c.0, p.pos.y, ring.c.1)));
                }
            }
        }
        self.ring = Some(ring);
        for (id, dmg, from) in burn {
            self.damage(id, id, dmg, false, Cause::Ring, from);
        }
    }

    /// The circle to be inside of: the ring's next stage (which lies within
    /// the present one).
    fn safe_circle(&self) -> Option<((f32, f32), f32)> {
        self.ring.as_ref().map(|r| (r.to_c, r.to_r))
    }

    fn tank_index(&self, id: u32) -> Option<usize> {
        self.tanks.iter().position(|t| t.id == id)
    }

    /// Takes a player out of the tank it drives (the tank stays where it
    /// is). The player is not moved.
    fn unseat(&mut self, id: ClientId) {
        if let Some(p) = self.players.get_mut(&id) {
            p.tank = None;
        }
        for t in &mut self.tanks {
            if t.driver == Some(id) {
                t.driver = None;
            }
        }
    }

    /// `e`: into the nearest empty tank, or out of the one being driven.
    fn use_key(&mut self, id: ClientId) {
        let p = &self.players[&id];
        if !p.alive || self.intermission.is_some() {
            return;
        }
        let pos = p.pos;
        if let Some(i) = p.tank.and_then(|t| self.tank_index(t)) {
            // Out: beside the tank, wherever there is room.
            let t = &self.tanks[i];
            let mut spot = None;
            for k in [0.5f32, -0.5, 1.0, 0.0, 0.25, -0.25, 0.75, -0.75] {
                let a = t.yaw + k * std::f32::consts::PI;
                let d = TANK_RADIUS + 0.9;
                let q = Vec3::new(t.pos.x - a.sin() * d, 0.0, t.pos.z - a.cos() * d);
                if !self.map.blocked(q, 0.5) {
                    spot = Some(q);
                    break;
                }
            }
            let mut q = spot.unwrap_or(t.pos);
            q.y = self.map.height(q.x, q.z);
            self.unseat(id);
            let p = self.players.get_mut(&id).unwrap();
            p.pos = q;
            p.vel = Vec3::ZERO;
            if p.bot.is_none() {
                self.send(
                    Target::One(id),
                    ServerMsg::Item {
                        text: "戦車を降りました".into(),
                    },
                );
            }
            return;
        }
        let near = self
            .tanks
            .iter()
            .enumerate()
            .filter(|(_, t)| t.alive && t.driver.is_none())
            .map(|(i, t)| (i, (t.pos - pos).length_xz()))
            .filter(|(_, d)| *d < TANK_ENTER)
            .min_by(|a, b| a.1.total_cmp(&b.1));
        let Some((i, _)) = near else { return };
        let t = &mut self.tanks[i];
        t.driver = Some(id);
        t.speed = 0.0;
        let (tid, tpos) = (t.id, t.pos);
        let p = self.players.get_mut(&id).unwrap();
        p.tank = Some(tid);
        p.pos = tpos;
        p.vel = Vec3::ZERO;
        p.reload = None;
        p.heal = None;
        p.trigger = 0.0;
        if p.bot.is_none() {
            self.send(
                Target::One(id),
                ServerMsg::Item {
                    text: "戦車に乗りました (k/j 前進・後退, h/l 旋回, v 砲を構える, f 砲撃, e 降りる)".into(),
                },
            );
        }
    }

    /// Whether a tank's circle at `p` is free: no solid, no other tank.
    fn tank_free(&self, idx: usize, p: Vec3) -> bool {
        !self.map.blocked(p, TANK_RADIUS)
            && !self
                .tanks
                .iter()
                .enumerate()
                .any(|(j, o)| j != idx && o.alive && (o.pos - p).length_xz() < 2.0 * TANK_RADIUS)
    }

    /// One tick of a tank with someone at the controls.
    fn update_driver(&mut self, id: ClientId, idx: usize, dt: f32) {
        let p = self.players.get_mut(&id).unwrap();
        p.pitch = p.pitch.clamp(TANK_PITCH.0, TANK_PITCH.1);
        let (mx, mz) = if p.input.ads {
            (0.0, 0.0)
        } else {
            (p.input.mx as f32, p.input.mz as f32)
        };
        let (aim, pitch) = (p.yaw, p.pitch);
        let wants_fire = p.trigger > 0.0 || p.input.fire;
        let t = &mut self.tanks[idx];
        t.aim = aim;
        t.pitch = pitch;
        t.yaw = wrap_angle(t.yaw - mx * TANK_TURN * dt);
        let want = if mz > 0.0 {
            TANK_SPEED
        } else if mz < 0.0 {
            -TANK_REVERSE
        } else {
            0.0
        };
        // Braking is quicker than getting going.
        let rate = if want == 0.0 || want * t.speed < 0.0 {
            TANK_ACCEL * 2.5
        } else {
            TANK_ACCEL
        };
        t.speed += (want - t.speed).clamp(-rate * dt, rate * dt);
        let fwd = Vec3::new(-t.yaw.sin(), 0.0, -t.yaw.cos());
        let delta = fwd * (t.speed * dt);
        let before = t.pos;
        let speed = t.speed;
        // Sub-steps, sliding along whatever is in the way.
        let steps = ((delta.length_xz() / 0.25).ceil() as usize).max(1);
        let step = delta * (1.0 / steps as f32);
        let mut q = before;
        for _ in 0..steps {
            let nx = Vec3::new(q.x + step.x, q.y, q.z);
            if self.tank_free(idx, nx) {
                q = nx;
            }
            let nz = Vec3::new(q.x, q.y, q.z + step.z);
            if self.tank_free(idx, nz) {
                q = nz;
            }
        }
        q.y = self.map.height(q.x, q.z);
        let moved = (q - before).length_xz();
        let t = &mut self.tanks[idx];
        t.pos = q;
        if moved < delta.length_xz() * 0.5 {
            // Ran into something.
            t.speed *= 0.5;
        }
        let p = self.players.get_mut(&id).unwrap();
        p.pos = q;
        p.vel = if dt > 0.0 {
            Vec3::new((q.x - before.x) / dt, 0.0, (q.z - before.z) / dt)
        } else {
            Vec3::ZERO
        };
        // Whoever is under the tracks.
        if speed.abs() >= TANK_RAM_SPEED && moved > 0.0 {
            let hit: Vec<ClientId> = self
                .players
                .values()
                .filter(|o| o.id != id && o.alive && o.tank.is_none())
                .filter(|o| {
                    (o.pos - q).length_xz() < TANK_RADIUS + 0.3 && (o.pos.y - q.y).abs() < 2.5
                })
                .map(|o| o.id)
                .collect();
            for v in hit {
                self.damage(v, id, TANK_RAM_DAMAGE, false, Cause::Tank, q);
            }
        }
        if wants_fire {
            self.fire_shell(id, idx);
        }
    }

    fn fire_shell(&mut self, id: ClientId, idx: usize) {
        let t = &mut self.tanks[idx];
        if t.cooldown > 0.0 || !t.alive {
            return;
        }
        t.cooldown = SHELL_RELOAD;
        let (tid, tpos) = (t.id, t.pos);
        let p = self.players.get_mut(&id).unwrap();
        p.trigger = 0.0;
        p.protect = 0.0;
        let from = tpos + Vec3::new(0.0, TANK_EYE, 0.0);
        let vel = Vec3::from_angles(p.yaw, p.pitch) * SHELL_SPEED;
        let to = self.world_impact(from, vel, SHELL_SPEED * BULLET_LIFE);
        self.shells.push(Shell {
            owner: id,
            tank: tid,
            pos: from,
            vel,
            age: 0.0,
        });
        self.send(Target::All, ServerMsg::Shell { id, from, to, vel });
        for p in self.players.values_mut() {
            if p.id == id || !p.alive {
                continue;
            }
            if let Some(b) = &mut p.bot
                && b.target.is_none()
                && p.pos.distance(from) < BOT_HEARING * 1.5
            {
                b.heard = Some((from, 5.0));
            }
        }
    }

    /// Whether a tank's hull stands on the line from `a` to `b` (bots do not
    /// see through one). `skip`: tanks to leave out (the ones the two ends
    /// sit in).
    fn tank_between(&self, a: Vec3, b: Vec3, skip: [Option<u32>; 2]) -> bool {
        let d = b - a;
        let len = d.length();
        if len < 1e-4 {
            return false;
        }
        let dir = d * (1.0 / len);
        let r = TANK_RADIUS * 0.85;
        self.tanks
            .iter()
            .filter(|t| t.alive && !skip.contains(&Some(t.id)))
            .any(|t| {
                Aabb::new(
                    t.pos + Vec3::new(-r, 0.0, -r),
                    t.pos + Vec3::new(r, TANK_HEIGHT, r),
                )
                .ray(a, dir, len)
                .is_some()
            })
    }

    /// What a segment from `from` along `dir` (length `max`) meets first
    /// among players and tanks: (distance, what). Drivers sit inside their
    /// tank; `owner` and its own tank are passed through.
    fn strike(
        &self,
        from: Vec3,
        dir: Vec3,
        max: f32,
        owner: ClientId,
        own_tank: Option<u32>,
    ) -> Option<(f32, Struck)> {
        let mut best = max;
        let mut hit = None;
        for p in self.players.values() {
            if p.id == owner || !p.alive || p.tank.is_some() {
                continue;
            }
            let sneak = p.input.sneak;
            let head_c = p.pos + Vec3::new(0.0, if sneak { 1.22 } else { 1.67 }, 0.0);
            if let Some(t) = ray_sphere(from, dir, head_c, HEAD_RADIUS, best)
                && t < best
            {
                best = t;
                hit = Some(Struck::Player(p.id, true));
            }
            let body = Aabb::new(
                p.pos + Vec3::new(-0.33, 0.0, -0.33),
                p.pos + Vec3::new(0.33, if sneak { 1.0 } else { 1.45 }, 0.33),
            );
            if let Some(t) = body.ray(from, dir, best)
                && t < best
            {
                best = t;
                hit = Some(Struck::Player(p.id, false));
            }
        }
        for (i, k) in self.tanks.iter().enumerate() {
            if !k.alive || Some(k.id) == own_tank || k.driver == Some(owner) {
                continue;
            }
            let r = TANK_RADIUS * 0.85;
            let hull = Aabb::new(
                k.pos + Vec3::new(-r, 0.0, -r),
                k.pos + Vec3::new(r, TANK_HEIGHT, r),
            );
            if let Some(t) = hull.ray(from, dir, best)
                && t < best
            {
                best = t;
                hit = Some(Struck::Tank(i));
            }
        }
        hit.map(|h| (best, h))
    }

    fn update_shells(&mut self, dt: f32) {
        let shells = std::mem::take(&mut self.shells);
        let mut keep = Vec::with_capacity(shells.len());
        for mut s in shells {
            let next = s.pos + s.vel * dt + Vec3::new(0.0, -0.5 * GRAVITY * dt * dt, 0.0);
            let d = next - s.pos;
            let len = d.length();
            if len < 1e-6 {
                continue;
            }
            let dir = d * (1.0 / len);
            let wall = self.map.raycast(s.pos, dir, len);
            let reach = wall.unwrap_or(len).min(len);
            let struck = self.strike(s.pos, dir, reach, s.owner, Some(s.tank));
            if struck.is_none() && wall.is_none() {
                s.pos = next;
                s.vel.y -= GRAVITY * dt;
                s.age += dt;
                if s.age < BULLET_LIFE {
                    keep.push(s);
                }
                continue;
            }
            let at = struck.map_or(reach, |(t, _)| t);
            // Burst just short of what was hit (not inside it).
            let pos = s.pos + dir * (at - 0.3).max(0.0);
            match struck {
                Some((_, Struck::Player(v, _))) => {
                    self.damage(v, s.owner, SHELL_DAMAGE * 2.0, false, Cause::Tank, s.pos);
                }
                Some((_, Struck::Tank(i))) => {
                    self.damage_tank(i, s.owner, SHELL_DIRECT, Cause::Tank, s.pos);
                }
                None => {}
            }
            self.blast(s.owner, pos, SHELL_RADIUS, SHELL_DAMAGE, Cause::Tank);
        }
        self.shells.extend(keep);
    }

    /// An explosion at `pos`: everyone in the open within `radius` (and in
    /// line of sight) is hurt, less the farther away; tanks too.
    fn blast(&mut self, owner: ClientId, pos: Vec3, radius: f32, max: f32, cause: Cause) {
        self.send(Target::All, ServerMsg::Explode { pos });
        let c = pos + Vec3::new(0.0, 0.3, 0.0);
        let victims: Vec<(ClientId, f32)> = self
            .players
            .values()
            .filter(|p| p.alive && p.tank.is_none())
            .filter_map(|p| {
                let chest = p.pos + Vec3::new(0.0, 1.0, 0.0);
                let d = chest.distance(c);
                (d < radius && self.map.line_of_sight(c, chest))
                    .then(|| (p.id, max * (1.0 - d / radius)))
            })
            .collect();
        for (v, d) in victims {
            self.damage(v, owner, d, false, cause.clone(), pos);
        }
        let tanks: Vec<(usize, f32)> = self
            .tanks
            .iter()
            .enumerate()
            .filter(|(_, t)| t.alive)
            .filter_map(|(i, t)| {
                // From the hull's surface, not its centre.
                let d = ((t.pos + Vec3::new(0.0, 1.2, 0.0)).distance(c) - TANK_RADIUS).max(0.0);
                (d < radius).then(|| (i, max * (1.0 - d / radius)))
            })
            .collect();
        for (i, d) in tanks {
            self.damage_tank(i, owner, d, cause.clone(), pos);
        }
    }

    fn damage_tank(&mut self, idx: usize, attacker: ClientId, dmg: f32, cause: Cause, from: Vec3) {
        let t = &mut self.tanks[idx];
        if !t.alive || dmg <= 0.0 {
            return;
        }
        t.hp -= dmg;
        let driver = t.driver;
        let dead = t.hp <= 0.0;
        let pos = t.pos;
        // The attacker sees the hit land; the driver feels it.
        let hit = ServerMsg::Hit {
            attacker,
            victim: driver.unwrap_or(0),
            head: false,
            dmg: r2(dmg),
            from,
        };
        if driver != Some(attacker) {
            self.send(Target::One(attacker), hit.clone());
        }
        if let Some(d) = driver {
            self.send(Target::One(d), hit);
            if let Some(b) = self.players.get_mut(&d).and_then(|p| p.bot.as_mut())
                && attacker != d
                && b.target.is_none()
            {
                b.target = Some(attacker);
                b.reaction = 0.35;
            }
        }
        if !dead {
            return;
        }
        let t = &mut self.tanks[idx];
        t.alive = false;
        t.hp = 0.0;
        t.respawn = TANK_RESPAWN;
        t.driver = None;
        t.speed = 0.0;
        // The driver goes with it; then it blows up.
        if let Some(d) = driver {
            if let Some(p) = self.players.get_mut(&d) {
                p.tank = None;
                p.protect = 0.0;
            }
            self.damage(d, attacker, 10_000.0, false, cause.clone(), from);
        }
        self.blast(
            attacker,
            pos + Vec3::new(0.0, 1.0, 0.0),
            TANK_BLAST_RADIUS,
            TANK_BLAST_DAMAGE,
            cause,
        );
    }

    fn update_tanks(&mut self, dt: f32) {
        for i in 0..self.tanks.len() {
            let t = &mut self.tanks[i];
            t.cooldown = (t.cooldown - dt).max(0.0);
            if !t.alive {
                t.respawn -= dt;
                if t.respawn <= 0.0 {
                    let home = t.home;
                    // Not onto another tank left on the parking spot.
                    if self.tank_free(i, home) {
                        let t = &mut self.tanks[i];
                        t.alive = true;
                        t.hp = TANK_HP;
                        t.pos = home;
                        t.yaw = home.x.atan2(home.z);
                        t.aim = t.yaw;
                        t.pitch = 0.0;
                        t.speed = 0.0;
                        t.cooldown = 0.0;
                    }
                }
                continue;
            }
            // A driver who is gone (left the game, fell) holds no tank.
            let gone = t.driver.is_some_and(|d| {
                !self
                    .players
                    .get(&d)
                    .is_some_and(|p| p.alive && p.tank == Some(t.id))
            });
            let t = &mut self.tanks[i];
            if gone {
                t.driver = None;
            }
            if t.driver.is_none() {
                t.speed = 0.0;
            }
        }
    }

    /// Messages produced since the last call.
    pub fn drain(&mut self) -> Vec<(Target, ServerMsg)> {
        std::mem::take(&mut self.out)
    }

    pub fn humans(&self) -> usize {
        self.players.values().filter(|p| p.bot.is_none()).count()
    }

    fn send(&mut self, to: Target, msg: ServerMsg) {
        self.out.push((to, msg));
    }

    fn sys(&mut self, text: String) {
        self.send(Target::All, ServerMsg::Sys { text });
    }

    /// A new connection's first message. On success returns its id; the
    /// welcome message is queued.
    pub fn join(
        &mut self,
        name: &str,
        password: Option<&str>,
        protocol: u32,
        spectate: bool,
    ) -> Result<ClientId, String> {
        if protocol != PROTOCOL {
            return Err(format!(
                "プロトコルが違います (サーバー {PROTOCOL} / クライアント {protocol})。同じバージョンを使ってください"
            ));
        }
        if let Some(pw) = &self.cfg.password
            && password != Some(pw.as_str())
        {
            return Err("合言葉が違います".into());
        }
        let watchers = self.players.values().filter(|p| p.spectator).count();
        if spectate && watchers >= MAX_SPECTATORS {
            return Err("観戦者が満員です".into());
        }
        if !spectate && self.humans() - watchers >= self.cfg.max_players {
            return Err("満員です (観戦なら参加できます)".into());
        }
        let id = self.alloc_id();
        let mut name = sanitize(name, NAME_MAX);
        if name.is_empty() {
            name = format!("player{id}");
        }
        if self.players.values().any(|p| p.name == name) {
            name = format!("{}#{id}", sanitize(&name, NAME_MAX - 4));
        }
        self.add_player(id, name.clone(), None);
        let p = self.players.get_mut(&id).unwrap();
        p.spectator = spectate;
        self.send(
            Target::One(id),
            ServerMsg::Welcome {
                id,
                version: crate::VERSION.into(),
                protocol: PROTOCOL,
                map: Box::new(self.map.clone()),
                time_limit: self.cfg.time_limit,
                frag_limit: self.cfg.frag_limit,
                practice: self.cfg.practice,
                specs: Box::new(Specs::current()),
                respawn: self.cfg.respawn,
                range: self.cfg.range,
                spectator: spectate,
                bot_skill: self.cfg.bot_skill,
                ring: self.ring.is_some(),
            },
        );
        if spectate {
            self.sys(format!("{name} が観戦に来ました"));
        } else {
            self.enter(id);
            self.sys(format!("{name} が参加しました"));
        }
        self.pickups_dirty = true;
        Ok(id)
    }

    /// Into the match: spawn now, or (no-respawn round already under way)
    /// wait out the round watching.
    fn enter(&mut self, id: ClientId) {
        let running = !self.cfg.respawn
            && self.intermission.is_none()
            && self.cfg.time_limit - self.left > 10.0
            && self.players.values().any(|p| p.id != id && p.alive);
        let p = self.players.get_mut(&id).unwrap();
        p.spectator = false;
        self.roster_dirty = true;
        if running {
            p.out = true;
            p.alive = false;
            p.out_at = f32::MIN;
            self.send(
                Target::One(id),
                ServerMsg::Sys {
                    text: "ラウンドの途中です。次のラウンドから参加します (それまで観戦)".into(),
                },
            );
        } else {
            p.out = false;
            self.spawn(id);
        }
    }

    pub fn leave(&mut self, id: ClientId) {
        self.unseat(id);
        if let Some(p) = self.players.remove(&id) {
            self.roster_dirty = true;
            self.sys(format!("{} が退出しました", p.name));
        }
    }

    fn alloc_id(&mut self) -> ClientId {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    fn add_player(&mut self, id: ClientId, name: String, bot: Option<Bot>) {
        self.players.insert(
            id,
            Player {
                id,
                name,
                bot,
                pos: Vec3::ZERO,
                vel: Vec3::ZERO,
                yaw: 0.0,
                pitch: 0.0,
                input: InputState::default(),
                hp: MAX_HP,
                alive: false,
                respawn: 0.0,
                protect: 0.0,
                inv: Inventory::spawn(),
                cooldown: 0.0,
                reload: None,
                heal: None,
                trigger: 0.0,
                kills: 0,
                deaths: 0,
                chat_budget: 3.0,
                spectator: false,
                out: false,
                out_at: 0.0,
                tank: None,
            },
        );
        self.roster_dirty = true;
    }

    pub fn set_bots(&mut self, n: u32) {
        self.bots_wanted = n.min(MAX_BOTS);
        self.sync_bots();
    }

    fn sync_bots(&mut self) {
        let mut bots: Vec<ClientId> = self
            .players
            .values()
            .filter(|p| p.bot.is_some())
            .map(|p| p.id)
            .collect();
        while bots.len() > self.bots_wanted as usize {
            let id = bots.pop().unwrap();
            self.unseat(id);
            self.players.remove(&id);
            self.roster_dirty = true;
        }
        while bots.len() < self.bots_wanted as usize {
            let id = self.alloc_id();
            let mut n = bots.len() + 1;
            while self.players.values().any(|p| p.name == format!("bot-{n}")) {
                n += 1;
            }
            let bot = Bot {
                waypoint: Vec3::ZERO,
                wander_timer: 0.0,
                target: None,
                reaction: 0.0,
                aim_err: (0.0, 0.0),
                err_timer: 0.0,
                last_pos: Vec3::ZERO,
                stuck_timer: 0.0,
                stuck_n: 0,
                no_tank: 0.0,
                detour: 0.0,
                path: Vec::new(),
                path_to: Vec3::ZERO,
                path_check: 0.0,
                path_fail: 0.0,
                replan: false,
                cover: None,
                throw_cd: 0.0,
                heard: None,
                dummy: self.map.targets.get(bots.len()).map(|t| (t.pos, t.strafe)),
            };
            let name = if bot.dummy.is_some() {
                format!("的-{n}")
            } else {
                format!("bot-{n}")
            };
            self.add_player(id, name, Some(bot));
            self.spawn(id);
            bots.push(id);
        }
    }

    fn spawn(&mut self, id: ClientId) {
        let others: Vec<Vec3> = self
            .players
            .values()
            .filter(|p| p.alive && p.id != id)
            .map(|p| p.pos)
            .collect();
        // A spawn point no one alive can see, as far from everybody as
        // possible, with a little randomness. (Only if every point is in
        // someone's sight is one of those taken: the farthest.)
        self.unseat(id);
        // With the ring on: only inside the circle it is heading for (when
        // no spawn point is, any free spot there).
        let mut points: Vec<Vec3> = self.map.spawns.clone();
        if let Some(((cx, cz), r)) = self.safe_circle() {
            let r = r * 0.9;
            points.retain(|s| (s.x - cx).hypot(s.z - cz) < r);
            let mut tries = 0;
            while points.len() < 4 && tries < 200 {
                tries += 1;
                let a = self.rng.range(0.0, std::f32::consts::TAU);
                let d = r * self.rng.range(0.0, 1.0).sqrt();
                let mut q = Vec3::new(cx + a.cos() * d, 0.0, cz + a.sin() * d);
                q.y = self.map.height(q.x, q.z);
                if !self.map.blocked(q, 0.7) {
                    points.push(q);
                }
            }
            if points.is_empty() {
                points = self.map.spawns.clone();
            }
        }
        let mut best = points[0];
        let mut best_score = f32::MIN;
        for s in &points {
            let d = others
                .iter()
                .map(|o| o.distance(*s))
                .fold(1000.0f32, f32::min);
            let chest = *s + Vec3::new(0.0, 1.2, 0.0);
            let seen = !self.cfg.range
                && others.iter().any(|o| {
                    o.distance(*s) < SPAWN_SIGHT
                        && self.map.line_of_sight(*o + Vec3::new(0.0, 1.6, 0.0), chest)
                });
            let score = d + self.rng.range(0.0, 20.0) - if seen { 1000.0 } else { 0.0 };
            if score > best_score {
                best_score = score;
                best = *s;
            }
        }
        let mut yaw = best.x.atan2(best.z);
        if self.cfg.range {
            // The bench faces down the range (-Z); dummies face the bench.
            yaw = 0.0;
            if let Some((home, _)) = self
                .players
                .get(&id)
                .and_then(|p| p.bot.as_ref())
                .and_then(|b| b.dummy)
            {
                best = home;
                best.y = self.map.height(home.x, home.z);
                yaw = std::f32::consts::PI;
            }
        }
        if let Some(p) = self.players.get_mut(&id) {
            p.pos = best;
            p.vel = Vec3::ZERO;
            p.yaw = yaw;
            p.pitch = 0.0;
            p.hp = MAX_HP;
            p.alive = true;
            p.protect = PROTECT_TIME;
            p.inv = Inventory::spawn();
            p.cooldown = 0.0;
            p.reload = None;
            p.heal = None;
            p.trigger = 0.0;
            if let Some(b) = &mut p.bot {
                b.target = None;
                b.wander_timer = 0.0;
                b.last_pos = best;
            }
            let bot = p.bot.is_some();
            if !bot {
                self.send(Target::One(id), ServerMsg::Respawn { pos: best, yaw });
            }
        }
    }

    pub fn handle(&mut self, id: ClientId, msg: ClientMsg) {
        if !self.players.contains_key(&id) {
            return;
        }
        match msg {
            ClientMsg::Join { .. } => {}
            ClientMsg::Watch => {
                let p = self.players.get_mut(&id).unwrap();
                if p.spectator {
                    return;
                }
                p.spectator = true;
                p.alive = false;
                p.out = false;
                p.reload = None;
                p.heal = None;
                let name = p.name.clone();
                self.unseat(id);
                self.roster_dirty = true;
                self.sys(format!("{name} が観戦に回りました"));
            }
            ClientMsg::Play => {
                if !self.players[&id].spectator {
                    return;
                }
                let players = self
                    .players
                    .values()
                    .filter(|p| p.bot.is_none() && !p.spectator)
                    .count();
                if players >= self.cfg.max_players {
                    self.send(
                        Target::One(id),
                        ServerMsg::Sys {
                            text: "満員のため参加できません".into(),
                        },
                    );
                    return;
                }
                let name = self.players[&id].name.clone();
                self.enter(id);
                self.sys(format!("{name} が試合に参加しました"));
            }
            ClientMsg::Input {
                mx,
                mz,
                sneak,
                yaw,
                pitch,
                ads,
                zoom,
                fire,
                instant,
            } => {
                if !yaw.is_finite() || !pitch.is_finite() {
                    return;
                }
                let p = self.players.get_mut(&id).unwrap();
                p.input = InputState {
                    mx: mx.clamp(-1, 1),
                    mz: mz.clamp(-1, 1),
                    sneak,
                    ads,
                    zoom: zoom.min(2),
                    fire,
                    instant,
                };
                if p.alive {
                    p.yaw = wrap_angle(yaw);
                    p.pitch = pitch.clamp(-1.45, 1.45);
                }
            }
            ClientMsg::Trigger => {
                let p = self.players.get_mut(&id).unwrap();
                p.trigger = 0.2;
            }
            ClientMsg::Reload => self.start_reload(id),
            ClientMsg::Throw { power } => self.throw(id, power.clamp(1, MAX_THROW)),
            ClientMsg::Select { slot } => {
                let p = self.players.get_mut(&id).unwrap();
                if p.inv.select(slot) {
                    p.reload = None;
                    p.heal = None;
                }
            }
            ClientMsg::Pickup => self.pickup_gun(id),
            ClientMsg::Use => self.use_key(id),
            ClientMsg::Chat { text } => {
                let text = sanitize(&text, CHAT_MAX);
                let p = self.players.get_mut(&id).unwrap();
                if text.is_empty() || p.chat_budget < 1.0 {
                    return;
                }
                p.chat_budget -= 1.0;
                let name = p.name.clone();
                self.send(
                    Target::All,
                    ServerMsg::Chat {
                        from: id,
                        name,
                        text,
                    },
                );
            }
            ClientMsg::Ping { id: n } => self.send(Target::One(id), ServerMsg::Pong { id: n }),
            ClientMsg::Bots { n } => {
                if self.cfg.practice && !self.cfg.range {
                    self.set_bots(n);
                    self.sys(format!("bot の数: {}", self.bots_wanted));
                }
            }
            ClientMsg::BotSkill { level } => {
                if self.cfg.practice && !self.cfg.range {
                    self.cfg.bot_skill = level.clamp(1, 5);
                    let l = self.cfg.bot_skill;
                    self.sys(format!(
                        "bot の強さ: {l} ({})",
                        BOT_SKILL_NAMES[l as usize - 1]
                    ));
                }
            }
        }
    }

    fn start_reload(&mut self, id: ClientId) {
        let p = self.players.get_mut(&id).unwrap();
        if !p.alive || p.reload.is_some() || p.tank.is_some() {
            return;
        }
        let Some(i) = p
            .inv
            .gun_index()
            .or(if p.inv.guns.is_empty() { None } else { Some(0) })
        else {
            return;
        };
        let g = p.inv.guns[i];
        if g.reserve == 0 || g.ammo >= g.gun.stats().mag {
            return;
        }
        if p.inv.gun_index().is_none() {
            p.inv.sel = if i == 0 { Slot::Gun0 } else { Slot::Gun1 };
        }
        p.heal = None;
        p.reload = Some(g.gun.stats().reload);
    }

    fn throw(&mut self, id: ClientId, power: u32) {
        let p = self.players.get_mut(&id).unwrap();
        if !p.alive || p.inv.grenades == 0 || self.intermission.is_some() || p.tank.is_some() {
            return;
        }
        p.inv.grenades -= 1;
        p.inv.fix_selection();
        let dir = Vec3::from_angles(p.yaw, (p.pitch + 0.25).min(1.5));
        let speed = throw_speed(power);
        let eye = p.pos + Vec3::new(0.0, eye_height(p.input.sneak), 0.0);
        let g = Grenade {
            id: self.next_obj,
            owner: id,
            pos: eye + dir * 0.5,
            vel: dir * speed + Vec3::new(p.vel.x, 0.0, p.vel.z),
            fuse: GRENADE_FUSE,
        };
        self.next_obj += 1;
        self.grenades.push(g);
    }

    fn pickup_gun(&mut self, id: ClientId) {
        let p = &self.players[&id];
        if !p.alive || p.tank.is_some() {
            return;
        }
        let pos = p.pos;
        let Some(idx) = self
            .pickups
            .iter()
            .enumerate()
            .filter(|(_, k)| k.active && gun_of(k.kind).is_some() && k.pos.distance(pos) < 2.4)
            .min_by(|a, b| a.1.pos.distance(pos).total_cmp(&b.1.pos.distance(pos)))
            .map(|(i, _)| i)
        else {
            return;
        };
        let pk = self.pickups[idx].clone();
        let gun = gun_of(pk.kind).unwrap();
        let slot = pk.dropped.unwrap_or_else(|| GunSlot::full(gun));
        let p = self.players.get_mut(&id).unwrap();
        p.reload = None;
        let dropped = p.inv.take_gun(slot);
        if pk.dropped.is_some() {
            self.pickups.remove(idx);
        } else {
            self.pickups[idx].active = false;
            self.pickups[idx].timer = if self.cfg.range {
                RANGE_RESPAWN
            } else {
                WEAPON_RESPAWN
            };
        }
        if let Some(old) = dropped {
            self.drop_gun(old, pos);
        }
        self.pickups_dirty = true;
        self.send(
            Target::One(id),
            ServerMsg::Item {
                text: format!("{} を拾いました", gun.stats().name),
            },
        );
    }

    fn drop_gun(&mut self, slot: GunSlot, pos: Vec3) {
        self.pickups.push(Pickup {
            id: self.next_obj,
            kind: pickup_of(slot.gun),
            pos,
            active: true,
            timer: DROP_TTL,
            dropped: Some(slot),
        });
        self.next_obj += 1;
        self.pickups_dirty = true;
    }

    pub fn tick(&mut self, dt: f32) {
        let dt = dt.clamp(0.0, 0.1);
        if let Some(t) = &mut self.intermission {
            *t -= dt;
            if *t <= 0.0 {
                self.start_match();
            }
        } else {
            self.left -= dt;
            let top = self.players.values().map(|p| p.kills).max().unwrap_or(0);
            if self.left <= 0.0 || top >= self.cfg.frag_limit || self.round_over() {
                self.end_match();
            }
        }

        if self.intermission.is_none() {
            self.think_bots(dt);
            let ids: Vec<ClientId> = self.players.keys().copied().collect();
            for id in ids {
                self.update_player(id, dt);
            }
            self.update_bullets(dt);
            self.update_shells(dt);
            self.update_grenades(dt);
            self.update_tanks(dt);
            self.update_ring(dt);
        }
        self.update_pickups(dt);

        self.snap_acc += dt;
        if self.snap_acc >= 1.0 / SNAP_RATE {
            self.snap_acc = 0.0;
            self.snapshot();
        }
        if self.roster_dirty {
            self.roster_dirty = false;
            let players = self.roster();
            self.send(Target::All, ServerMsg::Roster { players });
        }
        if self.pickups_dirty {
            self.pickups_dirty = false;
            let list = self
                .pickups
                .iter()
                .filter(|p| p.active)
                .map(|p| PickupState {
                    id: p.id,
                    kind: p.kind,
                    x: r2(p.pos.x),
                    z: r2(p.pos.z),
                })
                .collect();
            self.send(Target::All, ServerMsg::Pickups { list });
        }
    }

    /// No-respawn: the round is over when at most one of those who started
    /// it is still standing.
    fn round_over(&self) -> bool {
        if self.cfg.respawn {
            return false;
        }
        let entrants: Vec<&Player> = self
            .players
            .values()
            .filter(|p| !p.spectator && p.out_at != f32::MIN)
            .collect();
        entrants.len() >= 2 && entrants.iter().filter(|p| p.alive).count() <= 1
    }

    fn roster(&self) -> Vec<RosterEntry> {
        let mut v: Vec<RosterEntry> = self
            .players
            .values()
            .map(|p| RosterEntry {
                id: p.id,
                name: p.name.clone(),
                kills: p.kills,
                deaths: p.deaths,
                bot: p.bot.is_some(),
                spectator: p.spectator,
                out: p.out,
            })
            .collect();
        if self.cfg.respawn {
            v.sort_by(|a, b| {
                a.spectator
                    .cmp(&b.spectator)
                    .then(b.kills.cmp(&a.kills))
                    .then(a.deaths.cmp(&b.deaths))
                    .then(a.id.cmp(&b.id))
            });
        } else {
            // Last one standing first, then by how long each lasted.
            let out_at = |id: ClientId| {
                self.players
                    .get(&id)
                    .map_or(0.0, |p| if p.out { p.out_at } else { f32::MAX })
            };
            v.sort_by(|a, b| {
                a.spectator
                    .cmp(&b.spectator)
                    .then(out_at(b.id).total_cmp(&out_at(a.id)))
                    .then(b.kills.cmp(&a.kills))
                    .then(a.id.cmp(&b.id))
            });
        }
        v
    }

    fn end_match(&mut self) {
        self.intermission = Some(INTERMISSION);
        self.grenades.clear();
        self.bullets.clear();
        self.shells.clear();
        let ranking = self.roster();
        self.send(
            Target::All,
            ServerMsg::MatchEnd {
                ranking,
                next_in: INTERMISSION,
            },
        );
    }

    fn start_match(&mut self) {
        self.intermission = None;
        self.left = self.cfg.time_limit;
        let ids: Vec<ClientId> = self.players.keys().copied().collect();
        for id in &ids {
            let p = self.players.get_mut(id).unwrap();
            p.kills = 0;
            p.deaths = 0;
            p.alive = false;
            p.out = false;
            p.out_at = 0.0;
        }
        self.reset_field();
        for id in ids {
            if !self.players[&id].spectator {
                self.spawn(id);
            }
        }
        for p in &mut self.pickups {
            if p.dropped.is_none() {
                p.active = true;
            }
        }
        self.pickups.retain(|p| p.dropped.is_none());
        self.pickups_dirty = true;
        self.roster_dirty = true;
        self.send(Target::All, ServerMsg::MatchStart);
    }

    fn update_player(&mut self, id: ClientId, dt: f32) {
        let map = &self.map;
        let p = self.players.get_mut(&id).unwrap();
        p.chat_budget = (p.chat_budget + dt * 0.5).min(3.0);
        if p.watching() {
            return;
        }
        if self.cfg.range && p.bot.is_none() {
            // Firing range: the reserve never runs out.
            for g in &mut p.inv.guns {
                g.reserve = g.gun.stats().reserve_max;
            }
        }
        if !p.alive {
            p.respawn -= dt;
            if p.respawn <= 0.0 {
                self.spawn(id);
            }
            return;
        }
        p.protect = (p.protect - dt).max(0.0);
        p.cooldown = (p.cooldown - dt).max(0.0);
        p.trigger = (p.trigger - dt).max(0.0);

        // At the controls of a tank: it moves, not you.
        if let Some(tid) = p.tank {
            match self.tanks.iter().position(|t| t.id == tid && t.alive) {
                Some(idx) => return self.update_driver(id, idx, dt),
                None => p.tank = None,
            }
        }
        let p = self.players.get_mut(&id).unwrap();

        // Movement. VIEW mode (ads) cannot walk.
        let speed = if p.input.sneak {
            SNEAK_SPEED
        } else {
            RUN_SPEED
        };
        let (mx, mz) = if p.input.ads {
            (0.0, 0.0)
        } else {
            (p.input.mx as f32, p.input.mz as f32)
        };
        let fwd = Vec3::new(-p.yaw.sin(), 0.0, -p.yaw.cos());
        let right = Vec3::new(p.yaw.cos(), 0.0, -p.yaw.sin());
        let want = (fwd * mz + right * mx).normalize() * speed;
        if p.input.instant {
            p.vel = want;
        } else {
            let dv = want - p.vel;
            let l = dv.length();
            let max = ACCEL * dt;
            p.vel = if l <= max {
                want
            } else {
                p.vel + dv * (max / l)
            };
        }
        let before = p.pos;
        p.pos = map.slide(p.pos, p.vel * dt);
        // Tanks are in the way: out to the hull's edge.
        for t in self.tanks.iter().filter(|t| t.alive) {
            let dx = p.pos.x - t.pos.x;
            let dz = p.pos.z - t.pos.z;
            let d = dx.hypot(dz);
            let min = TANK_RADIUS + 0.35;
            if d < min && (p.pos.y - t.pos.y).abs() < TANK_HEIGHT {
                let (ux, uz) = if d > 1e-3 {
                    (dx / d, dz / d)
                } else {
                    (1.0, 0.0)
                };
                let q = Vec3::new(t.pos.x + ux * min, 0.0, t.pos.z + uz * min);
                if !map.blocked(q, crate::map::PLAYER_RADIUS) {
                    p.pos = Vec3::new(q.x, map.height(q.x, q.z), q.z);
                }
            }
        }
        if dt > 0.0 {
            let real = (p.pos - before) * (1.0 / dt);
            p.vel = Vec3::new(real.x, 0.0, real.z);
        }

        // Reload / heal progress.
        if let Some(t) = &mut p.reload {
            *t -= dt;
            if *t <= 0.0 {
                p.reload = None;
                if let Some(i) = p.inv.gun_index() {
                    let g = &mut p.inv.guns[i];
                    let need = g.gun.stats().mag - g.ammo;
                    let take = need.min(g.reserve);
                    g.ammo += take;
                    g.reserve -= take;
                }
            }
        }
        if let Some(t) = &mut p.heal {
            *t -= dt;
            if *t <= 0.0 {
                p.heal = None;
                if p.inv.medkits > 0 {
                    p.inv.medkits -= 1;
                    p.hp = (p.hp + MEDKIT_HEAL).min(MAX_HP);
                    p.inv.fix_selection();
                }
            }
        }

        // Trigger / held fire.
        let wants_fire = p.trigger > 0.0
            || (p.input.fire
                && p.inv
                    .gun_index()
                    .is_some_and(|i| p.inv.guns[i].gun.stats().auto));
        if wants_fire {
            self.try_fire(id);
        }

        // Items at your feet are taken automatically.
        let p = self.players.get_mut(&id).unwrap();
        let pos = p.pos;
        let mut taken = Vec::new();
        for (i, k) in self.pickups.iter().enumerate() {
            if !k.active || k.pos.distance(Vec3::new(pos.x, 0.0, pos.z)) > 1.6 {
                continue;
            }
            let ok = match k.kind {
                PickupKind::Medkit if p.inv.medkits < MAX_MEDKITS => {
                    p.inv.medkits += 1;
                    true
                }
                PickupKind::Grenade if p.inv.grenades < MAX_GRENADES => {
                    p.inv.grenades += 1;
                    true
                }
                PickupKind::Ammo => p.inv.refill_ammo(),
                _ => false,
            };
            if ok {
                taken.push((i, k.kind));
            }
        }
        for (i, kind) in taken {
            self.pickups[i].active = false;
            self.pickups[i].timer = if self.cfg.range {
                RANGE_RESPAWN
            } else {
                ITEM_RESPAWN
            };
            self.pickups_dirty = true;
            let text = match kind {
                PickupKind::Medkit => "回復キットを拾いました",
                PickupKind::Grenade => "グレネードを拾いました",
                _ => "弾薬を補充しました",
            };
            if self.players[&id].bot.is_none() {
                self.send(Target::One(id), ServerMsg::Item { text: text.into() });
            }
        }
    }

    fn try_fire(&mut self, id: ClientId) {
        let p = self.players.get_mut(&id).unwrap();
        if p.reload.is_some() || p.heal.is_some() || p.cooldown > 0.0 {
            return;
        }
        match p.inv.sel {
            Slot::Medkit => {
                p.trigger = 0.0;
                if p.inv.medkits > 0 && p.hp < MAX_HP {
                    p.heal = Some(MEDKIT_TIME);
                }
                return;
            }
            Slot::Grenade => {
                p.trigger = 0.0;
                p.cooldown = 0.5;
                self.throw(id, DEFAULT_THROW);
                return;
            }
            _ => {}
        }
        let Some(i) = p.inv.gun_index() else { return };
        let slot = p.inv.guns[i];
        let st = slot.gun.stats();
        p.trigger = 0.0;
        if slot.ammo == 0 {
            self.start_reload(id);
            return;
        }
        p.inv.guns[i].ammo -= 1;
        p.cooldown = st.interval;
        p.protect = 0.0;
        let eye = p.pos + Vec3::new(0.0, eye_height(p.input.sneak), 0.0);
        let moving = p.vel.length_xz() > 0.5;
        let spread = match (p.input.ads, p.input.zoom) {
            (true, 2) => st.spread_scope,
            (true, _) => st.spread_ads,
            _ => st.spread_hip * if moving { 1.3 } else { 1.0 },
        };
        let (yaw, pitch) = (p.yaw, p.pitch);
        let p_vel = p.vel;
        let gun = slot.gun;

        // Each pellet is a projectile. The tracer's end is where the first
        // one would hit the world (players are found while it flies).
        let mut first: Option<(Vec3, Vec3)> = None;
        for _ in 0..st.pellets {
            let dy = self.rng.range(-1.0, 1.0);
            let dp = self.rng.range(-1.0, 1.0);
            let k = spread.to_radians() * (dy * dy + dp * dp).sqrt().min(1.0);
            let ang = dy.atan2(dp);
            let dir = Vec3::from_angles(yaw + k * ang.sin(), pitch + k * ang.cos());
            let vel = dir * st.muzzle_velocity + Vec3::new(p_vel.x, 0.0, p_vel.z);
            if first.is_none() {
                first = Some((vel, self.world_impact(eye, vel, st.range)));
            }
            self.bullets.push(Bullet {
                owner: id,
                gun,
                origin: eye,
                pos: eye,
                vel,
                traveled: 0.0,
                age: 0.0,
            });
        }
        let (vel, to) = first.unwrap_or((Vec3::ZERO, eye));
        self.send(
            Target::All,
            ServerMsg::Shot {
                id,
                from: eye,
                to,
                vel,
                gun,
            },
        );
        // Bots within earshot turn toward the shot.
        for p in self.players.values_mut() {
            if p.id == id || !p.alive {
                continue;
            }
            if let Some(b) = &mut p.bot
                && b.target.is_none()
                && p.pos.distance(eye) < BOT_HEARING
            {
                b.heard = Some((eye, 5.0));
            }
        }
    }

    /// Where a bullet would first hit terrain or a solid (ignoring
    /// players), or where it ends its range.
    fn world_impact(&self, from: Vec3, vel: Vec3, range: f32) -> Vec3 {
        let dt = 1.0 / TICK_RATE;
        let mut t = 0.0;
        let mut pos = from;
        let mut traveled = 0.0;
        while t < BULLET_LIFE && traveled < range {
            let next = ballistic(from, vel, t + dt);
            let d = next - pos;
            let len = d.length();
            if len > 1e-6 {
                let dir = d * (1.0 / len);
                if let Some(h) = self.map.raycast(pos, dir, len) {
                    return pos + dir * h;
                }
            }
            traveled += len;
            pos = next;
            t += dt;
        }
        pos
    }

    /// Moves every bullet along its arc (one straight segment per tick) and
    /// applies what it hits first: a player (head or body), or the world.
    fn update_bullets(&mut self, dt: f32) {
        // (attacker, victim) -> damage, headshot, gun, origin: the pellets of
        // one shotgun blast landing in the same tick count as one hit.
        let mut hits: BTreeMap<(ClientId, ClientId), (f32, bool, Gun, Vec3)> = BTreeMap::new();
        let mut tank_hits: BTreeMap<(ClientId, usize), (f32, Gun, Vec3)> = BTreeMap::new();
        let mut keep = Vec::with_capacity(self.bullets.len());
        let bullets = std::mem::take(&mut self.bullets);
        for mut b in bullets {
            let st = b.gun.stats();
            let next = b.pos + b.vel * dt + Vec3::new(0.0, -0.5 * GRAVITY * dt * dt, 0.0);
            let d = next - b.pos;
            let len = d.length();
            if len < 1e-6 {
                continue;
            }
            let dir = d * (1.0 / len);
            let wall = self.map.raycast(b.pos, dir, len).unwrap_or(f32::MAX);
            match self.strike(b.pos, dir, wall.min(len), b.owner, None) {
                Some((t, Struck::Player(victim, head))) => {
                    let dist = b.traveled + t;
                    let e = hits
                        .entry((b.owner, victim))
                        .or_insert((0.0, false, b.gun, b.origin));
                    e.0 += b.gun.damage_at(dist, head);
                    e.1 |= head;
                    continue;
                }
                Some((t, Struck::Tank(i))) => {
                    // Armour: only a little gets through.
                    let e = tank_hits
                        .entry((b.owner, i))
                        .or_insert((0.0, b.gun, b.origin));
                    e.0 += b.gun.damage_at(b.traveled + t, false) * TANK_BULLET_FACTOR;
                    continue;
                }
                None => {}
            }
            if wall <= len {
                continue;
            }
            b.traveled += len;
            b.age += dt;
            b.pos = next;
            b.vel.y -= GRAVITY * dt;
            if b.traveled < st.range && b.age < BULLET_LIFE {
                keep.push(b);
            }
        }
        self.bullets = keep;
        for ((attacker, victim), (d, head, gun, origin)) in hits {
            self.damage(victim, attacker, d, head, Cause::Gun(gun), origin);
        }
        for ((attacker, tank), (d, gun, origin)) in tank_hits {
            self.damage_tank(tank, attacker, d, Cause::Gun(gun), origin);
        }
    }

    fn damage(
        &mut self,
        victim: ClientId,
        attacker: ClientId,
        dmg: f32,
        head: bool,
        cause: Cause,
        from: Vec3,
    ) {
        let Some(v) = self.players.get_mut(&victim) else {
            return;
        };
        if !v.alive || v.protect > 0.0 {
            return;
        }
        v.hp -= dmg;
        v.heal = None;
        let dead = v.hp <= 0.0;
        let dmg = r2(dmg);
        let hit = ServerMsg::Hit {
            attacker,
            victim,
            head,
            dmg,
            from,
        };
        self.send(Target::One(attacker), hit.clone());
        if attacker != victim {
            self.send(Target::One(victim), hit);
        }
        if let Some(b) = &mut self.players.get_mut(&victim).unwrap().bot {
            // Bots turn toward whoever shoots them.
            if attacker != victim && b.target.is_none() {
                b.target = Some(attacker);
                b.reaction = 0.35;
            }
        }
        if dead {
            let elapsed = self.cfg.time_limit - self.left;
            let respawn = self.cfg.respawn;
            let range = self.cfg.range;
            let v = self.players.get_mut(&victim).unwrap();
            v.alive = false;
            v.hp = 0.0;
            v.respawn = if range { RANGE_RESPAWN } else { RESPAWN_TIME };
            if !respawn {
                v.out = true;
                v.out_at = elapsed;
            }
            v.deaths += 1;
            v.reload = None;
            v.heal = None;
            let pos = v.pos;
            self.unseat(victim);
            let v = &self.players[&victim];
            let held = v.inv.gun_index().map(|i| v.inv.guns[i]);
            if attacker != victim
                && let Some(a) = self.players.get_mut(&attacker)
            {
                a.kills += 1;
            }
            if let Some(g) = held
                && g.ammo + g.reserve > 0
            {
                self.drop_gun(g, pos);
            }
            self.roster_dirty = true;
            let dist = if attacker == victim {
                0.0
            } else {
                self.players
                    .get(&attacker)
                    .map_or(0.0, |a| r2(a.pos.distance(pos)))
            };
            self.send(
                Target::All,
                ServerMsg::Kill {
                    killer: attacker,
                    victim,
                    cause,
                    head,
                    dist,
                },
            );
        }
    }

    fn update_grenades(&mut self, dt: f32) {
        let mut boom = Vec::new();
        for g in &mut self.grenades {
            g.fuse -= dt;
            if g.fuse <= 0.0 {
                boom.push((g.owner, g.pos));
                continue;
            }
            g.vel.y -= GRAVITY * dt;
            let mut n = g.pos + g.vel * dt;
            let ground = self.map.height(n.x, n.z) + 0.08;
            if n.y < ground {
                n.y = ground;
                g.vel.y = -g.vel.y * 0.35;
                g.vel.x *= 0.7;
                g.vel.z *= 0.7;
            }
            // Solids, and tanks (a grenade bounces off a hull).
            let hulls: Vec<Aabb> = self
                .tanks
                .iter()
                .filter(|t| t.alive)
                .map(|t| {
                    let r = TANK_RADIUS * 0.85;
                    Aabb::new(
                        t.pos + Vec3::new(-r, 0.0, -r),
                        t.pos + Vec3::new(r, TANK_HEIGHT, r),
                    )
                })
                .collect();
            let inside = |p: Vec3| {
                self.map.solids.iter().any(|s| s.aabb.contains(p))
                    || hulls.iter().any(|h| h.contains(p))
            };
            if inside(n) {
                if inside(Vec3::new(n.x, g.pos.y, g.pos.z)) {
                    n.x = g.pos.x;
                    g.vel.x = -g.vel.x * 0.4;
                }
                if inside(Vec3::new(n.x, g.pos.y, n.z)) {
                    n.z = g.pos.z;
                    g.vel.z = -g.vel.z * 0.4;
                }
                if inside(Vec3::new(n.x, n.y, n.z)) {
                    n.y = g.pos.y;
                    g.vel.y = -g.vel.y * 0.3;
                }
            }
            g.pos = n;
        }
        self.grenades.retain(|g| g.fuse > 0.0);
        for (owner, pos) in boom {
            self.blast(owner, pos, GRENADE_RADIUS, GRENADE_DAMAGE, Cause::Grenade);
        }
    }

    fn update_pickups(&mut self, dt: f32) {
        let before = self.pickups.len();
        for p in &mut self.pickups {
            if p.dropped.is_some() {
                p.timer -= dt;
            } else if !p.active {
                p.timer -= dt;
                if p.timer <= 0.0 {
                    p.active = true;
                    self.pickups_dirty = true;
                }
            }
        }
        self.pickups
            .retain(|p| p.dropped.is_none() || p.timer > 0.0);
        if self.pickups.len() != before {
            self.pickups_dirty = true;
        }
    }

    fn snapshot(&mut self) {
        let players: Vec<PlayerState> = self
            .players
            .values()
            .filter(|p| !p.spectator)
            .map(|p| PlayerState {
                id: p.id,
                x: r2(p.pos.x),
                y: r2(p.pos.y),
                z: r2(p.pos.z),
                yaw: r2(p.yaw),
                pitch: r2(p.pitch),
                alive: p.alive,
                sneak: p.input.sneak,
                ads: p.input.ads,
                mv: p.vel.length_xz() > 0.5 && p.tank.is_none(),
                gun: p.inv.held_gun(),
                hp: None,
                tank: p.tank,
            })
            .collect();
        // Those watching also see everyone's health.
        let watched: Vec<PlayerState> = players
            .iter()
            .map(|st| PlayerState {
                hp: self.players.get(&st.id).map(|p| p.hp.max(0.0).ceil()),
                ..st.clone()
            })
            .collect();
        let grenades: Vec<GrenadeState> = self
            .grenades
            .iter()
            .map(|g| GrenadeState {
                id: g.id,
                x: r2(g.pos.x),
                y: r2(g.pos.y),
                z: r2(g.pos.z),
            })
            .collect();
        let tanks: Vec<TankState> = self
            .tanks
            .iter()
            .filter(|t| t.alive)
            .map(|t| TankState {
                id: t.id,
                x: r2(t.pos.x),
                y: r2(t.pos.y),
                z: r2(t.pos.z),
                yaw: r2(t.yaw),
                aim: r2(t.aim),
                pitch: r2(t.pitch),
                hp: t.hp.max(0.0).ceil(),
                driver: t.driver,
                reload: if t.cooldown > 0.0 {
                    r2(1.0 - t.cooldown / SHELL_RELOAD)
                } else {
                    -1.0
                },
            })
            .collect();
        let ring = self.ring.as_ref().map(|r| RingState {
            x: r2(r.c.0),
            z: r2(r.c.1),
            r: r2(r.r),
            nx: r2(r.to_c.0),
            nz: r2(r.to_c.1),
            nr: r2(r.to_r),
            t: if r.stage < RING_RADII.len() {
                r.timer.max(0.0).ceil()
            } else {
                -1.0
            },
            shrinking: r.shrinking,
            dps: RING_DPS[r.stage.min(RING_DPS.len() - 1)],
            stage: r.stage as u32,
        });
        let humans: Vec<ClientId> = self
            .players
            .values()
            .filter(|p| p.bot.is_none())
            .map(|p| p.id)
            .collect();
        for id in humans {
            let p = &self.players[&id];
            if p.watching() {
                self.out.push((
                    Target::One(id),
                    ServerMsg::Snap {
                        left: self.left.max(0.0).ceil(),
                        intermission: self.intermission.map(|t| t.max(0.0).ceil()),
                        players: watched.clone(),
                        grenades: grenades.clone(),
                        me: None,
                        watching: true,
                        tanks: tanks.clone(),
                        ring: ring.clone(),
                    },
                ));
                continue;
            }
            let reload = match (p.reload, p.inv.gun_index()) {
                (Some(t), Some(i)) => 1.0 - t / p.inv.guns[i].gun.stats().reload,
                _ => -1.0,
            };
            let me = MeState {
                hp: p.hp.max(0.0).ceil(),
                inv: p.inv.clone(),
                reload: r2(reload),
                heal: p.heal.map(|t| r2(1.0 - t / MEDKIT_TIME)).unwrap_or(-1.0),
                protect: p.protect > 0.0,
                respawn: if p.alive { 0.0 } else { r2(p.respawn.max(0.0)) },
            };
            self.out.push((
                Target::One(id),
                ServerMsg::Snap {
                    left: self.left.max(0.0).ceil(),
                    intermission: self.intermission.map(|t| t.max(0.0).ceil()),
                    // Offline practice (and the range) shows everyone's
                    // health; in a hosted match only watchers see it.
                    players: if self.cfg.practice {
                        watched.clone()
                    } else {
                        players.clone()
                    },
                    grenades: grenades.clone(),
                    me: Some(me),
                    watching: false,
                    tanks: tanks.clone(),
                    ring: ring.clone(),
                },
            ));
        }
    }

    fn think_bots(&mut self, dt: f32) {
        let ids: Vec<ClientId> = self
            .players
            .values()
            .filter(|p| p.bot.is_some() && p.alive)
            .map(|p| p.id)
            .collect();
        for id in ids {
            self.think_bot(id, dt);
        }
    }

    fn think_bot(&mut self, id: ClientId, dt: f32) {
        let me = &self.players[&id];
        if let Some((home, strafe)) = me.bot.as_ref().unwrap().dummy {
            // Practice dummy: face the bench; strafing ones walk ±strafe m.
            let p = self.players.get_mut(&id).unwrap();
            p.yaw = std::f32::consts::PI;
            p.pitch = 0.0;
            let b = p.bot.as_mut().unwrap();
            let mut mx = 0;
            if strafe > 0.0 {
                // Facing +Z, walking "right" (mx = 1) goes toward -X. Turn
                // round at either end of the lane.
                let off = p.pos.x - home.x;
                if b.err_timer == 0.0 {
                    b.err_timer = 1.0;
                }
                if off <= -strafe {
                    b.err_timer = -1.0;
                } else if off >= strafe {
                    b.err_timer = 1.0;
                }
                mx = if b.err_timer > 0.0 { 1 } else { -1 };
            }
            let _ = dt;
            p.input = InputState {
                mx,
                instant: true,
                ..Default::default()
            };
            return;
        }
        let eye = me.pos + Vec3::new(0.0, 1.6, 0.0);
        let skill = bot_skill(self.cfg.bot_skill);
        // In a tank: its hull's heading, and shells instead of bullets.
        let hull = me
            .tank
            .and_then(|t| self.tank_index(t))
            .map(|i| self.tanks[i].yaw);
        let driving = hull.is_some();
        let muzzle = if driving {
            SHELL_SPEED
        } else {
            me.inv
                .held_gun()
                .map_or(880.0, |g| g.stats().muzzle_velocity)
        };
        // The ring: where to be, and whether it is time to move.
        let safe = self.safe_circle();
        let from_centre = |c: (f32, f32)| (me.pos.x - c.0).hypot(me.pos.z - c.1);
        let outside_next = safe.is_some_and(|(c, r)| from_centre(c) > r - 4.0);
        let outside_now = self
            .ring
            .as_ref()
            .is_some_and(|r| from_centre(r.c) > r.r - 2.0);
        let ring_goal = safe.map(|(c, _)| Vec3::new(c.0, 0.0, c.1));
        // An empty tank close by is worth taking.
        let near_tank = if driving || me.bot.as_ref().unwrap().no_tank > 0.0 {
            None
        } else {
            self.tanks
                .iter()
                .filter(|t| t.alive && t.driver.is_none())
                .map(|t| (t.pos, (t.pos - me.pos).length_xz()))
                .filter(|(_, d)| *d < skill.tank_reach)
                .min_by(|a, b| a.1.total_cmp(&b.1))
        };
        // Tanks nobody drives, close enough to hide behind.
        let cover_tanks: Vec<Vec3> = if skill.tactics && !driving {
            self.tanks
                .iter()
                .filter(|t| t.alive && t.driver.is_none())
                .map(|t| t.pos)
                .filter(|t| (*t - me.pos).length_xz() < 25.0)
                .collect()
        } else {
            Vec::new()
        };
        // Nearest visible enemy within its sight; the nearest running one
        // close by is heard even without a line of sight.
        let mut seen: Option<(ClientId, Vec3, f32)> = None;
        let mut seen_vel = Vec3::ZERO;
        let mut seen_in_tank = false;
        let mut steps: Option<(Vec3, f32)> = None;
        for o in self.players.values() {
            if o.id == id || !o.alive {
                continue;
            }
            let chest = o.pos + Vec3::new(0.0, if o.input.sneak { 0.8 } else { 1.2 }, 0.0);
            let d = chest.distance(eye);
            if d < BOT_FOOTSTEPS
                && !o.input.sneak
                && o.vel.length_xz() > 3.0
                && steps.is_none_or(|s| s.1 > d)
            {
                steps = Some((chest, d));
            }
            if d > skill.sight || seen.is_some_and(|s| s.2 < d) {
                continue;
            }
            if self.map.line_of_sight(eye, chest)
                && !self.tank_between(eye, chest, [me.tank, o.tank])
            {
                seen = Some((o.id, chest, d));
                seen_vel = o.vel;
                seen_in_tank = o.tank.is_some();
            }
        }
        // Hurt with no medkit on it: a medkit lying nearby is worth a detour.
        let medkit = if me.hp < BOT_SEEK_MEDKIT && me.inv.medkits == 0 {
            self.pickups
                .iter()
                .filter(|k| k.active && k.kind == PickupKind::Medkit)
                .map(|k| (k.pos, k.pos.distance(Vec3::new(me.pos.x, 0.0, me.pos.z))))
                .filter(|(_, d)| *d < 80.0)
                .min_by(|a, b| a.1.total_cmp(&b.1))
                .map(|(p, _)| p)
        } else {
            None
        };
        let wp = me.bot.as_ref().unwrap().waypoint;
        let need_wp = me.bot.as_ref().unwrap().wander_timer <= 0.0
            || me.pos.distance(wp) < if driving { 6.0 } else { 3.0 }
            || safe.is_some_and(|(c, r)| (wp.x - c.0).hypot(wp.z - c.1) > r);
        let new_wp = if need_wp {
            let mut p = self.map.spawns[self.rng.below(self.map.spawns.len())];
            p.x += self.rng.range(-8.0, 8.0);
            p.z += self.rng.range(-8.0, 8.0);
            // Now and then: to a tank nobody is in.
            let free: Vec<Vec3> = self
                .tanks
                .iter()
                .filter(|t| t.alive && t.driver.is_none())
                .map(|t| t.pos)
                .collect();
            if !driving
                && !free.is_empty()
                && me.bot.as_ref().unwrap().no_tank <= 0.0
                && self.rng.chance(skill.tank_chance)
            {
                p = free[self.rng.below(free.len())];
            }
            if let Some((c, r)) = safe
                && (p.x - c.0).hypot(p.z - c.1) > r * 0.85
            {
                // Somewhere inside the ring instead.
                let a = self.rng.range(0.0, std::f32::consts::TAU);
                let d = r * 0.85 * self.rng.range(0.0, 1.0).sqrt();
                p = Vec3::new(c.0 + a.cos() * d, 0.0, c.1 + a.sin() * d);
                p.y = self.map.height(p.x, p.z);
            }
            Some(p)
        } else {
            None
        };
        // Outside the ring nothing matters more than getting back in.
        let seen = if outside_now { None } else { seen };
        // Steering a tank toward a heading: turn the hull, drive when it
        // roughly points there.
        let drive = |hull: f32, want: f32| -> (i8, i8) {
            let d = wrap_angle(want - hull);
            let mx = if d.abs() < 0.12 {
                0
            } else if d > 0.0 {
                -1
            } else {
                1
            };
            (mx, if d.abs() < 0.9 { 1 } else { 0 })
        };
        let mut want_use = false;
        let mut want_reload = false;
        let mut want_throw = None;
        let err = (self.rng.range(-1.0, 1.0), self.rng.range(-1.0, 1.0));
        let p = self.players.get_mut(&id).unwrap();
        let pos = p.pos;
        let b = p.bot.as_mut().unwrap();
        if let Some(w) = new_wp {
            b.waypoint = w;
            b.wander_timer = 20.0;
        }
        b.wander_timer -= dt;
        b.stuck_timer += dt;
        if b.stuck_timer > 2.0 {
            if pos.distance(b.last_pos) < 1.0 {
                b.stuck_n = b.stuck_n.saturating_add(1);
                if seen.is_none() {
                    if driving {
                        // A tank has no routes (it does not fit through
                        // doors): try by another waypoint for a while.
                        b.wander_timer = 0.0;
                        b.detour = 4.0;
                    } else {
                        // Something is in the way: work out the way round.
                        // Still stuck on a route (a tank or a player in the
                        // way, no route at all): somewhere else for a while.
                        b.replan = true;
                        if b.stuck_n >= 2 || !b.path.is_empty() || b.path_fail > 0.0 {
                            b.wander_timer = 0.0;
                            b.detour = 4.0;
                        }
                        b.path.clear();
                        b.no_tank = 20.0;
                    }
                }
            } else {
                b.stuck_n = 0;
            }
            b.stuck_timer = 0.0;
            b.last_pos = pos;
            // A tank that will not come free is left behind.
            if driving && b.stuck_n >= 3 && seen.is_none() {
                b.stuck_n = 0;
                b.no_tank = 25.0;
                want_use = true;
            }
        }
        b.no_tank = (b.no_tank - dt).max(0.0);
        b.detour = (b.detour - dt).max(0.0);
        b.throw_cd = (b.throw_cd - dt).max(0.0);
        if let Some((_, t)) = &mut b.cover {
            *t -= dt;
            if *t <= 0.0 {
                b.cover = None;
            }
        }
        b.err_timer -= dt;
        if b.err_timer <= 0.0 {
            b.err_timer = 0.6;
            b.aim_err = (
                err.0 * 0.03 * skill.aim_error,
                err.1 * 0.02 * skill.aim_error,
            );
        }
        if let Some((pos, _)) = steps
            && b.heard.is_none()
        {
            b.heard = Some((pos, 3.0));
        }
        if let Some((_, t)) = &mut b.heard {
            *t -= dt;
            if *t <= 0.0 {
                b.heard = None;
            }
        }
        match seen {
            Some((tid, chest, dist)) => {
                b.heard = None;
                // Fight with a gun. A heal under way goes on only when badly
                // hurt (switching away stops it).
                if !matches!(p.inv.sel, Slot::Gun0 | Slot::Gun1)
                    && !(p.heal.is_some() && p.hp < 40.0)
                    && p.inv.select(Slot::Gun0)
                {
                    p.heal = None;
                }
                if b.target != Some(tid) {
                    b.target = Some(tid);
                    // Farther targets take longer to react to.
                    b.reaction = skill.reaction + dist / 250.0;
                }
                b.reaction -= dt;
                // Strong bots aim where the target will be when the bullet
                // arrives, and over the drop.
                let aim_at = if driving {
                    // A shell: at the feet (the blast does the rest), over
                    // its drop.
                    let t = dist / muzzle;
                    chest
                        + Vec3::new(0.0, 0.5 * GRAVITY * t * t - 0.8, 0.0)
                        + if skill.lead { seen_vel * t } else { Vec3::ZERO }
                } else if skill.lead {
                    let t = dist / muzzle;
                    chest + seen_vel * t + Vec3::new(0.0, 0.5 * GRAVITY * t * t, 0.0)
                } else {
                    chest
                };
                let d = aim_at - eye;
                let want_yaw = (-d.x).atan2(-d.z) + b.aim_err.0;
                let want_pitch = d.y.atan2(d.length_xz()) + b.aim_err.1;
                let ready = b.reaction <= 0.0;
                let dy = wrap_angle(want_yaw - p.yaw);
                let step = skill.turn * dt;
                p.yaw = wrap_angle(p.yaw + dy.clamp(-step, step));
                p.pitch += (want_pitch - p.pitch).clamp(-step, step);
                let aimed = dy.abs() < 0.06;
                // With its head (strong bots, on foot, the enemy not on top
                // of it): a tank standing by is armour to get into; hurt or
                // out of rounds, its far side is cover.
                let enemy = chest;
                let fall_back = if !skill.tactics || driving || dist < 8.0 {
                    None
                } else if let Some((t, d)) =
                    near_tank.filter(|(_, d)| *d < 15.0 || (*d < 45.0 && *d < dist * 0.5))
                {
                    want_use = d < TANK_ENTER - 0.6;
                    Some(t)
                } else if p.hp < 55.0 || p.reload.is_some() {
                    let spot = cover_tanks
                        .iter()
                        .map(|t| {
                            let away = Vec3::new(t.x - enemy.x, 0.0, t.z - enemy.z).normalize();
                            *t + away * (TANK_RADIUS + 1.2)
                        })
                        .min_by(|a, b| a.distance(pos).total_cmp(&b.distance(pos)));
                    // Behind the tank it no longer sees the enemy: it stays
                    // there a while all the same (not back out into the open).
                    if let Some(c) = spot {
                        b.cover = Some((c, 3.0));
                    }
                    spot
                } else {
                    None
                };
                // Bullets barely scratch a tank: a grenade under it does.
                if skill.tactics
                    && !driving
                    && seen_in_tank
                    && ready
                    && p.inv.grenades > 0
                    && b.throw_cd <= 0.0
                    && dy.abs() < 0.15
                    && (8.0..32.0).contains(&dist)
                {
                    // Thrown about 14° above the line of sight, a grenade
                    // lands at some 60% of the way and rolls the rest: the
                    // speed for that, as a power 1..=5.
                    let v = (dist * 10.5).sqrt();
                    want_throw = Some((((v - 6.0) / 3.5).round() as u32).clamp(1, MAX_THROW));
                    b.throw_cd = 3.5;
                }
                if let Some(goal) = fall_back {
                    let d = goal - pos;
                    if d.length_xz() > 0.8 {
                        let want = (-d.x).atan2(-d.z);
                        let dy = wrap_angle(want - p.yaw);
                        let step = 6.0 * dt;
                        p.yaw = wrap_angle(p.yaw + dy.clamp(-step, step));
                        p.input = InputState {
                            mz: if dy.abs() < 0.8 { 1 } else { 0 },
                            ..Default::default()
                        };
                    } else {
                        // There (and still in sight): down, and shoot back.
                        p.input = InputState {
                            sneak: true,
                            ads: true,
                            zoom: 1,
                            fire: ready && aimed,
                            ..Default::default()
                        };
                        if ready && aimed && p.cooldown <= 0.0 {
                            p.trigger = 0.1;
                        }
                    }
                } else if let Some(h) = hull
                    && (dist < 14.0 || (dist > 90.0 && !aimed))
                {
                    // Too close for the gun (its own blast): run them over.
                    let (mx, mz) = drive(h, want_yaw);
                    p.input = InputState {
                        mx,
                        mz,
                        ..Default::default()
                    };
                } else if dist > 90.0 && !aimed {
                    p.input = InputState {
                        mz: 1,
                        ..Default::default()
                    };
                } else {
                    p.input = InputState {
                        ads: true,
                        zoom: 1,
                        fire: ready && aimed,
                        ..Default::default()
                    };
                    if ready && aimed && p.cooldown <= 0.0 {
                        p.trigger = 0.1;
                    }
                }
            }
            None => {
                b.target = None;
                // Investigate what was heard, otherwise fetch a medkit when
                // hurt, otherwise wander.
                let tank_goal = near_tank.filter(|_| p.hp > 30.0).map(|(t, d)| {
                    want_use = d < TANK_ENTER - 0.6;
                    t
                });
                // Behind a tank it went to (hurt): stay there for now.
                let cover = b.cover.filter(|_| !driving && !outside_next).map(|c| c.0);
                let goal = match ring_goal {
                    _ if cover.is_some() => cover.unwrap(),
                    _ if b.detour > 0.0 => b.waypoint,
                    Some(c) if outside_next => c,
                    // Strong bots take the tank before looking into a noise.
                    _ if skill.tactics && tank_goal.is_some() => tank_goal.unwrap(),
                    _ => b
                        .heard
                        .map(|(p, _)| p)
                        .or(medkit)
                        .or(tank_goal)
                        .unwrap_or(b.waypoint),
                };
                // On foot: by the way round when something is in between.
                let goal = if driving {
                    goal
                } else {
                    let nav = self
                        .nav
                        .get_or_init(|| crate::nav::NavGrid::build(&self.map));
                    route(nav, b, pos, goal, skill.plans, dt)
                };
                let d = goal - pos;
                let want_yaw = (-d.x).atan2(-d.z);
                let dy = wrap_angle(want_yaw - p.yaw);
                let step = 2.5 * dt;
                p.yaw = wrap_angle(p.yaw + dy.clamp(-step, step));
                p.pitch *= 0.9;
                let (mx, mut mz) = match hull {
                    Some(h) => drive(h, want_yaw),
                    None => (0, if dy.abs() < 0.6 { 1 } else { 0 }),
                };
                // Strong bots stay down where they are (out of sight) until
                // the medkit has done its work.
                let hold = skill.tactics
                    && !driving
                    && !outside_next
                    && ((p.hp < BOT_HEAL_BELOW && p.inv.medkits > 0)
                        || cover.is_some_and(|c| (c - pos).length_xz() < 0.8));
                if hold {
                    mz = 0;
                }
                p.input = InputState {
                    mx,
                    mz,
                    sneak: hold,
                    ..Default::default()
                };
                // Hurt and out of sight: use a medkit (walking on). Then back
                // to the gun.
                let heal = !driving && p.hp < BOT_HEAL_BELOW && p.inv.medkits > 0;
                if heal && p.heal.is_none() && p.reload.is_none() {
                    if p.inv.sel != Slot::Medkit {
                        p.inv.select(Slot::Medkit);
                    }
                    p.trigger = 0.1;
                } else if !heal && p.heal.is_none() && p.inv.sel == Slot::Medkit {
                    p.inv.select(Slot::Gun0);
                }
                // Reload when idle (not while healing).
                let empty = p
                    .inv
                    .gun_index()
                    .is_some_and(|i| p.inv.guns[i].ammo < p.inv.guns[i].gun.stats().mag / 2);
                if empty && p.reload.is_none() && p.heal.is_none() && !heal {
                    want_reload = true;
                }
            }
        }
        if want_reload {
            self.start_reload(id);
        }
        if want_use {
            self.use_key(id);
        }
        if let Some(power) = want_throw {
            self.throw(id, power);
        }
    }

    // ---- inspection helpers (tests, server console) ----

    pub fn player_pos(&self, id: ClientId) -> Option<Vec3> {
        self.players.get(&id).map(|p| p.pos)
    }

    pub fn player_hp(&self, id: ClientId) -> Option<f32> {
        self.players.get(&id).map(|p| p.hp)
    }

    pub fn player_kills(&self, id: ClientId) -> Option<u32> {
        self.players.get(&id).map(|p| p.kills)
    }

    pub fn teleport(&mut self, id: ClientId, pos: Vec3, yaw: f32) {
        let ground = self.map.height(pos.x, pos.z);
        if let Some(p) = self.players.get_mut(&id) {
            p.pos = Vec3::new(pos.x, ground, pos.z);
            p.yaw = yaw;
            p.pitch = 0.0;
            p.protect = 0.0;
        }
    }

    pub fn give(&mut self, id: ClientId, gun: Gun) {
        if let Some(p) = self.players.get_mut(&id) {
            p.inv.guns = vec![GunSlot::full(gun)];
            p.inv.sel = Slot::Gun0;
        }
    }
}

/// Where a walking bot heads for this tick on its way to `goal`: the goal
/// itself when the way is straight, else the next corner of a route round
/// what stands between (nav.rs). `eager`: it checks the straight way every
/// half second and plans before walking (strong bots); otherwise it plans
/// only once it has got stuck (`b.replan`).
fn route(
    nav: &crate::nav::NavGrid,
    b: &mut Bot,
    pos: Vec3,
    goal: Vec3,
    eager: bool,
    dt: f32,
) -> Vec3 {
    b.path_check -= dt;
    b.path_fail = (b.path_fail - dt).max(0.0);
    // A route to somewhere else is no use.
    if !b.path.is_empty() && (b.path_to - goal).length_xz() > 4.0 {
        b.path.clear();
        b.replan = eager;
    }
    if b.path.is_empty() && b.path_fail <= 0.0 {
        let mut want = b.replan;
        if !want && eager && b.path_check <= 0.0 {
            b.path_check = 0.5;
            want = !nav.clear_line(pos, goal);
        }
        if want {
            b.replan = false;
            match nav.path(pos, goal, crate::nav::BUDGET) {
                Some(p) => {
                    b.path = p;
                    b.path_to = goal;
                }
                None => b.path_fail = 3.0,
            }
        }
    }
    // Corners reached are behind it.
    while let Some(next) = b.path.first() {
        if (*next - pos).length_xz() < 0.9 && b.path.len() > 1 {
            b.path.remove(0);
        } else {
            break;
        }
    }
    if b.path.len() == 1 && (b.path[0] - pos).length_xz() < 0.9 {
        b.path.clear();
    }
    b.path.first().copied().unwrap_or(goal)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn room() -> Room {
        Room::new(Config {
            seed: 3,
            ..Default::default()
        })
    }

    /// Two players face to face in the open, 10 m apart.
    fn duel(r: &mut Room) -> (ClientId, ClientId) {
        let a = r.join("alice", None, PROTOCOL, false).unwrap();
        let b = r.join("bob", None, PROTOCOL, false).unwrap();
        // Find an open spot: 12 m of free line along -Z.
        let mut spot = None;
        'search: for s in r.map.spawns.clone() {
            for i in 0..=12 {
                if r.map.blocked(Vec3::new(s.x, 0.0, s.z - i as f32), 0.6) {
                    continue 'search;
                }
            }
            if (r.map.height(s.x, s.z) - r.map.height(s.x, s.z - 10.0)).abs() > 0.01 {
                continue 'search;
            }
            if r.map
                .line_of_sight(s + Vec3::new(0.0, 1.6, 0.0), s + Vec3::new(0.0, 1.6, -10.0))
            {
                spot = Some(s);
                break;
            }
        }
        let s = spot.expect("open spot");
        r.teleport(a, s, 0.0);
        r.teleport(b, s + Vec3::new(0.0, 0.0, -10.0), std::f32::consts::PI);
        (a, b)
    }

    fn input(ads: bool, pitch: f32) -> ClientMsg {
        ClientMsg::Input {
            mx: 0,
            mz: 0,
            sneak: false,
            yaw: 0.0,
            pitch,
            ads,
            zoom: 2,
            fire: false,
            instant: false,
        }
    }

    #[test]
    fn join_rules() {
        let mut r = Room::new(Config {
            password: Some("pw".into()),
            max_players: 1,
            ..Default::default()
        });
        assert!(r.join("x", Some("bad"), PROTOCOL, false).is_err());
        assert!(r.join("x", Some("pw"), PROTOCOL + 1, false).is_err());
        let id = r.join("x", Some("pw"), PROTOCOL, false).unwrap();
        assert!(r.join("y", Some("pw"), PROTOCOL, false).is_err());
        let out = r.drain();
        assert!(
            out.iter()
                .any(|(t, m)| *t == Target::One(id) && matches!(m, ServerMsg::Welcome { .. }))
        );
    }

    #[test]
    fn walking_moves_and_ads_does_not() {
        let mut r = room();
        let (a, _) = duel(&mut r);
        let start = r.player_pos(a).unwrap();
        r.handle(
            a,
            ClientMsg::Input {
                mx: 0,
                mz: 1,
                sneak: false,
                yaw: 0.0,
                pitch: 0.0,
                ads: true,
                zoom: 1,
                fire: false,
                instant: true,
            },
        );
        for _ in 0..30 {
            r.tick(1.0 / 60.0);
        }
        assert!(r.player_pos(a).unwrap().distance(start) < 1e-3);
        r.handle(
            a,
            ClientMsg::Input {
                mx: 0,
                mz: 1,
                sneak: false,
                yaw: 0.0,
                pitch: 0.0,
                ads: false,
                zoom: 0,
                fire: false,
                instant: true,
            },
        );
        r.tick(1.0 / 60.0);
        // Instant: full speed on the first tick.
        let moved = r.player_pos(a).unwrap().distance(start);
        assert!((moved - RUN_SPEED / 60.0).abs() < 0.01, "moved {moved}");
    }

    #[test]
    fn acceleration_when_smooth() {
        let mut r = room();
        let (a, _) = duel(&mut r);
        let start = r.player_pos(a).unwrap();
        r.handle(
            a,
            ClientMsg::Input {
                mx: 0,
                mz: 1,
                sneak: false,
                yaw: 0.0,
                pitch: 0.0,
                ads: false,
                zoom: 0,
                fire: false,
                instant: false,
            },
        );
        r.tick(1.0 / 60.0);
        let moved = r.player_pos(a).unwrap().distance(start);
        assert!(moved < RUN_SPEED / 60.0 * 0.9);
    }

    #[test]
    fn headshot_with_sr_kills() {
        let mut r = room();
        let (a, b) = duel(&mut r);
        r.give(a, Gun::Sr);
        // Aim at bob's head: 10 m away, head 0.07 m above the eye.
        let pitch = (0.07f32).atan2(10.0);
        r.handle(a, input(true, pitch));
        r.handle(a, ClientMsg::Trigger);
        r.tick(1.0 / 60.0);
        assert_eq!(r.player_kills(a), Some(1));
        let out = r.drain();
        assert!(
            out.iter()
                .any(|(_, m)| matches!(m, ServerMsg::Kill { head: true, dist, .. } if (*dist - 10.0).abs() < 0.05))
        );
        assert!(r.player_hp(b).unwrap() <= 0.0);
    }

    #[test]
    fn body_shot_with_sr_does_not_kill() {
        let mut r = room();
        let (a, b) = duel(&mut r);
        r.give(a, Gun::Sr);
        let pitch = (-0.6f32).atan2(10.0);
        r.handle(a, input(true, pitch));
        r.handle(a, ClientMsg::Trigger);
        r.tick(1.0 / 60.0);
        let hp = r.player_hp(b).unwrap();
        assert!(hp > 0.0 && hp < MAX_HP, "hp {hp}");
    }

    /// A flat field with nothing on it, for long-range shots.
    fn flat_room() -> (Room, ClientId, ClientId) {
        use crate::map::GRID;
        let half = crate::map::HALF;
        let map = Map {
            seed: 0,
            half,
            grid: GRID,
            cell: 2.0 * half / (GRID - 1) as f32,
            heights: vec![0.0; GRID * GRID],
            solids: Vec::new(),
            trees: Vec::new(),
            spawns: vec![Vec3::new(0.0, 0.0, 0.0), Vec3::new(50.0, 0.0, 50.0)],
            pickups: Vec::new(),
            targets: Vec::new(),
            labels: Vec::new(),
            tanks: Vec::new(),
            top: Default::default(),
        };
        let mut r = Room::with_map(Config::default(), map);
        let a = r.join("a", None, PROTOCOL, false).unwrap();
        let b = r.join("b", None, PROTOCOL, false).unwrap();
        r.give(a, Gun::Sr);
        (r, a, b)
    }

    /// Fires one scoped SR shot at `pitch` toward a target `dist` m away
    /// (straight ahead, -Z) and returns (ticks until the hit, headshot).
    fn long_shot(dist: f32, pitch: f32) -> Option<(usize, bool)> {
        let (mut r, a, b) = flat_room();
        r.teleport(a, Vec3::new(0.0, 0.0, 100.0), 0.0);
        r.teleport(b, Vec3::new(0.0, 0.0, 100.0 - dist), std::f32::consts::PI);
        r.handle(a, input(true, pitch));
        r.handle(a, ClientMsg::Trigger);
        r.drain();
        for tick in 1..=120 {
            r.tick(1.0 / 60.0);
            for (_, m) in r.drain() {
                if let ServerMsg::Hit { victim, head, .. } = m
                    && victim == b
                {
                    return Some((tick, head));
                }
            }
        }
        None
    }

    #[test]
    fn ballistics_formula() {
        let p = ballistic(Vec3::ZERO, Vec3::new(0.0, 0.0, -850.0), 0.5);
        assert!((p.z + 425.0).abs() < 1e-3);
        assert!((p.y + 0.5 * GRAVITY * 0.25).abs() < 1e-4);
        // SR at 200 m: about 27 cm below the line of sight.
        assert!((drop_at(200.0, 850.0) - 0.2715).abs() < 0.001);
    }

    #[test]
    fn bullets_take_time_to_arrive() {
        // 210 m at 850 m/s ≈ 0.247 s ≈ 15 ticks: not hit at once.
        let (ticks, _) = long_shot(210.0, (0.07f32).atan2(210.0)).expect("hit");
        assert!((13..=17).contains(&ticks), "arrived after {ticks} ticks");
    }

    #[test]
    fn bullets_drop_with_gravity() {
        let dist = 210.0;
        // Aimed straight at the head: the bullet has fallen ~30 cm by then,
        // so it hits the body instead.
        let (_, head) = long_shot(dist, (0.07f32).atan2(dist)).expect("hit");
        assert!(!head, "an uncorrected long shot should drop below the head");
        // Aimed higher by the drop: headshot.
        let drop = drop_at(dist, Gun::Sr.stats().muzzle_velocity);
        let (_, head) = long_shot(dist, (0.07 + drop).atan2(dist)).expect("hit");
        assert!(head, "aiming over by the drop should hit the head");
    }

    #[test]
    fn spectators_watch_without_a_body() {
        let mut r = room();
        let a = r.join("player", None, PROTOCOL, false).unwrap();
        let w = r.join("watcher", None, PROTOCOL, true).unwrap();
        r.drain();
        r.tick(1.0 / 20.0);
        let out = r.drain();
        let snap_for = |id| {
            out.iter().find_map(|(t, m)| match m {
                ServerMsg::Snap {
                    players,
                    me,
                    watching,
                    ..
                } if *t == Target::One(id) => Some((players.clone(), me.clone(), *watching)),
                _ => None,
            })
        };
        let (players, me, watching) = snap_for(w).expect("watcher gets snapshots");
        assert!(watching && me.is_none());
        assert!(players.iter().all(|p| p.id != w), "a spectator has no body");
        assert!(
            players.iter().any(|p| p.id == a && p.hp.is_some()),
            "watchers see health"
        );
        let (players, _, watching) = snap_for(a).unwrap();
        assert!(!watching);
        assert!(
            players.iter().all(|p| p.hp.is_none()),
            "players do not see health"
        );
        // Offline practice: players see health too.
        let mut r2 = Room::new(Config {
            seed: 3,
            practice: true,
            bots: 2,
            max_players: 1,
            ..Default::default()
        });
        let me = r2.join("me", None, PROTOCOL, false).unwrap();
        r2.drain();
        r2.tick(1.0 / 20.0);
        let hp_seen = r2.drain().iter().any(|(t, m)| {
            matches!(m, ServerMsg::Snap { players, .. }
                if *t == Target::One(me) && players.iter().any(|p| p.id != me && p.hp.is_some()))
        });
        assert!(hp_seen, "practice shows everyone's health");
        // :play joins the match; :watch leaves it.
        r.handle(w, ClientMsg::Play);
        assert!(r.players[&w].alive && !r.players[&w].spectator);
        r.handle(w, ClientMsg::Watch);
        assert!(!r.players[&w].alive && r.players[&w].spectator);
    }

    #[test]
    fn no_respawn_round_ends_with_the_last_one_standing() {
        let mut r = Room::new(Config {
            seed: 3,
            respawn: false,
            ..Default::default()
        });
        let (a, b) = duel(&mut r);
        r.give(a, Gun::Sr);
        r.handle(a, input(true, (0.07f32).atan2(10.0)));
        r.handle(a, ClientMsg::Trigger);
        r.tick(1.0 / 60.0);
        let out = r.drain();
        assert!(r.players[&b].out && !r.players[&b].alive);
        // b does not come back...
        for _ in 0..(RESPAWN_TIME * 60.0) as usize + 30 {
            r.tick(1.0 / 60.0);
        }
        assert!(!r.players[&b].alive);
        // ...and the round is over with a first.
        let ended = out
            .iter()
            .chain(r.drain().iter())
            .find_map(|(_, m)| match m {
                ServerMsg::MatchEnd { ranking, .. } => Some(ranking.clone()),
                _ => None,
            });
        let ranking = ended.expect("round over");
        assert_eq!(ranking[0].id, a);
        // The next round brings everyone back.
        for _ in 0..(INTERMISSION * 60.0) as usize + 5 {
            r.tick(1.0 / 60.0);
        }
        assert!(r.players[&b].alive && !r.players[&b].out);
    }

    #[test]
    fn firing_range_has_dummies_and_endless_ammo() {
        let mut r = Room::new(Config {
            range: true,
            practice: true,
            ..Default::default()
        });
        let me = r.join("me", None, PROTOCOL, false).unwrap();
        assert_eq!(r.bots_wanted as usize, r.map.targets.len());
        for p in r.players.values().filter(|p| p.bot.is_some()) {
            let (home, _) = p.bot.as_ref().unwrap().dummy.unwrap();
            assert!(p.pos.distance(Vec3::new(home.x, p.pos.y, home.z)) < 0.01);
        }
        // At the bench, facing down the range.
        let pos = r.player_pos(me).unwrap();
        assert!((pos.z - 200.0).abs() < 0.01);
        // Strafing dummies move, still ones do not; none of them shoot.
        let still: Vec<_> = r
            .players
            .values()
            .filter(|p| p.bot.as_ref().is_some_and(|b| b.dummy.unwrap().1 == 0.0))
            .map(|p| (p.id, p.pos))
            .collect();
        for _ in 0..120 {
            r.tick(1.0 / 60.0);
        }
        let shots = r
            .drain()
            .into_iter()
            .filter(|(_, m)| matches!(m, ServerMsg::Shot { .. }))
            .count();
        assert_eq!(shots, 0);
        for (id, p0) in still {
            assert!(r.player_pos(id).unwrap().distance(p0) < 0.01);
        }
        let moved = r
            .players
            .values()
            .filter(|p| p.bot.as_ref().is_some_and(|b| b.dummy.unwrap().1 > 0.0))
            .any(|p| {
                let (home, _) = p.bot.as_ref().unwrap().dummy.unwrap();
                (p.pos.x - home.x).abs() > 0.5
            });
        assert!(moved);
        // The reserve never runs out.
        r.players.get_mut(&me).unwrap().inv.guns[0].reserve = 0;
        r.tick(1.0 / 60.0);
        assert_eq!(
            r.players[&me].inv.guns[0].reserve,
            Gun::Ar.stats().reserve_max
        );
        assert!(r.cfg.time_limit > 1.0e8);
    }

    #[test]
    fn bot_skill_levels_are_ordered() {
        for l in 1..5u8 {
            let (a, b) = (bot_skill(l), bot_skill(l + 1));
            assert!(
                a.sight <= b.sight
                    && a.reaction > b.reaction
                    && a.aim_error > b.aim_error
                    && a.turn < b.turn
            );
        }
        assert!(bot_skill(5).lead && !bot_skill(1).lead);
        assert_eq!(bot_skill(0).sight, bot_skill(1).sight);
        assert_eq!(bot_skill(9).sight, bot_skill(5).sight);
    }

    /// Kills by bots in a minute of bots-only play at a skill level.
    fn kills_at(skill: u8) -> usize {
        let mut r = Room::new(Config {
            seed: 5,
            bots: 8,
            bot_skill: skill,
            ..Default::default()
        });
        let mut kills = 0;
        for _ in 0..(60 * 60) {
            r.tick(1.0 / 60.0);
            kills += r
                .drain()
                .iter()
                .filter(|(_, m)| matches!(m, ServerMsg::Kill { .. }))
                .count();
        }
        kills
    }

    #[test]
    fn stronger_bots_kill_more() {
        let weak = kills_at(1);
        let strong = kills_at(5);
        assert!(strong > weak, "skill 5: {strong} kills, skill 1: {weak}");
    }

    #[test]
    fn grenade_explodes_after_fuse() {
        let mut r = room();
        let (a, _) = duel(&mut r);
        r.handle(a, ClientMsg::Throw { power: 1 });
        r.drain();
        let mut exploded = false;
        for _ in 0..(GRENADE_FUSE * 60.0) as usize + 5 {
            r.tick(1.0 / 60.0);
            exploded |= r
                .drain()
                .iter()
                .any(|(_, m)| matches!(m, ServerMsg::Explode { .. }));
        }
        assert!(exploded);
    }

    #[test]
    fn bots_play_a_match() {
        let mut r = Room::new(Config {
            seed: 5,
            bots: 6,
            time_limit: 60.0,
            ..Default::default()
        });
        let me = r.join("me", None, PROTOCOL, false).unwrap();
        let mut kills = 0;
        for _ in 0..(60 * 60) {
            r.tick(1.0 / 60.0);
            kills += r
                .drain()
                .iter()
                .filter(|(_, m)| matches!(m, ServerMsg::Kill { .. }))
                .count();
        }
        assert!(r.player_pos(me).is_some());
        assert!(kills > 0, "bots never fought");
    }

    #[test]
    fn chat_is_rate_limited_and_sanitized() {
        let mut r = room();
        let a = r.join("a", None, PROTOCOL, false).unwrap();
        r.drain();
        for _ in 0..10 {
            r.handle(
                a,
                ClientMsg::Chat {
                    text: "hi\u{0007} there".into(),
                },
            );
        }
        let chats: Vec<_> = r
            .drain()
            .into_iter()
            .filter_map(|(_, m)| {
                if let ServerMsg::Chat { text, .. } = m {
                    Some(text)
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(chats.len(), 3);
        assert_eq!(chats[0], "hi there");
    }

    /// A flat field with the given solids and spawn points.
    fn walled_room(solids: Vec<crate::map::Solid>, spawns: Vec<Vec3>) -> Room {
        use crate::map::GRID;
        let half = crate::map::HALF;
        let map = Map {
            seed: 0,
            half,
            grid: GRID,
            cell: 2.0 * half / (GRID - 1) as f32,
            heights: vec![0.0; GRID * GRID],
            solids,
            trees: Vec::new(),
            spawns,
            pickups: Vec::new(),
            targets: Vec::new(),
            labels: Vec::new(),
            tanks: Vec::new(),
            top: Default::default(),
        };
        Room::with_map(Config::default(), map)
    }

    #[test]
    fn spawn_avoids_points_in_sight() {
        use crate::map::{BoxKind, Solid};
        use crate::math::Aabb;
        // Alice stands at the origin. One spawn point is far but in the
        // open; the other is nearer but behind a wall.
        let open = Vec3::new(0.0, 0.0, 120.0);
        let hidden = Vec3::new(40.0, 0.0, 0.0);
        let wall = Solid {
            kind: BoxKind::Wall,
            aabb: Aabb::new(Vec3::new(30.0, 0.0, -5.0), Vec3::new(31.0, 3.0, 5.0)),
        };
        for _ in 0..20 {
            let mut r = walled_room(vec![wall.clone()], vec![Vec3::ZERO, open, hidden]);
            let a = r.join("alice", None, PROTOCOL, false).unwrap();
            r.players.get_mut(&a).unwrap().pos = Vec3::ZERO;
            let b = r.join("bob", None, PROTOCOL, false).unwrap();
            r.spawn(b);
            assert_eq!(
                r.player_pos(b),
                Some(hidden),
                "bob spawns out of alice's sight"
            );
        }
        // With no cover anywhere, the farthest point still wins.
        let mut r = walled_room(Vec::new(), vec![Vec3::ZERO, open, hidden]);
        let a = r.join("alice", None, PROTOCOL, false).unwrap();
        r.players.get_mut(&a).unwrap().pos = Vec3::ZERO;
        let b = r.join("bob", None, PROTOCOL, false).unwrap();
        r.spawn(b);
        assert_eq!(r.player_pos(b), Some(open));
    }

    #[test]
    fn bots_heal_when_hurt_and_out_of_sight() {
        let mut r = walled_room(Vec::new(), vec![Vec3::ZERO]);
        r.set_bots(1);
        let bot = *r.players.keys().next().unwrap();
        {
            let p = r.players.get_mut(&bot).unwrap();
            p.hp = 35.0;
            p.inv.medkits = 2;
            p.protect = 0.0;
        }
        for _ in 0..(60 * 5) {
            r.tick(1.0 / 60.0);
        }
        let p = &r.players[&bot];
        // 35 + 60 = 95 after one; it stops above BOT_HEAL_BELOW.
        assert!(p.hp > BOT_HEAL_BELOW, "hp {}", p.hp);
        assert_eq!(p.inv.medkits, 1, "one medkit used");
        assert!(
            matches!(p.inv.sel, Slot::Gun0 | Slot::Gun1),
            "back to the gun"
        );
    }
    /// A flat field with one tank parked at (20, 0), ring off.
    fn tank_room() -> (Room, ClientId, ClientId) {
        use crate::map::GRID;
        let half = crate::map::HALF;
        let map = Map {
            seed: 0,
            half,
            grid: GRID,
            cell: 2.0 * half / (GRID - 1) as f32,
            heights: vec![0.0; GRID * GRID],
            solids: Vec::new(),
            trees: Vec::new(),
            spawns: vec![Vec3::new(0.0, 0.0, 0.0), Vec3::new(50.0, 0.0, 50.0)],
            pickups: Vec::new(),
            targets: Vec::new(),
            labels: Vec::new(),
            tanks: vec![Vec3::new(20.0, 0.0, 0.0)],
            top: Default::default(),
        };
        let cfg = Config {
            ring: false,
            ..Default::default()
        };
        let mut r = Room::with_map(cfg, map);
        let a = r.join("a", None, PROTOCOL, false).unwrap();
        let b = r.join("b", None, PROTOCOL, false).unwrap();
        (r, a, b)
    }

    fn drive(mx: i8, mz: i8, yaw: f32, pitch: f32) -> ClientMsg {
        ClientMsg::Input {
            mx,
            mz,
            sneak: false,
            yaw,
            pitch,
            ads: false,
            zoom: 0,
            fire: false,
            instant: false,
        }
    }

    #[test]
    fn tank_is_entered_driven_and_left() {
        let (mut r, a, _b) = tank_room();
        // Too far away: nothing happens.
        r.teleport(a, Vec3::new(0.0, 0.0, 0.0), 0.0);
        r.handle(a, ClientMsg::Use);
        assert!(r.players[&a].tank.is_none());
        r.teleport(a, Vec3::new(17.0, 0.0, 0.0), 0.0);
        r.handle(a, ClientMsg::Use);
        assert_eq!(r.players[&a].tank, Some(0));
        assert_eq!(r.tanks[0].driver, Some(a));
        // Forward: the tank (and its driver) move along the hull's heading.
        let start = r.tanks[0].pos;
        let fwd = Vec3::new(-r.tanks[0].yaw.sin(), 0.0, -r.tanks[0].yaw.cos());
        r.handle(a, drive(0, 1, 0.0, 0.0));
        for _ in 0..120 {
            r.tick(1.0 / 60.0);
        }
        let moved = r.tanks[0].pos - start;
        assert!(moved.length_xz() > 6.0, "moved {}", moved.length_xz());
        assert!(moved.normalize().dot(fwd) > 0.99);
        assert_eq!(r.player_pos(a).unwrap(), r.tanks[0].pos);
        // h/l turn the hull.
        let yaw = r.tanks[0].yaw;
        r.handle(a, drive(-1, 0, 0.0, 0.0));
        for _ in 0..30 {
            r.tick(1.0 / 60.0);
        }
        assert!(wrap_angle(r.tanks[0].yaw - yaw) > 0.3);
        // Out: beside the tank, which stays.
        r.handle(a, ClientMsg::Use);
        assert!(r.players[&a].tank.is_none());
        assert_eq!(r.tanks[0].driver, None);
        let d = (r.player_pos(a).unwrap() - r.tanks[0].pos).length_xz();
        assert!(d > TANK_RADIUS && d < TANK_RADIUS + 1.5, "d {d}");
    }

    #[test]
    fn tank_shell_kills_and_armour_holds_against_bullets() {
        let (mut r, a, b) = tank_room();
        r.teleport(a, Vec3::new(17.0, 0.0, 0.0), 0.0);
        r.handle(a, ClientMsg::Use);
        // b stands 60 m down -Z from the tank; a aims at the feet.
        r.teleport(b, Vec3::new(20.0, 0.0, -60.0), std::f32::consts::PI);
        let pitch =
            (-(TANK_EYE - 0.3) / 60.0f32).atan() + (drop_at(60.0, SHELL_SPEED) / 60.0).atan();
        r.handle(a, drive(0, 0, 0.0, pitch));
        r.handle(a, ClientMsg::Trigger);
        r.drain();
        let mut killed = false;
        let mut shell = false;
        for _ in 0..120 {
            r.tick(1.0 / 60.0);
            for (_, m) in r.drain() {
                match m {
                    ServerMsg::Shell { id, .. } => shell |= id == a,
                    ServerMsg::Kill {
                        killer,
                        victim,
                        cause,
                        ..
                    } => killed |= killer == a && victim == b && cause == Cause::Tank,
                    _ => {}
                }
            }
        }
        assert!(shell && killed, "shell {shell} killed {killed}");
        assert_eq!(r.player_kills(a), Some(1));
        // The gun needs time to load: a trigger before that does nothing.
        assert!(r.tanks[0].cooldown > 0.0);
        r.handle(a, ClientMsg::Trigger);
        r.tick(1.0 / 60.0);
        assert!(r.shells.is_empty());
        for _ in 0..(SHELL_RELOAD * 60.0) as usize {
            r.tick(1.0 / 60.0);
        }
        r.handle(a, ClientMsg::Trigger);
        r.tick(1.0 / 60.0);
        assert_eq!(r.shells.len(), 1);

        // Bullets: the driver is safe inside, the armour takes a little.
        r.players.get_mut(&b).unwrap().respawn = 0.0;
        r.tick(1.0 / 60.0);
        r.teleport(b, Vec3::new(20.0, 0.0, -20.0), std::f32::consts::PI);
        r.handle(
            b,
            ClientMsg::Input {
                mx: 0,
                mz: 0,
                sneak: false,
                yaw: std::f32::consts::PI,
                pitch: 0.0,
                ads: true,
                zoom: 1,
                fire: true,
                instant: false,
            },
        );
        let hp = r.tanks[0].hp;
        for _ in 0..60 {
            r.tick(1.0 / 60.0);
        }
        assert_eq!(r.player_hp(a), Some(MAX_HP));
        assert!(r.tanks[0].hp < hp && r.tanks[0].hp > hp - 100.0);
    }

    #[test]
    fn destroyed_tank_takes_its_driver_and_comes_back() {
        let (mut r, a, b) = tank_room();
        r.teleport(a, Vec3::new(17.0, 0.0, 0.0), 0.0);
        r.handle(a, ClientMsg::Use);
        r.teleport(b, Vec3::new(20.0, 0.0, 80.0), 0.0);
        r.drain();
        r.damage_tank(0, b, TANK_HP + 1.0, Cause::Grenade, Vec3::ZERO);
        assert!(!r.tanks[0].alive);
        assert!(!r.players[&a].alive && r.players[&a].tank.is_none());
        assert_eq!(r.player_kills(b), Some(1));
        assert!(
            r.drain()
                .iter()
                .any(|(_, m)| matches!(m, ServerMsg::Explode { .. }))
        );
        for _ in 0..((TANK_RESPAWN + 1.0) * 60.0) as usize {
            r.tick(1.0 / 60.0);
        }
        let t = &r.tanks[0];
        assert!(t.alive && t.hp == TANK_HP && t.driver.is_none());
        assert_eq!(t.pos, t.home);
    }

    #[test]
    fn tank_runs_people_over_and_blocks_walkers() {
        let (mut r, a, b) = tank_room();
        r.teleport(a, Vec3::new(17.0, 0.0, 0.0), 0.0);
        r.handle(a, ClientMsg::Use);
        // Straight ahead of the hull, 12 m away.
        let t = &r.tanks[0];
        let fwd = Vec3::new(-t.yaw.sin(), 0.0, -t.yaw.cos());
        let spot = t.pos + fwd * 12.0;
        r.teleport(b, spot, 0.0);
        r.handle(a, drive(0, 1, 0.0, 0.0));
        let mut cause = None;
        for _ in 0..240 {
            r.tick(1.0 / 60.0);
            for (_, m) in r.drain() {
                if let ServerMsg::Kill {
                    victim, cause: c, ..
                } = m
                    && victim == b
                {
                    cause = Some(c);
                }
            }
        }
        assert_eq!(cause, Some(Cause::Tank));
        // Walking into a parked tank: stopped at its hull.
        r.handle(a, drive(0, 0, 0.0, 0.0));
        r.handle(a, ClientMsg::Use);
        let tank = r.tanks[0].pos;
        r.teleport(a, tank + Vec3::new(0.0, 0.0, 6.0), 0.0);
        r.handle(a, drive(0, 1, 0.0, 0.0));
        for _ in 0..120 {
            r.tick(1.0 / 60.0);
        }
        let d = (r.player_pos(a).unwrap() - tank).length_xz();
        assert!((TANK_RADIUS + 0.3..TANK_RADIUS + 1.0).contains(&d), "d {d}");
    }

    #[test]
    fn ring_shrinks_and_hurts_outside() {
        let (mut r, a, b) = flat_room();
        let half = r.map.half;
        let unit = r.ring.as_ref().unwrap().unit;
        assert!((r.ring.as_ref().unwrap().r - half * RING_START).abs() < 0.01);
        r.teleport(a, Vec3::new(half - 5.0, 0.0, half - 5.0), 0.0);
        // Until the first shrink starts, the whole field is inside.
        for _ in 0..(unit * 60.0) as usize - 60 {
            r.tick(1.0 / 60.0);
        }
        assert_eq!(r.player_hp(a), Some(MAX_HP));
        // After the first stage: its circle, and the corner is outside.
        for _ in 0..(unit * 60.0) as usize + 120 {
            r.tick(1.0 / 60.0);
        }
        let ring = r.ring.clone().unwrap();
        assert_eq!(ring.stage, 1);
        assert!((ring.r - half * RING_RADII[0]).abs() < 0.01);
        assert!(ring.to_r < ring.r);
        assert!(ring.c.0.abs() <= half && ring.c.1.abs() <= half);
        let hp = r.player_hp(a).unwrap();
        assert!(hp < MAX_HP, "hp {hp}");
        // Inside, nothing is lost.
        r.teleport(b, Vec3::new(ring.c.0, 0.0, ring.c.1), 0.0);
        let hb = r.player_hp(b).unwrap();
        r.drain();
        let mut died = false;
        for _ in 0..(60.0 * 60.0) as usize {
            r.tick(1.0 / 60.0);
            for (_, m) in r.drain() {
                if let ServerMsg::Kill {
                    killer,
                    victim,
                    cause,
                    ..
                } = m
                {
                    died |= victim == a && killer == a && cause == Cause::Ring;
                }
            }
            if died {
                break;
            }
            // Keep the one outside from wandering back with a respawn.
            assert!(r.players[&a].alive);
        }
        assert!(died);
        assert_eq!(r.player_hp(b), Some(hb));
        // Respawns land inside the circle the ring is heading for.
        for _ in 0..(RESPAWN_TIME * 60.0) as usize + 5 {
            r.tick(1.0 / 60.0);
        }
        let (c, rad) = r.safe_circle().unwrap();
        let p = r.player_pos(a).unwrap();
        assert!(r.players[&a].alive);
        assert!((p.x - c.0).hypot(p.z - c.1) <= rad);
    }

    #[test]
    fn ring_goes_through_every_stage_and_bots_stay_inside() {
        let mut r = Room::new(Config {
            seed: 11,
            bots: 6,
            time_limit: 150.0,
            frag_limit: u32::MAX,
            ..Default::default()
        });
        let mut ring_deaths = 0;
        for _ in 0..(140.0 * 60.0) as usize {
            r.tick(1.0 / 60.0);
            for (_, m) in r.drain() {
                if let ServerMsg::Kill { cause, .. } = m
                    && cause == Cause::Ring
                {
                    ring_deaths += 1;
                }
            }
        }
        let ring = r.ring.clone().unwrap();
        assert_eq!(ring.stage, RING_RADII.len());
        assert!((ring.r - r.map.half * RING_RADII[4]).abs() < 0.01);
        assert!(ring_deaths <= 3, "ring deaths {ring_deaths}");
    }

    #[test]
    fn no_ring_and_no_tanks_when_switched_off() {
        let r = Room::new(Config {
            seed: 3,
            ring: false,
            tanks: false,
            ..Default::default()
        });
        assert!(r.ring.is_none() && r.tanks.is_empty());
        let r = Room::new(Config {
            seed: 3,
            ..Default::default()
        });
        assert!(r.ring.is_some());
        assert_eq!(r.tanks.len(), r.map.tanks.len());
        assert!(!r.map.tanks.is_empty());
        // The firing range: a tank to try, no ring.
        let r = Room::new(Config {
            range: true,
            ..Default::default()
        });
        assert!(r.ring.is_none());
        assert_eq!(r.tanks.len(), 1);
    }

    /// One bot inside a closed room whose only door faces away from where
    /// the ring is heading (the room's west wall between it and the safe
    /// circle). Returns when it left the room and whether it got inside the
    /// circle within `secs`.
    fn bot_in_a_room_with_the_ring_behind(skill: u8, secs: f32) -> (Option<f32>, bool) {
        use crate::map::{BoxKind, GRID, Solid};
        let half = crate::map::HALF;
        let wall = |x0: f32, z0: f32, x1: f32, z1: f32| Solid {
            kind: BoxKind::Wall,
            aabb: crate::math::Aabb::new(Vec3::new(x0, -1.0, z0), Vec3::new(x1, 3.4, z1)),
        };
        let map = Map {
            seed: 0,
            half,
            grid: GRID,
            cell: 2.0 * half / (GRID - 1) as f32,
            heights: vec![0.0; GRID * GRID],
            // 12 x 12 m, a 2.2 m door in the east wall only.
            solids: vec![
                wall(-6.0, -6.0, 6.0, -5.6),
                wall(-6.0, 5.6, 6.0, 6.0),
                wall(-6.0, -6.0, -5.6, 6.0),
                wall(5.6, -6.0, 6.0, -1.1),
                wall(5.6, 1.1, 6.0, 6.0),
            ],
            trees: Vec::new(),
            spawns: vec![Vec3::new(-70.0, 0.0, 0.0)],
            pickups: Vec::new(),
            targets: Vec::new(),
            labels: Vec::new(),
            tanks: Vec::new(),
            top: Default::default(),
        };
        let mut r = Room::with_map(
            Config {
                bots: 1,
                bot_skill: skill,
                tanks: false,
                ..Default::default()
            },
            map,
        );
        r.tick(1.0 / 60.0);
        let id = *r.players.keys().next().unwrap();
        // Facing west, at the west wall: the ring comes from behind the door.
        r.teleport(id, Vec3::new(-4.0, 0.0, 0.0), std::f32::consts::FRAC_PI_2);
        let (c, rad) = ((-70.0, 0.0), 30.0);
        r.ring = Some(Ring {
            c: (0.0, 0.0),
            r: 300.0,
            from_c: (0.0, 0.0),
            from_r: 300.0,
            to_c: c,
            to_r: rad,
            stage: 1,
            timer: 1000.0,
            shrinking: false,
            unit: 1000.0,
            acc: 0.0,
        });
        let mut out_at = None;
        for i in 0..(secs * 60.0) as usize {
            r.tick(1.0 / 60.0);
            r.drain();
            let p = r.player_pos(id).unwrap();
            if out_at.is_none() && (p.x.abs() > 6.5 || p.z.abs() > 6.5) {
                out_at = Some(i as f32 / 60.0);
            }
            if (p.x - c.0).hypot(p.z - c.1) < rad - 4.0 {
                return (out_at, true);
            }
        }
        (out_at, false)
    }

    #[test]
    fn bots_find_the_door_when_the_ring_comes_from_behind_a_wall() {
        let mut times = Vec::new();
        for skill in 1..=5 {
            let (out, inside) = bot_in_a_room_with_the_ring_behind(skill, 40.0);
            assert!(
                inside,
                "skill {skill}: never got into the circle (left the room at {out:?})"
            );
            times.push(out.unwrap());
        }
        // Weak bots (1, 2) walk into the wall first and look for the way
        // only once stuck; from 3 up they plan before walking.
        assert!(times[2] + 1.0 < times[0], "{times:?}");
        assert!(times[2] < 4.0, "{times:?}");
    }

    #[test]
    fn bots_take_tanks() {
        // One bot alone on a flat field, a tank parked 20 m from where it
        // starts: it gets in and drives.
        use crate::map::GRID;
        let half = crate::map::HALF;
        let map = Map {
            seed: 0,
            half,
            grid: GRID,
            cell: 2.0 * half / (GRID - 1) as f32,
            heights: vec![0.0; GRID * GRID],
            solids: Vec::new(),
            trees: Vec::new(),
            spawns: vec![Vec3::new(0.0, 0.0, 0.0), Vec3::new(50.0, 0.0, 50.0)],
            pickups: Vec::new(),
            targets: Vec::new(),
            labels: Vec::new(),
            tanks: vec![Vec3::new(20.0, 0.0, 0.0), Vec3::new(50.0, 0.0, 30.0)],
            top: Default::default(),
        };
        let mut r = Room::with_map(
            Config {
                bots: 1,
                ring: false,
                ..Default::default()
            },
            map,
        );
        let mut drove = None;
        let mut far = 0.0f32;
        for _ in 0..(90.0 * 60.0) as usize {
            r.tick(1.0 / 60.0);
            r.drain();
            if let Some(t) = r.tanks.iter().find(|t| t.driver.is_some()) {
                drove = Some(t.id);
                far = far.max((t.pos - t.home).length_xz());
            }
        }
        assert!(drove.is_some());
        assert!(far > 10.0, "far {far}");
    }

    /// Bots on a generated field, for a few minutes: nobody is left stuck
    /// in a tank, and the match goes on.
    #[test]
    fn bots_with_tanks_on_a_real_field() {
        let mut r = Room::new(Config {
            seed: 6,
            bots: 4,
            frag_limit: u32::MAX,
            ..Default::default()
        });
        let mut drivers = 0u32;
        let mut shells = 0;
        for i in 0..(300.0 * 60.0) as usize {
            r.tick(1.0 / 60.0);
            for (_, m) in r.drain() {
                if matches!(m, ServerMsg::Shell { .. }) {
                    shells += 1;
                }
            }
            if i % 60 == 0 {
                drivers += r.tanks.iter().filter(|t| t.driver.is_some()).count() as u32;
            }
            for t in &r.tanks {
                if let Some(d) = t.driver {
                    assert_eq!(r.players[&d].tank, Some(t.id));
                }
            }
        }
        let _ = (drivers, shells);
    }
    /// A flat field, one bot of the given skill, a tank parked at (20, 0).
    fn bot_and_tank(skill: u8) -> (Room, ClientId, ClientId) {
        use crate::map::GRID;
        let half = crate::map::HALF;
        let map = Map {
            seed: 0,
            half,
            grid: GRID,
            cell: 2.0 * half / (GRID - 1) as f32,
            heights: vec![0.0; GRID * GRID],
            solids: Vec::new(),
            trees: Vec::new(),
            spawns: vec![Vec3::new(0.0, 0.0, 0.0), Vec3::new(50.0, 0.0, 50.0)],
            pickups: Vec::new(),
            targets: Vec::new(),
            labels: Vec::new(),
            tanks: vec![Vec3::new(20.0, 0.0, 0.0)],
            top: Default::default(),
        };
        let mut r = Room::with_map(
            Config {
                bots: 1,
                bot_skill: skill,
                ring: false,
                ..Default::default()
            },
            map,
        );
        let bot = *r.players.keys().next().unwrap();
        let a = r.join("a", None, PROTOCOL, false).unwrap();
        (r, bot, a)
    }

    #[test]
    fn strong_bots_hide_behind_a_tank_when_hurt() {
        // The enemy stands 40 m down -Z from the tank; the bot, hurt, a few
        // metres to the tank's side, in the open.
        let run = |skill: u8| {
            let (mut r, bot, a) = bot_and_tank(skill);
            r.teleport(a, Vec3::new(20.0, 0.0, -40.0), std::f32::consts::PI);
            r.teleport(bot, Vec3::new(28.0, 0.0, 6.0), 0.0);
            let p = r.players.get_mut(&bot).unwrap();
            p.hp = 40.0;
            p.inv.medkits = 0;
            // Not into it: behind it.
            p.bot.as_mut().unwrap().no_tank = 1.0e6;
            r.players.get_mut(&a).unwrap().protect = 1.0e6;
            let mut hidden = 0;
            for _ in 0..(8.0 * 60.0) as usize {
                r.tick(1.0 / 60.0);
                r.players.get_mut(&bot).unwrap().hp = 40.0;
                let eye = r.player_pos(a).unwrap() + Vec3::new(0.0, 1.6, 0.0);
                let chest = r.player_pos(bot).unwrap() + Vec3::new(0.0, 1.2, 0.0);
                if r.tank_between(eye, chest, [None, None]) {
                    hidden += 1;
                }
            }
            assert!(r.players[&bot].tank.is_none());
            hidden
        };
        let strong = run(5);
        eprintln!("HIDDEN {strong}");
        assert!(strong > 3 * 60, "hidden for {strong} ticks");
        assert_eq!(run(3), 0);
    }

    #[test]
    fn strong_bots_get_into_a_tank_next_to_a_fight() {
        let run = |skill: u8| {
            let (mut r, bot, a) = bot_and_tank(skill);
            r.teleport(a, Vec3::new(20.0, 0.0, -60.0), std::f32::consts::PI);
            r.teleport(bot, Vec3::new(29.0, 0.0, 6.0), 0.0);
            r.players.get_mut(&a).unwrap().protect = 1.0e6;
            for _ in 0..(6.0 * 60.0) as usize {
                r.tick(1.0 / 60.0);
                if r.players[&bot].tank.is_some() {
                    return true;
                }
            }
            false
        };
        assert!(run(4));
        assert!(!run(2));
    }

    #[test]
    fn strong_bots_throw_grenades_at_tanks() {
        let run = |skill: u8| {
            let (mut r, bot, a) = bot_and_tank(skill);
            r.teleport(a, Vec3::new(17.0, 0.0, 0.0), 0.0);
            r.handle(a, ClientMsg::Use);
            assert!(r.players[&a].tank.is_some());
            r.teleport(bot, Vec3::new(20.0, 0.0, 22.0), 0.0);
            r.players.get_mut(&bot).unwrap().inv.grenades = 3;
            let mut booms = 0;
            for _ in 0..(12.0 * 60.0) as usize {
                r.tick(1.0 / 60.0);
                for (_, m) in r.drain() {
                    if let ServerMsg::Explode { pos } = m {
                        booms += 1;
                        let _ = pos;
                    }
                }
            }
            (booms, TANK_HP - r.tanks[0].hp)
        };
        let (booms, dmg) = run(5);
        assert!(booms >= 2, "booms {booms}");
        // More than the bullets alone would have done.
        let (weak_booms, weak_dmg) = run(3);
        assert_eq!(weak_booms, 0);
        assert!(dmg > weak_dmg + 60.0, "{dmg} vs {weak_dmg}");
    }

    #[test]
    fn stronger_bots_take_tanks_more() {
        // How often a bot gets into a tank, over a few fields.
        let boardings = |skill: u8| {
            let mut total = 0;
            for seed in [5, 6, 7, 8] {
                let mut r = Room::new(Config {
                    seed,
                    bots: 6,
                    bot_skill: skill,
                    frag_limit: u32::MAX,
                    ..Default::default()
                });
                let mut was = vec![false; r.tanks.len()];
                for _ in 0..(180.0 * 60.0) as usize {
                    r.tick(1.0 / 60.0);
                    r.drain();
                    for (i, t) in r.tanks.iter().enumerate() {
                        let now = t.driver.is_some();
                        if now && !was[i] {
                            total += 1;
                        }
                        was[i] = now;
                    }
                }
            }
            total
        };
        let (weak, strong) = (boardings(2), boardings(5));
        assert!(strong > weak, "strong {strong} weak {weak}");
    }
}
