//! Guns and items. Every player has the same base stats; only what they pick
//! up differs.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Gun {
    Ar,
    Smg,
    Sg,
    Sr,
}

#[derive(Debug, Clone, Copy)]
pub struct GunStats {
    pub name: &'static str,
    /// Damage of one pellet on the body.
    pub damage: f32,
    pub head_mult: f32,
    pub pellets: u32,
    /// Seconds between shots.
    pub interval: f32,
    pub auto: bool,
    pub mag: u32,
    pub reserve_max: u32,
    pub reload: f32,
    /// Spread (degrees, cone half-angle) from the hip, aiming, and scoped.
    pub spread_hip: f32,
    pub spread_ads: f32,
    pub spread_scope: f32,
    /// Damage falls linearly from 1 at `falloff.0` metres to `min_factor` at
    /// `falloff.1`.
    pub falloff: (f32, f32),
    pub min_factor: f32,
    pub range: f32,
}

impl Gun {
    pub const ALL: [Gun; 4] = [Gun::Ar, Gun::Smg, Gun::Sg, Gun::Sr];

    pub fn stats(self) -> GunStats {
        match self {
            Gun::Ar => GunStats {
                name: "AR",
                damage: 26.0,
                head_mult: 2.0,
                pellets: 1,
                interval: 0.1,
                auto: true,
                mag: 30,
                reserve_max: 150,
                reload: 2.2,
                spread_hip: 4.0,
                spread_ads: 0.6,
                spread_scope: 0.4,
                falloff: (35.0, 100.0),
                min_factor: 0.6,
                range: 300.0,
            },
            Gun::Smg => GunStats {
                name: "SMG",
                damage: 19.0,
                head_mult: 1.8,
                pellets: 1,
                interval: 0.07,
                auto: true,
                mag: 32,
                reserve_max: 160,
                reload: 1.8,
                spread_hip: 2.8,
                spread_ads: 1.2,
                spread_scope: 1.0,
                falloff: (15.0, 50.0),
                min_factor: 0.45,
                range: 200.0,
            },
            Gun::Sg => GunStats {
                name: "SG",
                damage: 13.0,
                head_mult: 1.5,
                pellets: 9,
                interval: 0.85,
                auto: false,
                mag: 6,
                reserve_max: 36,
                reload: 2.6,
                spread_hip: 6.0,
                spread_ads: 4.5,
                spread_scope: 4.5,
                falloff: (8.0, 30.0),
                min_factor: 0.15,
                range: 60.0,
            },
            Gun::Sr => GunStats {
                name: "SR",
                damage: 85.0,
                head_mult: 2.5,
                pellets: 1,
                interval: 1.3,
                auto: false,
                mag: 5,
                reserve_max: 25,
                reload: 3.0,
                spread_hip: 10.0,
                spread_ads: 1.2,
                spread_scope: 0.0,
                falloff: (300.0, 400.0),
                min_factor: 1.0,
                range: 400.0,
            },
        }
    }

    pub fn damage_at(self, distance: f32, head: bool) -> f32 {
        let s = self.stats();
        let (a, b) = s.falloff;
        let f = if distance <= a {
            1.0
        } else if distance >= b {
            s.min_factor
        } else {
            1.0 - (1.0 - s.min_factor) * (distance - a) / (b - a)
        };
        s.damage * f * if head { s.head_mult } else { 1.0 }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct GunSlot {
    pub gun: Gun,
    pub ammo: u32,
    pub reserve: u32,
}

impl GunSlot {
    pub fn full(gun: Gun) -> Self {
        let s = gun.stats();
        GunSlot {
            gun,
            ammo: s.mag,
            reserve: s.reserve_max / 2,
        }
    }
}

/// What `f` uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Slot {
    Gun0,
    Gun1,
    Medkit,
    Grenade,
}

pub const MAX_GUNS: usize = 2;
pub const MAX_MEDKITS: u32 = 3;
pub const MAX_GRENADES: u32 = 3;
pub const MEDKIT_HEAL: f32 = 60.0;
pub const MEDKIT_TIME: f32 = 1.6;
pub const GRENADE_FUSE: f32 = 3.0;
pub const GRENADE_RADIUS: f32 = 7.0;
pub const GRENADE_DAMAGE: f32 = 120.0;
/// `dd` without a count throws with this power (1..=5).
pub const DEFAULT_THROW: u32 = 3;
pub const MAX_THROW: u32 = 5;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Inventory {
    pub guns: Vec<GunSlot>,
    pub medkits: u32,
    pub grenades: u32,
    pub sel: Slot,
}

impl Inventory {
    pub fn spawn() -> Self {
        Inventory {
            guns: vec![GunSlot::full(Gun::Ar)],
            medkits: 1,
            grenades: 1,
            sel: Slot::Gun0,
        }
    }

    pub fn gun_index(&self) -> Option<usize> {
        match self.sel {
            Slot::Gun0 if !self.guns.is_empty() => Some(0),
            Slot::Gun1 if self.guns.len() > 1 => Some(1),
            _ => None,
        }
    }

    /// Gun in hand: the selected one, or the first one while an item is
    /// selected (so the body always holds something).
    pub fn held_gun(&self) -> Option<Gun> {
        self.gun_index()
            .or(if self.guns.is_empty() { None } else { Some(0) })
            .map(|i| self.guns[i].gun)
    }

    pub fn select(&mut self, slot: Slot) -> bool {
        let ok = match slot {
            Slot::Gun0 => !self.guns.is_empty(),
            Slot::Gun1 => self.guns.len() > 1,
            Slot::Medkit => self.medkits > 0,
            Slot::Grenade => self.grenades > 0,
        };
        if ok {
            self.sel = slot;
        }
        ok
    }

    /// After an item runs out, fall back to a gun.
    pub fn fix_selection(&mut self) {
        let valid = match self.sel {
            Slot::Gun0 => !self.guns.is_empty(),
            Slot::Gun1 => self.guns.len() > 1,
            Slot::Medkit => self.medkits > 0,
            Slot::Grenade => self.grenades > 0,
        };
        if !valid {
            self.sel = Slot::Gun0;
        }
    }

    /// Adds a gun. Returns the gun that was dropped to make room, if any.
    pub fn take_gun(&mut self, slot: GunSlot) -> Option<GunSlot> {
        if let Some(existing) = self.guns.iter_mut().find(|g| g.gun == slot.gun) {
            existing.reserve =
                (existing.reserve + slot.ammo + slot.reserve).min(slot.gun.stats().reserve_max);
            return None;
        }
        if self.guns.len() < MAX_GUNS {
            self.guns.push(slot);
            self.sel = if self.guns.len() == 1 {
                Slot::Gun0
            } else {
                Slot::Gun1
            };
            return None;
        }
        let i = self.gun_index().unwrap_or(0);
        let old = std::mem::replace(&mut self.guns[i], slot);
        self.sel = if i == 0 { Slot::Gun0 } else { Slot::Gun1 };
        Some(old)
    }

    pub fn refill_ammo(&mut self) -> bool {
        let mut changed = false;
        for g in &mut self.guns {
            let max = g.gun.stats().reserve_max;
            if g.reserve < max {
                g.reserve = max;
                changed = true;
            }
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headshot_hurts_more_and_sr_one_shots() {
        for g in Gun::ALL {
            assert!(g.damage_at(10.0, true) > g.damage_at(10.0, false));
        }
        assert!(Gun::Sr.damage_at(150.0, true) >= 100.0);
        assert!(Gun::Sr.damage_at(150.0, false) < 100.0);
        assert!(Gun::Sg.damage_at(50.0, false) < Gun::Sg.damage_at(5.0, false));
    }

    #[test]
    fn at_most_two_guns() {
        let mut inv = Inventory::spawn();
        assert!(inv.take_gun(GunSlot::full(Gun::Sr)).is_none());
        assert_eq!(inv.guns.len(), 2);
        assert_eq!(inv.sel, Slot::Gun1);
        let dropped = inv.take_gun(GunSlot::full(Gun::Sg)).unwrap();
        assert_eq!(dropped.gun, Gun::Sr);
        assert_eq!(inv.guns.len(), 2);
        assert_eq!(inv.guns[1].gun, Gun::Sg);
    }

    #[test]
    fn selection_falls_back() {
        let mut inv = Inventory::spawn();
        assert!(inv.select(Slot::Grenade));
        inv.grenades = 0;
        inv.fix_selection();
        assert_eq!(inv.sel, Slot::Gun0);
        assert!(!inv.select(Slot::Gun1));
    }
}
