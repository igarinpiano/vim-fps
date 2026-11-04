// 3D view (three.js): the map, players, pickups, grenades, tracers and the
// gun in your hands.

import * as THREE from '../vendor/three.module.min.js';

const COLORS = {
  wall: 0xd9d0b8,
  roof: 0x9a5a3a,
  rock: 0x8b8d90,
  cover: 0xb9a774,
  crate: 0x9c7240,
  trunk: 0x6b4a2b,
  fence: 0x6f7a80,
};

const PICKUP_STYLE = {
  ar: [0x2f6fd6, 'AR'],
  smg: [0x2f6fd6, 'SMG'],
  sg: [0x2f6fd6, 'SG'],
  sr: [0x2f6fd6, 'SR'],
  medkit: [0xd83a3a, '+'],
  grenade: [0x3f7d2c, 'G'],
  ammo: [0xc9a227, '弾'],
};

function playerColor(id) {
  const hues = [0.0, 0.58, 0.12, 0.33, 0.8, 0.5, 0.05, 0.68, 0.22, 0.9];
  return new THREE.Color().setHSL(hues[id % hues.length], 0.65, 0.5);
}

function labelSprite(text, color = '#ffffff', bg = 'rgba(0,0,0,0.45)', scale = 1) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = '28px system-ui, sans-serif';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 16;
  c.width = w;
  c.height = 40;
  ctx.font = font;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, 40);
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 8, 21);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true });
  const s = new THREE.Sprite(mat);
  s.scale.set((w / 40) * 0.45 * scale, 0.45 * scale, 1);
  return s;
}

export class Renderer {
  constructor(canvas, settings) {
    this.s = settings;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x8ec5f5);
    this.scene.fog = new THREE.Fog(0x8ec5f5, 70, 230);
    this.camera = new THREE.PerspectiveCamera(80, 1, 0.05, 600);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);
    this.scene.add(new THREE.HemisphereLight(0xdff0ff, 0x6b8a4a, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(60, 100, 30);
    this.scene.add(sun);
    this.mapGroup = new THREE.Group();
    this.scene.add(this.mapGroup);
    this.players = new Map();
    this.pickups = new Map();
    this.grenades = new Map();
    this.effects = [];
    this.buildViewmodel();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  clear() {
    this.mapGroup.clear();
    for (const p of this.players.values()) this.scene.remove(p.group);
    this.players.clear();
    for (const p of this.pickups.values()) this.scene.remove(p);
    this.pickups.clear();
    for (const g of this.grenades.values()) this.scene.remove(g);
    this.grenades.clear();
    for (const e of this.effects) this.scene.remove(e.obj);
    this.effects = [];
  }

  buildMap(map) {
    this.clear();
    // Ground with a grid so movement is easy to see.
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#6fae4a';
    g.fillRect(0, 0, 128, 128);
    g.strokeStyle = '#64a043';
    g.lineWidth = 2;
    g.strokeRect(0, 0, 128, 128);
    for (let i = 0; i < 60; i++) {
      g.fillStyle = Math.random() < 0.5 ? '#79b852' : '#65a344';
      g.fillRect(Math.random() * 128, Math.random() * 128, 3, 3);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(map.half / 2, map.half / 2);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(map.half * 2 + 200, map.half * 2 + 200),
      new THREE.MeshLambertMaterial({ map: tex }),
    );
    tex.repeat.set((map.half * 2 + 200) / 4, (map.half * 2 + 200) / 4);
    ground.rotation.x = -Math.PI / 2;
    this.mapGroup.add(ground);

    const mats = {};
    for (const [k, col] of Object.entries(COLORS)) mats[k] = new THREE.MeshLambertMaterial({ color: col });
    const box = new THREE.BoxGeometry(1, 1, 1);
    for (const s of map.solids) {
      const m = new THREE.Mesh(box, mats[s.kind] || mats.wall);
      m.scale.set(s.max.x - s.min.x, s.max.y - s.min.y, s.max.z - s.min.z);
      m.position.set((s.min.x + s.max.x) / 2, (s.min.y + s.max.y) / 2, (s.min.z + s.max.z) / 2);
      this.mapGroup.add(m);
    }
    const leaves = new THREE.MeshLambertMaterial({ color: 0x2f7a35 });
    const cone = new THREE.ConeGeometry(1, 1, 7);
    for (const [x, z, r, base] of map.trees) {
      const m = new THREE.Mesh(cone, leaves);
      m.scale.set(r, 5, r);
      m.position.set(x, base + 2.5, z);
      this.mapGroup.add(m);
    }
  }

  buildViewmodel() {
    const vm = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0x2b2f36 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.5), mat);
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.3), mat);
    barrel.position.set(0, 0.02, -0.38);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 0.07), mat);
    grip.position.set(0, -0.1, 0.1);
    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.04, 0.12), new THREE.MeshLambertMaterial({ color: 0x111111 }));
    sight.position.set(0, 0.07, 0);
    vm.add(body, barrel, grip, sight);
    const flash = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 4), new THREE.MeshBasicMaterial({ color: 0xffd36b }));
    flash.position.set(0, 0.02, -0.56);
    flash.visible = false;
    vm.add(flash);
    this.flash = flash;
    vm.scale.setScalar(0.6);
    this.viewmodel = vm;
    this.camera.add(vm);
    this.vmHip = new THREE.Vector3(0.16, -0.14, -0.34);
    this.vmAds = new THREE.Vector3(0, -0.064, -0.26);
    vm.position.copy(this.vmHip);
  }

  ensurePlayer(id, name) {
    let p = this.players.get(id);
    if (p) {
      if (name && p.name !== name) {
        p.group.remove(p.label);
        p.label = labelSprite(name);
        p.label.position.y = 2.15;
        p.group.add(p.label);
        p.name = name;
      }
      return p;
    }
    const group = new THREE.Group();
    const col = playerColor(id);
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.62, 1.45, 0.4), new THREE.MeshLambertMaterial({ color: col }));
    body.position.y = 0.725;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.25, 12, 8), new THREE.MeshLambertMaterial({ color: 0xf0c9a0 }));
    head.position.y = 1.67;
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.6), new THREE.MeshLambertMaterial({ color: 0x222222 }));
    gun.position.set(0.25, 1.25, -0.35);
    group.add(body, head, gun);
    const label = labelSprite(name || `#${id}`);
    label.position.y = 2.15;
    group.add(label);
    this.scene.add(group);
    p = { group, body, head, gun, label, name };
    this.players.set(id, p);
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (p) {
      this.scene.remove(p.group);
      this.players.delete(id);
    }
  }

  setPlayer(id, st, name) {
    const p = this.ensurePlayer(id, name);
    p.group.visible = st.alive;
    p.group.position.set(st.x, st.y, st.z);
    p.group.rotation.y = st.yaw;
    const sneak = st.sneak;
    p.body.scale.y = sneak ? 0.69 : 1;
    p.body.position.y = sneak ? 0.5 : 0.725;
    p.head.position.y = sneak ? 1.22 : 1.67;
    p.gun.position.y = sneak ? 0.85 : 1.25;
    p.gun.position.x = st.ads ? 0.12 : 0.25;
    p.label.position.y = sneak ? 1.7 : 2.15;
  }

  setPickups(list) {
    const seen = new Set();
    for (const pk of list) {
      seen.add(pk.id);
      if (this.pickups.has(pk.id)) continue;
      const [col, text] = PICKUP_STYLE[pk.kind] || [0xffffff, '?'];
      const g = new THREE.Group();
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.5), new THREE.MeshLambertMaterial({ color: col }));
      m.position.y = 0.25;
      const label = labelSprite(text, '#ffffff', 'rgba(0,0,0,0.5)', 0.9);
      label.position.y = 0.85;
      g.add(m, label);
      g.position.set(pk.x, 0, pk.z);
      this.scene.add(g);
      this.pickups.set(pk.id, g);
    }
    for (const [id, g] of this.pickups) {
      if (!seen.has(id)) {
        this.scene.remove(g);
        this.pickups.delete(id);
      }
    }
  }

  setGrenades(list) {
    const seen = new Set();
    for (const g of list) {
      seen.add(g.id);
      let m = this.grenades.get(g.id);
      if (!m) {
        m = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), new THREE.MeshLambertMaterial({ color: 0x2d4a1e }));
        this.scene.add(m);
        this.grenades.set(g.id, m);
      }
      m.position.set(g.x, g.y, g.z);
    }
    for (const [id, m] of this.grenades) {
      if (!seen.has(id)) {
        this.scene.remove(m);
        this.grenades.delete(id);
      }
    }
  }

  tracer(from, to, mine) {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(from.x, from.y - (mine ? 0.15 : 0), from.z),
      new THREE.Vector3(to.x, to.y, to.z),
    ]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xfff2a8, transparent: true, opacity: 0.85 }));
    this.scene.add(line);
    this.effects.push({ obj: line, t: 0, life: 0.06, kind: 'tracer' });
  }

  explosion(pos) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 10),
      new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.8 }),
    );
    m.position.set(pos.x, pos.y + 0.5, pos.z);
    const anim = this.s.get('uianim');
    m.scale.setScalar(anim ? 0.5 : 4);
    this.scene.add(m);
    this.effects.push({ obj: m, t: 0, life: anim ? 0.45 : 0.25, kind: anim ? 'boom' : 'static' });
  }

  muzzle() {
    this.flash.visible = true;
    this.flashTime = 0.04;
  }

  updateEffects(dt) {
    if (this.flashTime > 0) {
      this.flashTime -= dt;
      if (this.flashTime <= 0) this.flash.visible = false;
    }
    for (const e of this.effects) {
      e.t += dt;
      if (e.kind === 'boom') {
        const k = e.t / e.life;
        e.obj.scale.setScalar(0.5 + 6 * k);
        e.obj.material.opacity = 0.8 * (1 - k);
      }
    }
    this.effects = this.effects.filter((e) => {
      if (e.t >= e.life) {
        this.scene.remove(e.obj);
        e.obj.geometry.dispose();
        return false;
      }
      return true;
    });
  }

  /// cam: {x,y,z,yaw,pitch,fov}, vm: {ads 0..1, hide, bob, kick}
  render(cam, vm) {
    this.camera.position.set(cam.x, cam.y, cam.z);
    this.camera.rotation.set(cam.pitch, cam.yaw, 0);
    if (Math.abs(this.camera.fov - cam.fov) > 1e-3) {
      this.camera.fov = cam.fov;
      this.camera.updateProjectionMatrix();
    }
    this.viewmodel.visible = !vm.hide;
    this.viewmodel.position.lerpVectors(this.vmHip, this.vmAds, vm.ads);
    this.viewmodel.position.y += vm.bob;
    this.viewmodel.position.z += vm.kick;
    this.renderer.render(this.scene, this.camera);
  }
}
