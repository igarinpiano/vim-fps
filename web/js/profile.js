// What this browser keeps between visits, under one localStorage key:
//   set     the :set options that differ from their defaults
//   custom  the custom match form
//   skin    the name of the skin in use (the skins themselves, being
//           images and sounds, are in IndexedDB: see skin.js)
//   host    `host` lines of the last .vimfpsrc read (for :mkvimrc)
// The text form of all of it is .vimfpsrc (rc.js).

export const PROFILE_KEY = 'vimfps.profile.v2';
/// Before the profile: one key per thing. Moved in on first load.
const LEGACY = { set: 'vimfps.settings.v1', custom: 'vimfps.custom.v1' };

export class Profile {
  constructor(storage) {
    this.storage = storage || null;
    this.data = {};
    this.load();
  }

  load() {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(PROFILE_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (d && typeof d === 'object') this.data = d;
        return;
      }
      let moved = false;
      for (const [section, key] of Object.entries(LEGACY)) {
        const old = this.storage.getItem(key);
        if (!old) continue;
        try {
          const v = JSON.parse(old);
          if (v && typeof v === 'object') this.data[section] = v;
          moved = true;
        } catch {
          // Unreadable: dropped.
        }
      }
      if (moved && this.save()) for (const key of Object.values(LEGACY)) this.storage.removeItem(key);
    } catch {
      // Unreadable storage: start empty.
    }
  }

  /// Returns whether it was written.
  save() {
    if (!this.storage) return false;
    try {
      this.storage.setItem(PROFILE_KEY, JSON.stringify(this.data));
      return true;
    } catch {
      // Private mode, full: for this page only.
      return false;
    }
  }

  get(section) {
    return this.data[section];
  }

  put(section, value) {
    if (value === undefined || value === null) delete this.data[section];
    else this.data[section] = value;
    this.save();
  }

  /// A store for one section: { read, write } (what Settings takes).
  section(name) {
    return { read: () => this.get(name) || null, write: (v) => this.put(name, v) };
  }
}
