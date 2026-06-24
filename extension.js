import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const GAME_DURATION = 60; // seconds

// Difficulty ramps linearly from "start" to "end" over the round.
const SPAWN_MS_START = 1050;
const SPAWN_MS_END = 480;
const RADIUS_MIN = 48;
const RADIUS_MAX = 100;

// Target lifecycle: a quick pop in, then immediately recede (shrink) and vanish.
// No hold beat, a very short grow-in, and a LINEAR recede so the target visibly
// starts slipping away the instant it appears (an eased-in recede crept too slow).
const TARGET_POP_MS = 60;      // grow-in (snappy — keep the delay imperceptible)
const TARGET_RECEDE_MS = 1100; // shrink "into the distance"
const TARGET_VANISH_SCALE = 0.5; // gone once it has shrunk to half size

// Some targets "dodge": sharp lateral jukes during their life (not all of them).
const DODGE_CHANCE = 0.4;   // fraction of targets that dodge
const DODGE_MIN_MS = 280;   // shortest gap between jukes
const DODGE_MAX_MS = 620;   // longest gap between jukes
const DODGE_MIN_PX = 60;    // juke distance range
const DODGE_MAX_PX = 150;
// A dodge steers toward a desired spot with capped ACCELERATION, so velocity
// ramps up from rest and must ramp back through zero to reverse — real inertia.
const DODGE_MAX_SPEED = 13;  // px/frame top speed
const DODGE_ACCEL = 1.3;     // max change in velocity per frame (the inertia)
const DODGE_APPROACH = 0.18; // ease desired speed down within this*dist of target

// Pistol recoil applied to the crosshair (a decaying spring + tremble).
const RECOIL_KICK = 16;        // upward impulse (px) per shot
const RECOIL_STIFFNESS = 0.32; // pull back toward zero each frame
const RECOIL_DAMPING = 0.80;   // velocity retained each frame
const RECOIL_TREMBLE = 5;      // max horizontal jitter while energetic

// Gravity fall after a hit: the target tumbles off the bottom of the screen.
const FALL_GRAVITY = 1.5;      // px per frame, per frame
const FALL_KICK_UP = 5;        // little upward jolt from the impact
const FALL_SPIN = 9;           // max degrees/frame of tumble

// A shot counts as a bullseye (and triggers the voice) at the gold center.
const BULLSEYE_RING = 9;       // ring score (1..10) at/above which it's a bull
const BULLSEYE_VOICE_DELAY_MS = 320; // let the gunshot land before the "Awesome!"

// Ammo: a fixed magazine, right-click to reload, locked out while reloading.
const MAG_SIZE = 12;           // rounds per magazine
const RELOAD_FULL_MS = 2000;   // time to reload a FULL (empty) mag; scales down
                               // proportionally when fewer rounds are missing

// Archery target rings, outer -> inner: [outer radius fraction, RGB].
const TARGET_RINGS = [
    [1.00, [0.96, 0.96, 0.96]], // white
    [0.80, [0.13, 0.13, 0.13]], // black
    [0.60, [0.20, 0.55, 0.85]], // blue
    [0.40, [0.86, 0.20, 0.20]], // red
    [0.20, [0.98, 0.80, 0.15]], // gold
];

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

// ---- The crosshair reticle, drawn with Cairo ------------------------------
const Crosshair = GObject.registerClass(
class Crosshair extends St.DrawingArea {
    _init() {
        super._init({
            width: 54,
            height: 54,
            reactive: false, // never eats clicks; the overlay handles input
        });
        this.connect('repaint', this._draw.bind(this));
    }

    _draw() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const cx = w / 2;
        const cy = h / 2;

        cr.setLineWidth(2);
        cr.setSourceRGBA(0.0, 1.0, 0.55, 0.95);

        // Outer ring
        cr.arc(cx, cy, 20, 0, 2 * Math.PI);
        cr.stroke();

        // Cross arms with a gap in the middle
        const gap = 6;
        const len = 12;
        cr.moveTo(cx, cy - gap); cr.lineTo(cx, cy - gap - len);
        cr.moveTo(cx, cy + gap); cr.lineTo(cx, cy + gap + len);
        cr.moveTo(cx - gap, cy); cr.lineTo(cx - gap - len, cy);
        cr.moveTo(cx + gap, cy); cr.lineTo(cx + gap + len, cy);
        cr.stroke();

        // Center dot
        cr.setSourceRGBA(1.0, 1.0, 1.0, 0.95);
        cr.arc(cx, cy, 1.6, 0, 2 * Math.PI);
        cr.fill();

        cr.$dispose();
    }
});

// Draw the concentric archery rings into a Cairo context centred at (cx, cy).
function drawTargetRings(cr, cx, cy, R) {
    for (const [frac, rgb] of TARGET_RINGS) {
        cr.setSourceRGBA(rgb[0], rgb[1], rgb[2], 1.0);
        cr.arc(cx, cy, R * frac, 0, 2 * Math.PI);
        cr.fill();
        cr.setSourceRGBA(0, 0, 0, 0.85);
        cr.setLineWidth(1.5);
        cr.arc(cx, cy, R * frac, 0, 2 * Math.PI);
        cr.stroke();
    }
}

// ---- An archery target (concentric coloured rings), drawn with Cairo ------
const ArcheryTarget = GObject.registerClass(
class ArcheryTarget extends St.DrawingArea {
    _init(radius) {
        super._init({
            width: radius * 2,
            height: radius * 2,
            reactive: false,
        });
        this._holes = []; // bullet holes in surface-local coords: [x, y]
        this.connect('repaint', this._draw.bind(this));
    }

    // Punch a bullet hole at a point in this actor's (unscaled) surface space.
    addHole(sx, sy) {
        this._holes.push([sx, sy]);
        this.queue_repaint();
    }

    _draw() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const cx = w / 2;
        const cy = h / 2;
        const R = Math.min(w, h) / 2 - 1;

        drawTargetRings(cr, cx, cy, R);

        // Bullet holes on top: a dark pit with a lighter torn rim.
        const hole = Math.max(3, R * 0.07);
        for (const [hx, hy] of this._holes) {
            cr.setSourceRGBA(0.06, 0.06, 0.06, 0.95);
            cr.arc(hx, hy, hole, 0, 2 * Math.PI);
            cr.fill();
            cr.setSourceRGBA(0.75, 0.75, 0.75, 0.55);
            cr.setLineWidth(1.2);
            cr.arc(hx, hy, hole + 0.8, 0, 2 * Math.PI);
            cr.stroke();
        }

        cr.$dispose();
    }
});

// ---- The HUD summary target: rings + a mark for every hit you've landed ----
const HitTarget = GObject.registerClass(
class HitTarget extends St.DrawingArea {
    _init(size) {
        super._init({width: size, height: size, reactive: false});
        this._marks = []; // normalized hit offsets [nx, ny], each in [-1, 1]
        this.connect('repaint', this._draw.bind(this));
    }

    // nx, ny: where the shot landed relative to the target centre (0 = bull).
    addHit(nx, ny) {
        this._marks.push([nx, ny]);
        this.queue_repaint();
    }

    _draw() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const cx = w / 2;
        const cy = h / 2;
        const R = Math.min(w, h) / 2 - 1;

        drawTargetRings(cr, cx, cy, R);

        // Every landed hit as a small dark dot with a light rim.
        const dot = Math.max(2.5, R * 0.045);
        for (const [nx, ny] of this._marks) {
            const hx = cx + nx * R;
            const hy = cy + ny * R;
            cr.setSourceRGBA(0.05, 0.05, 0.05, 0.95);
            cr.arc(hx, hy, dot, 0, 2 * Math.PI);
            cr.fill();
            cr.setSourceRGBA(1, 1, 1, 0.6);
            cr.setLineWidth(1);
            cr.arc(hx, hy, dot + 0.6, 0, 2 * Math.PI);
            cr.stroke();
        }

        cr.$dispose();
    }
});

// ---- The panel button icon: a little archery target -----------------------
const PanelTargetIcon = GObject.registerClass(
class PanelTargetIcon extends St.DrawingArea {
    _init() {
        super._init({
            width: 20,
            height: 20,
            reactive: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.connect('repaint', this._draw.bind(this));
    }

    _draw() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const cx = w / 2;
        const cy = h / 2;
        const R = Math.min(w, h) / 2 - 1;
        const rings = [
            [1.00, [0.86, 0.20, 0.20]], // red
            [0.66, [0.97, 0.97, 0.97]], // white
            [0.34, [0.86, 0.20, 0.20]], // red
        ];
        for (const [frac, c] of rings) {
            cr.setSourceRGBA(c[0], c[1], c[2], 1);
            cr.arc(cx, cy, R * frac, 0, 2 * Math.PI);
            cr.fill();
            cr.setSourceRGBA(0, 0, 0, 0.55);
            cr.setLineWidth(0.8);
            cr.arc(cx, cy, R * frac, 0, 2 * Math.PI);
            cr.stroke();
        }
        // Gold bullseye.
        cr.setSourceRGBA(0.98, 0.80, 0.15, 1);
        cr.arc(cx, cy, R * 0.17, 0, 2 * Math.PI);
        cr.fill();
        cr.$dispose();
    }
});

// ---- A flame burst drawn at the impact point when a shot hits -------------
const HitFlame = GObject.registerClass(
class HitFlame extends St.DrawingArea {
    _init(size) {
        super._init({width: size, height: size, reactive: false});
        // Pre-roll randomized flame tongues so each burst looks a bit different.
        this._spikes = [];
        const n = 10;
        for (let i = 0; i < n; i++) {
            this._spikes.push({
                ang: (i / n) * 2 * Math.PI + (Math.random() - 0.5) * 0.4,
                len: 0.65 + Math.random() * 0.35, // fraction of radius
                w: 0.16 + Math.random() * 0.10,    // half-width fraction
            });
        }
        this.connect('repaint', this._draw.bind(this));
    }

    _draw() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const cx = w / 2;
        const cy = h / 2;
        const R = Math.min(w, h) / 2;

        // Outer flame tongues (deep orange).
        for (const s of this._spikes) {
            const tx = cx + Math.cos(s.ang) * R * s.len;
            const ty = cy + Math.sin(s.ang) * R * s.len;
            const nx = Math.cos(s.ang + Math.PI / 2) * R * s.w;
            const ny = Math.sin(s.ang + Math.PI / 2) * R * s.w;
            cr.moveTo(cx + nx, cy + ny);
            cr.lineTo(tx, ty);
            cr.lineTo(cx - nx, cy - ny);
            cr.closePath();
            cr.setSourceRGBA(1.0, 0.45, 0.05, 0.85);
            cr.fill();
        }
        // Glowing core: orange -> yellow -> white-hot, as nested discs.
        cr.setSourceRGBA(1.0, 0.55, 0.10, 0.95);
        cr.arc(cx, cy, R * 0.50, 0, 2 * Math.PI);
        cr.fill();
        cr.setSourceRGBA(1.0, 0.82, 0.25, 0.95);
        cr.arc(cx, cy, R * 0.32, 0, 2 * Math.PI);
        cr.fill();
        cr.setSourceRGBA(1.0, 0.98, 0.85, 0.98);
        cr.arc(cx, cy, R * 0.16, 0, 2 * Math.PI);
        cr.fill();

        cr.$dispose();
    }
});

// ---- On-screen ammo display: a row of real bullet images ------------------
const AMMO_BULLET_H = 88; // on-screen bullet height (px)
const AMMO_SPACING = 9;   // gap between bullets (px)
const AMMO_BULLET_AR = 23 / 128; // asset aspect ratio (w/h)

const AmmoBar = GObject.registerClass(
class AmmoBar extends St.BoxLayout {
    _init(mag, imagePath) {
        super._init({reactive: false});
        this.set_style(`spacing: ${AMMO_SPACING}px;`);
        this._mag = mag;
        this._count = mag;
        this._reload = -1;     // -1 = not reloading; else refill progress 0..1
        this._reloadFrom = mag; // rounds already in the mag when reload began

        const h = AMMO_BULLET_H;
        const w = Math.max(8, Math.round(h * AMMO_BULLET_AR));
        this.cellWidth = w;
        this.barWidth = mag * w + (mag - 1) * AMMO_SPACING;

        this._cells = [];
        for (let i = 0; i < mag; i++) {
            const cell = new St.Widget({
                width: w,
                height: h,
                reactive: false,
                style: `background-image: url("${imagePath}"); ` +
                    'background-size: contain; ' +
                    'background-repeat: no-repeat; ' +
                    'background-position: center;',
            });
            this.add_child(cell);
            this._cells.push(cell);
        }
        this._refresh(this._count);
    }

    // Light the first `lit` bullets, dim the rest (spent / not yet reloaded).
    _refresh(lit) {
        for (let i = 0; i < this._cells.length; i++)
            this._cells[i].opacity = i < lit ? 255 : 55;
    }

    setCount(n) {
        this._count = n;
        this._reload = -1;
        this._refresh(n);
    }

    // Begin a reload visual: keep the rounds already loaded, fill only the rest.
    startReload(fromCount) {
        this._reloadFrom = fromCount;
        this._reload = 0;
        this._refresh(fromCount);
    }

    setReload(frac) {
        this._reload = frac;
        const lit = this._reloadFrom +
            Math.round(frac * (this._mag - this._reloadFrom));
        this._refresh(lit);
    }
});

// ---- The game ------------------------------------------------------------
class Game {
    constructor(extension) {
        this._ext = extension;
        this._overlay = null;
        this._crosshair = null;
        this._targets = [];
        this._timers = new Set();
        this._spawnId = 0;
        this._tickId = 0;
        this._aimId = 0;
        this._grab = null;
        this._running = false;
        this._phase = 'idle'; // 'playing' | 'over'
        this._cursorTracker = null;
        this._seat = null;
        this._cursorHidden = false;
        this._btnDown = false;
        // Crosshair recoil (decaying spring) — see the aim poll.
        this._recoilOffset = 0;
        this._recoilVel = 0;
        // Ammo
        this._ammo = MAG_SIZE;
        this._reloading = false;
        this._reloadId = 0;
        this._reloadStart = 0;
        this._reloadDur = RELOAD_FULL_MS;
        this._btn3Down = false;
        this._ammoBar = null;
        // Sound
        this._soundPlayer = null;
        this._shotFile = null;
        this._bullseyeFile = null;
        this._reloadFile = null;
        this._emptyFile = null;
        this._score = 0;
        this._combo = 0;
        this._bestCombo = 0;
        this._hits = 0;
        this._shots = 0;
        this._timeLeft = GAME_DURATION;
    }

    start() {
        if (this._running)
            return;
        this._running = true;
        this._phase = 'playing';

        const mon = Main.layoutManager.primaryMonitor;
        this._mon = mon;

        // Sound: a gunshot on every shot, a voice line on a bullseye. Files are
        // bundled under <extension>/sounds and played via Mutter's sound player.
        try {
            this._soundPlayer = global.display.get_sound_player();
            this._shotFile = Gio.File.new_for_path(
                GLib.build_filenamev([this._ext.path, 'sounds', 'shot.wav']));
            this._bullseyeFile = Gio.File.new_for_path(
                GLib.build_filenamev([this._ext.path, 'sounds', 'bullseye.wav']));
            this._reloadFile = Gio.File.new_for_path(
                GLib.build_filenamev([this._ext.path, 'sounds', 'reload.wav']));
            this._emptyFile = Gio.File.new_for_path(
                GLib.build_filenamev([this._ext.path, 'sounds', 'empty.wav']));
        } catch (e) {
            logError(e, '[GnomeShot] could not init sound');
        }

        this._overlay = new St.Widget({
            style_class: 'gnomeshot-overlay',
            reactive: true,
            can_focus: true,
            x: mon.x,
            y: mon.y,
            width: mon.width,
            height: mon.height,
        });
        Main.layoutManager.uiGroup.add_child(this._overlay);

        // ---- Bottom HUD zone: hit-grouping target | stats | ammo ----
        this._dock = new St.BoxLayout({style_class: 'gnomeshot-dock', vertical: true});
        this._dock.set_width(mon.width);

        const row = new St.BoxLayout({style_class: 'gnomeshot-dock-row'});
        row.x_align = Clutter.ActorAlign.CENTER;
        row.x_expand = true;

        // Left: a large target that accumulates every hit you've landed.
        this._hitTarget = new HitTarget(124);
        this._hitTarget.y_align = Clutter.ActorAlign.CENTER;
        row.add_child(this._hitTarget);

        // Middle: the score and round stats. Fixed width so a growing score
        // never reflows the zone (the target/ammo would otherwise shift).
        const stats = new St.BoxLayout({style_class: 'gnomeshot-stats', vertical: true});
        stats.y_align = Clutter.ActorAlign.CENTER;
        stats.set_width(280);
        this._scoreLabel = new St.Label({
            style_class: 'gnomeshot-stat gnomeshot-stat-score'});
        this._comboLabel = new St.Label({style_class: 'gnomeshot-stat'});
        this._timeLabel = new St.Label({style_class: 'gnomeshot-stat'});
        for (const l of [this._scoreLabel, this._comboLabel, this._timeLabel]) {
            l.x_align = Clutter.ActorAlign.CENTER;
            l.x_expand = true;
            stats.add_child(l);
        }
        row.add_child(stats);

        // Right: the ammo magazine.
        const bulletPath = GLib.build_filenamev(
            [this._ext.path, 'assets', 'bullet.png']);
        this._ammoBar = new AmmoBar(MAG_SIZE, bulletPath);
        this._ammoBar.y_align = Clutter.ActorAlign.CENTER;
        row.add_child(this._ammoBar);

        this._dock.add_child(row);
        this._overlay.add_child(this._dock);
        this._dock.set_x(0);
        // Pin the zone to the bottom edge of the overlay.
        this._dock.add_constraint(new Clutter.AlignConstraint({
            source: this._overlay,
            align_axis: Clutter.AlignAxis.Y_AXIS,
            factor: 1.0,
        }));

        // Crosshair on top
        this._crosshair = new Crosshair();
        this._overlay.add_child(this._crosshair);
        const [px, py] = global.get_pointer();
        this._moveCrosshair(px - mon.x, py - mon.y);

        this._updateHud();

        // Hide the system cursor — the crosshair is the pointer now. Pair the
        // cursor-visibility inhibit with a seat unfocus inhibit, exactly as
        // GNOME Shell's own magnifier does, so it stays hidden during input.
        try {
            this._cursorTracker = global.backend.get_cursor_tracker();
            this._seat = Clutter.get_default_backend().get_default_seat();
            this._seat.inhibit_unfocus();
            this._cursorTracker.inhibit_cursor_visibility();
            this._cursorHidden = true;
        } catch (e) {
            logError(e, '[GnomeShot] could not hide cursor');
        }

        // Input grab
        this._grab = Main.pushModal(this._overlay, {
            actionMode: Shell.ActionMode.SYSTEM_MODAL,
        });

        this._overlay.connect('key-press-event', this._onKey.bind(this));
        this._overlay.grab_key_focus();

        // Everything pointer-related is driven from a ~60fps poll of
        // global.get_pointer(), which is reliable under the modal grab where
        // Clutter motion/button event delivery to the overlay is not:
        //   - position the crosshair,
        //   - detect shots (rising edge of the primary button in the mods mask),
        //   - re-hide the cursor if the compositor slips it back during a drag.
        this._btnDown = false;
        this._aimId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            if (!this._running) {
                this._aimId = 0;
                return GLib.SOURCE_REMOVE;
            }
            const [px, py, mods] = global.get_pointer();

            // Advance the recoil spring: kick decays back toward rest, with a
            // little horizontal tremble while there's still energy in it.
            this._recoilVel += -RECOIL_STIFFNESS * this._recoilOffset;
            this._recoilVel *= RECOIL_DAMPING;
            this._recoilOffset += this._recoilVel;
            const energy = Math.abs(this._recoilOffset) + Math.abs(this._recoilVel);
            const trembleX = energy > 0.5
                ? (Math.random() - 0.5) * Math.min(energy, RECOIL_TREMBLE) : 0;
            this._moveCrosshair(
                px - this._mon.x + trembleX,
                py - this._mon.y + this._recoilOffset);

            // Advance dodging targets' inertial movement.
            this._stepDodgers();

            // Advance the reload refill animation while reloading.
            if (this._reloading) {
                const frac = Math.min(1,
                    (GLib.get_monotonic_time() - this._reloadStart) /
                    (this._reloadDur * 1000));
                this._ammoBar.setReload(frac);
            }

            const pressed = (mods & Clutter.ModifierType.BUTTON1_MASK) !== 0;
            if (pressed && !this._btnDown)
                this._onShoot(px - this._mon.x, py - this._mon.y);
            this._btnDown = pressed;

            // Reload on the secondary button (rising edge). Different setups
            // report the right button as BUTTON2 or BUTTON3, so accept either
            // (middle-click reloads too, which is harmless).
            const reloadMask = Clutter.ModifierType.BUTTON2_MASK |
                Clutter.ModifierType.BUTTON3_MASK;
            const r3 = (mods & reloadMask) !== 0;
            if (r3 && !this._btn3Down)
                this._reload();
            this._btn3Down = r3;

            return this._running ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        });

        // 1-second countdown tick
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._timeLeft -= 1;
            if (this._timeLeft <= 0) {
                this._gameOver();
                this._tickId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._updateHud();
            return GLib.SOURCE_CONTINUE;
        });

        this._scheduleSpawn();
    }

    _progress() {
        // 0 at start of round, 1 at the end — drives difficulty.
        return 1 - this._timeLeft / GAME_DURATION;
    }

    _scheduleSpawn() {
        const t = this._progress();
        const delay = Math.round(lerp(SPAWN_MS_START, SPAWN_MS_END, t));
        this._spawnId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            try {
                this._spawnTarget();
            } catch (e) {
                logError(e, '[GnomeShot] spawn failed');
            }
            if (this._running)
                this._scheduleSpawn();
            return GLib.SOURCE_REMOVE;
        });
    }

    _spawnTarget() {
        if (!this._running)
            return;

        const t = this._progress();
        const r = Math.round(lerp(RADIUS_MAX, RADIUS_MIN, t) *
            (0.7 + Math.random() * 0.6));
        const margin = r + 8;
        // Keep targets fully clear of the bottom HUD zone (reserve its height,
        // falling back to an estimate before the dock has been allocated).
        const dockH = (this._dock && this._dock.height) || 170;

        const top = margin;
        const bottom = this._mon.height - dockH - margin;
        const cx = margin + Math.random() * (this._mon.width - 2 * margin);
        const cy = top + Math.random() * Math.max(0, bottom - top);

        const actor = new ArcheryTarget(r);
        actor.set_position(Math.round(cx - r), Math.round(cy - r));
        actor.set_pivot_point(0.5, 0.5); // scale from the center
        actor.scale_x = 0;
        actor.scale_y = 0;

        // Keep targets under the HUD and crosshair
        this._overlay.insert_child_at_index(actor, 0);

        const target = {actor, cx, cy, r, alive: true, jukeId: 0,
            dodger: Math.random() < DODGE_CHANCE,
            // Dodge physics: desired centre (px,py) + current velocity (vx,vy).
            px: cx, py: cy, vx: 0, vy: 0};

        // Phase 1: pop in to full size.
        actor.ease({
            scale_x: 1,
            scale_y: 1,
            duration: TARGET_POP_MS,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
            onComplete: () => {
                if (!target.alive)
                    return;
                // Phase 2: recede into the distance immediately, then vanish.
                // LINEAR (not ease-in) so it starts moving back with no creep.
                actor.ease({
                    scale_x: TARGET_VANISH_SCALE,
                    scale_y: TARGET_VANISH_SCALE,
                    opacity: 120,
                    duration: TARGET_RECEDE_MS,
                    mode: Clutter.AnimationMode.LINEAR,
                    onComplete: () => this._expire(target),
                });
                // Dodgers also juke sideways from time to time.
                if (target.dodger)
                    this._scheduleJuke(target);
            },
        });

        this._targets.push(target);
    }

    // The target's live on-screen radius (it shrinks as it recedes).
    _currentRadius(target) {
        const s = target.actor ? target.actor.scale_x : 1;
        return target.r * (s || 1);
    }

    // The target's live centre (position is animated for dodgers, so read it
    // from the actor rather than the spawn coords; pivot is centred).
    _liveCenter(target) {
        return [target.actor.x + target.r, target.actor.y + target.r];
    }

    // Arrange the next sideways juke for a dodging target.
    _scheduleJuke(target) {
        const gap = DODGE_MIN_MS +
            Math.round(Math.random() * (DODGE_MAX_MS - DODGE_MIN_MS));
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, gap, () => {
            this._timers.delete(id);
            target.jukeId = 0;
            if (!target.alive || !this._running)
                return GLib.SOURCE_REMOVE;
            this._doJuke(target);
            this._scheduleJuke(target); // re-arm
            return GLib.SOURCE_REMOVE;
        });
        target.jukeId = id;
        this._timers.add(id);
    }

    // Pick the next dodge destination — a mostly-sideways spot. The target only
    // springs toward it (see _stepDodge), so the move carries momentum.
    _doJuke(target) {
        const dist = DODGE_MIN_PX +
            Math.random() * (DODGE_MAX_PX - DODGE_MIN_PX);
        const m = target.r + 8;
        const dockH = (this._dock && this._dock.height) || 170;
        const cx = target.actor.x + target.r;
        const cy = target.actor.y + target.r;
        const side = Math.random() < 0.5 ? -1 : 1;
        let px = cx + side * dist;
        // If a side wall is in the way, aim the other direction instead.
        if (px < m || px > this._mon.width - m)
            px = cx - side * dist;
        const py = cy + (Math.random() - 0.5) * dist * 0.5;
        target.px = clamp(px, m, this._mon.width - m);
        target.py = clamp(py, m, this._mon.height - dockH - m);
    }

    // Per-frame integration for one dodger: a damped spring toward (px,py) with
    // a capped speed. Velocity persists frame-to-frame, so it accelerates from
    // rest and must decelerate before reversing — that's the inertia.
    _stepDodge(t) {
        const a = t.actor;
        const m = t.r + 8;
        const dockH = (this._dock && this._dock.height) || 170;
        let cx = a.x + t.r;
        let cy = a.y + t.r;
        // Desired velocity points at the spot, easing down on approach.
        const ex = t.px - cx;
        const ey = t.py - cy;
        const ed = Math.hypot(ex, ey);
        let dvx = 0;
        let dvy = 0;
        if (ed > 0.5) {
            const ds = Math.min(DODGE_MAX_SPEED, ed * DODGE_APPROACH);
            dvx = ex / ed * ds;
            dvy = ey / ed * ds;
        }
        // Accelerate current velocity toward desired, capped per frame.
        let dax = dvx - t.vx;
        let day = dvy - t.vy;
        const am = Math.hypot(dax, day);
        if (am > DODGE_ACCEL) {
            dax = dax / am * DODGE_ACCEL;
            day = day / am * DODGE_ACCEL;
        }
        t.vx += dax;
        t.vy += day;
        cx += t.vx;
        cy += t.vy;
        // Bump against the play-area edges, killing that velocity component.
        if (cx < m) { cx = m; t.vx = 0; }
        else if (cx > this._mon.width - m) { cx = this._mon.width - m; t.vx = 0; }
        const bottom = this._mon.height - dockH - m;
        if (cy < m) { cy = m; t.vy = 0; }
        else if (cy > bottom) { cy = bottom; t.vy = 0; }
        a.set_position(Math.round(cx - t.r), Math.round(cy - t.r));
    }

    _stepDodgers() {
        for (const t of this._targets) {
            if (t.alive && t.dodger)
                this._stepDodge(t);
        }
    }

    _expire(target) {
        if (!target.alive)
            return;
        target.alive = false;
        // A target you let recede away breaks the combo.
        this._combo = 0;
        this._removeTarget(target, false);
        this._updateHud();
    }

    _removeTarget(target, hit) {
        if (target.jukeId) {
            GLib.source_remove(target.jukeId);
            this._timers.delete(target.jukeId);
            target.jukeId = 0;
        }
        const idx = this._targets.indexOf(target);
        if (idx >= 0)
            this._targets.splice(idx, 1);

        const a = target.actor;
        a.remove_all_transitions();
        if (hit) {
            // A hit target tumbles off the bottom of the screen under gravity.
            this._fallAndDestroy(target);
        } else {
            // A target you let recede away just shrinks out.
            a.ease({
                scale_x: 0,
                scale_y: 0,
                opacity: 0,
                duration: 110,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => a.destroy(),
            });
        }
    }

    // Physics-driven fall used when a target is shot: accelerate downward with
    // a little upward jolt, sideways drift and tumble, then destroy off-screen.
    _fallAndDestroy(target) {
        const a = target.actor;
        a.opacity = 255; // crisp for the fall, even if caught mid-recede
        let x = a.x;
        let y = a.y;
        let vy = -FALL_KICK_UP;
        let vx = (Math.random() - 0.5) * 8;
        let spin = (Math.random() - 0.5) * 2 * FALL_SPIN;
        let rot = 0;
        const floor = this._mon.height + a.height + 40;
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            vy += FALL_GRAVITY;
            x += vx;
            y += vy;
            rot += spin;
            a.set_position(Math.round(x), Math.round(y));
            a.rotation_angle_z = rot;
            if (y > floor) {
                this._timers.delete(id);
                a.destroy();
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
        this._timers.add(id);
    }

    _onShoot(x, y) {
        if (this._phase === 'over') {
            this.stop();
            return;
        }
        this._shootAt(x, y);
    }

    // Right-click reload. Allowed any time there's room in the mag and we're
    // not already reloading; firing is locked out until it completes.
    _reload() {
        if (this._phase !== 'playing')
            return;
        const missing = MAG_SIZE - this._ammo;
        if (this._reloading || missing <= 0)
            return;
        this._reloading = true;
        this._reloadStart = GLib.get_monotonic_time();
        // Duration scales with how many rounds need loading: a full mag takes
        // RELOAD_FULL_MS, topping up one round is quick.
        this._reloadDur = Math.max(300,
            Math.round(RELOAD_FULL_MS * missing / MAG_SIZE));
        this._ammoBar.startReload(this._ammo);
        this._playSound(this._reloadFile);
        this._reloadId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._reloadDur, () => {
            this._reloadId = 0;
            this._ammo = MAG_SIZE;
            this._reloading = false;
            this._ammoBar.setCount(this._ammo);
            return GLib.SOURCE_REMOVE;
        });
    }

    _playSound(file) {
        if (!this._soundPlayer || !file)
            return;
        try {
            this._soundPlayer.play_from_file(file, 'GnomeShot', null);
        } catch (e) {
            // best effort — never let audio break the game loop
        }
    }

    // x, y are in overlay-local coordinates. Returns true on a hit.
    _shootAt(x, y) {
        // Mid-reload: the trigger is dead, no sound.
        if (this._reloading)
            return false;
        // Out of rounds: a dry-fire click, no shot.
        if (this._ammo <= 0) {
            this._playSound(this._emptyFile);
            return false;
        }

        this._ammo -= 1;
        this._ammoBar.setCount(this._ammo);
        this._shots += 1;

        // Every trigger pull: kick the crosshair up and crack the gunshot.
        this._recoilVel -= RECOIL_KICK;
        this._playSound(this._shotFile);

        // Find the target whose centre the shot lands closest to (relative to
        // that target's current radius), and only if the shot is inside it.
        // Use each target's LIVE centre so dodgers are hit where they actually
        // are, not where they spawned.
        let best = null;
        let bestNorm = Infinity;
        let bcx = 0;
        let bcy = 0;
        for (const tgt of this._targets) {
            if (!tgt.alive)
                continue;
            const [tcx, tcy] = this._liveCenter(tgt);
            const radius = this._currentRadius(tgt);
            const norm = Math.hypot(tcx - x, tcy - y) / radius;
            if (norm <= 1 && norm < bestNorm) {
                best = tgt;
                bestNorm = norm;
                bcx = tcx;
                bcy = tcy;
            }
        }

        if (best) {
            best.alive = false;
            this._hits += 1;
            this._combo += 1;
            this._bestCombo = Math.max(this._bestCombo, this._combo);
            // Points by placement: bullseye = 10, outer edge = 1.
            const ring = Math.max(1, Math.ceil((1 - bestNorm) * 10));
            const mult = 1 + Math.min(this._combo - 1, 9) * 0.5;
            const pts = Math.round(ring * mult);
            this._score += pts;
            this._popPoints(bcx, bcy, pts, ring);

            // Punch a bullet hole at the impact point. Convert the overlay-space
            // hit into the target's unscaled surface coords (centre = r,r; the
            // hole then scales/tumbles along with the actor).
            const s = best.actor.scale_x || 1;
            best.actor.addHole(best.r + (x - bcx) / s,
                               best.r + (y - bcy) / s);

            // Plot the same hit on the HUD's running grouping target.
            const hr = this._currentRadius(best);
            this._hitTarget.addHit((x - bcx) / hr, (y - bcy) / hr);

            // Flame burst where the bullet touches the target.
            this._flash(x, y, Math.max(70, this._currentRadius(best) * 1.7));

            // Dead-centre hit: reward it with the voice line, a beat after the
            // gunshot so the two don't muddy each other.
            if (ring >= BULLSEYE_RING) {
                const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                    BULLSEYE_VOICE_DELAY_MS, () => {
                        this._timers.delete(id);
                        this._playSound(this._bullseyeFile);
                        return GLib.SOURCE_REMOVE;
                    });
                this._timers.add(id);
            }

            this._removeTarget(best, true);
        } else {
            // A miss breaks the combo too.
            this._combo = 0;
        }
        this._updateHud();
        return !!best;
    }

    // Floating "+N" that drifts up and fades at the hit location.
    _popPoints(x, y, pts, ring) {
        const label = new St.Label({
            style_class: ring >= 9 ? 'gnomeshot-points gnomeshot-points-bull'
                : 'gnomeshot-points',
            text: `+${pts}`,
        });
        this._overlay.add_child(label);
        label.set_position(Math.round(x - 16), Math.round(y - 14));
        label.ease({
            translation_y: -44,
            opacity: 0,
            duration: 650,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => label.destroy(),
        });
    }

    // A short-lived flame burst at the impact point (overlay-local coords).
    _flash(x, y, size) {
        const f = new HitFlame(size);
        this._overlay.add_child(f);
        f.set_pivot_point(0.5, 0.5);
        f.set_position(Math.round(x - size / 2), Math.round(y - size / 2));
        f.scale_x = 0.5;
        f.scale_y = 0.5;
        f.ease({
            scale_x: 1.5,
            scale_y: 1.5,
            opacity: 0,
            duration: 240,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => f.destroy(),
        });
    }

    _moveCrosshair(x, y) {
        if (!this._crosshair)
            return;
        const w = this._crosshair.width;
        const h = this._crosshair.height;
        this._crosshair.set_position(Math.round(x - w / 2), Math.round(y - h / 2));
    }

    _onKey(actor, event) {
        if (event.get_key_symbol() === Clutter.KEY_Escape) {
            if (this._phase === 'playing')
                this._gameOver();
            else
                this.stop();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _updateHud() {
        if (!this._running)
            return;
        this._scoreLabel.text = `Score  ${this._score}`;
        this._comboLabel.text = this._combo > 1 ? `Combo ×${this._combo}` : 'Combo —';
        this._timeLabel.text = `Time  ${Math.max(0, this._timeLeft)}s`;
    }

    _gameOver() {
        if (this._phase !== 'playing')
            return;
        this._phase = 'over';
        // Stop spawning / ticking immediately.
        this._clearTimers();

        // Clear remaining targets without scoring.
        for (const tgt of [...this._targets]) {
            tgt.alive = false;
            this._removeTarget(tgt, false);
        }

        const result = this._ext.recordScore(this._score);
        const best = result.best;
        const acc = this._shots > 0
            ? Math.round((this._hits / this._shots) * 100) : 0;
        const isBest = result.rank === 0;

        // Game Over is a summary screen; the in-play HUD zone just clutters it.
        if (this._dock)
            this._dock.hide();

        const panel = new St.BoxLayout({
            style_class: 'gnomeshot-gameover',
            vertical: true,
        });
        const centered = (actor) => {
            actor.x_align = Clutter.ActorAlign.CENTER;
            actor.x_expand = true;
            return actor;
        };

        panel.add_child(centered(new St.Label({
            style_class: 'gnomeshot-go-title', text: 'GAME OVER'})));

        // Hero score with a caption that calls out a new high score.
        const hero = new St.BoxLayout({
            style_class: 'gnomeshot-go-hero', vertical: true});
        hero.add_child(centered(new St.Label({
            style_class: 'gnomeshot-go-score', text: `${this._score}`})));
        const caption = new St.Label({
            style_class: 'gnomeshot-go-caption',
            text: isBest ? 'NEW BEST SCORE' : 'SCORE'});
        if (isBest)
            caption.add_style_class_name('gnomeshot-go-caption-best');
        hero.add_child(centered(caption));
        panel.add_child(centered(hero));

        // Stat cells.
        const stats = new St.BoxLayout({style_class: 'gnomeshot-go-stats'});
        const cell = (value, label) => {
            const box = new St.BoxLayout({
                style_class: 'gnomeshot-go-cell', vertical: true});
            box.add_child(centered(new St.Label({
                style_class: 'gnomeshot-go-cellval', text: value})));
            box.add_child(centered(new St.Label({
                style_class: 'gnomeshot-go-celllabel', text: label})));
            return box;
        };
        stats.add_child(cell(`${best}`, 'BEST'));
        stats.add_child(cell(`${acc}%`, 'ACCURACY'));
        stats.add_child(cell(`×${this._bestCombo}`, 'BEST COMBO'));
        panel.add_child(centered(stats));

        // Leaderboard: always 10 slots, two columns. Empty slots read 0000000,
        // and your placement (if any) is highlighted.
        panel.add_child(centered(new St.Label({
            style_class: 'gnomeshot-lb-title', text: 'TOP 10'})));
        const cols = new St.BoxLayout({style_class: 'gnomeshot-lb-cols'});
        const colA = new St.BoxLayout({style_class: 'gnomeshot-lb-col', vertical: true});
        const colB = new St.BoxLayout({style_class: 'gnomeshot-lb-col', vertical: true});
        for (let i = 0; i < 10; i++) {
            const row = new St.BoxLayout({style_class: 'gnomeshot-lb-row'});
            row.set_width(150);
            const you = i === result.rank;
            if (you)
                row.add_style_class_name('gnomeshot-lb-you');
            const rk = new St.Label({style_class: 'gnomeshot-lb-rank', text: `${i + 1}`});
            const filled = i < result.board.length;
            // Zero-pad to a fixed width so filled and empty slots line up.
            const scoreText = filled
                ? String(result.board[i]).padStart(8, '0')
                : '00000000';
            const sc = new St.Label({
                style_class: filled
                    ? 'gnomeshot-lb-score'
                    : 'gnomeshot-lb-score gnomeshot-lb-empty',
                text: scoreText});
            sc.x_align = Clutter.ActorAlign.END;
            sc.x_expand = true;
            if (you) {
                rk.add_style_class_name('gnomeshot-lb-val-you');
                sc.add_style_class_name('gnomeshot-lb-val-you');
            }
            row.add_child(rk);
            row.add_child(sc);
            (i < 5 ? colA : colB).add_child(row);
        }
        cols.add_child(colA);
        cols.add_child(colB);
        panel.add_child(centered(cols));

        panel.add_child(centered(new St.Label({
            style_class: 'gnomeshot-go-hint', text: 'Click or press Esc to close'})));

        this._overlay.add_child(panel);
        panel.set_width(520);
        // Centre on the overlay regardless of the panel's measured height.
        for (const axis of [Clutter.AlignAxis.X_AXIS, Clutter.AlignAxis.Y_AXIS]) {
            panel.add_constraint(new Clutter.AlignConstraint({
                source: this._overlay, align_axis: axis, factor: 0.5}));
        }
        // The existing click / key handlers now close the game (phase === 'over').
    }

    _clearTimers() {
        if (this._spawnId) {
            GLib.source_remove(this._spawnId);
            this._spawnId = 0;
        }
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
        if (this._aimId) {
            GLib.source_remove(this._aimId);
            this._aimId = 0;
        }
        if (this._reloadId) {
            GLib.source_remove(this._reloadId);
            this._reloadId = 0;
        }
        this._reloading = false;
        for (const id of this._timers)
            GLib.source_remove(id);
        this._timers.clear();
    }

    stop() {
        this._running = false;
        this._phase = 'idle';
        this._clearTimers();

        // Restore the system cursor.
        if (this._cursorHidden) {
            try {
                this._cursorTracker.uninhibit_cursor_visibility();
                this._seat.uninhibit_unfocus();
            } catch (e) {
                // best effort
            }
            this._cursorHidden = false;
        }
        this._cursorTracker = null;
        this._seat = null;

        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        if (this._overlay) {
            this._overlay.destroy();
            this._overlay = null;
        }
        this._targets = [];
        this._crosshair = null;
        this._ammoBar = null;
        this._hitTarget = null;
        this._dock = null;
        this._ext.onGameStopped();
    }
}

// ---- Panel button --------------------------------------------------------
const GnomeShotButton = GObject.registerClass(
class GnomeShotButton extends PanelMenu.Button {
    _init(onClick) {
        // dontCreateMenu=true disables the built-in menu-toggle click gesture,
        // so we can attach our own click handler instead.
        super._init(0.0, 'GnomeShot', true);
        this._onClick = onClick;
        this.add_child(new PanelTargetIcon());

        // GNOME 50 panel buttons receive clicks via a Clutter gesture, not the
        // button-press-event signal or vfunc_event. Recognize on release (a
        // full click) — recognizing on press would grab input while the mouse
        // button is still down and freeze the in-game crosshair.
        const click = new Clutter.ClickGesture();
        click.connect('recognize', () => this._onClick());
        this.add_action(click);
    }
});

export default class GnomeShotExtension extends Extension {
    enable() {
        this._scores = this._loadScores();
        this._game = null;
        this._button = new GnomeShotButton(() => this._toggle());
        Main.panel.addToStatusArea('gnomeshot', this._button);
    }

    disable() {
        if (this._game) {
            this._game.stop();
            this._game = null;
        }
        if (this._button) {
            this._button.destroy();
            this._button = null;
        }
    }

    _toggle() {
        if (this._game) {
            this._game.stop();
            return;
        }
        try {
            this._game = new Game(this);
            this._game.start();
        } catch (e) {
            logError(e, '[GnomeShot] failed to start game');
            try {
                this._game?.stop();
            } catch (_) {
                // stop() also tears down any partial grab/overlay
            }
            this._game = null;
        }
    }

    // Persistent top-10 high scores (no names), stored as JSON in the user
    // config dir. Returns the placement of `score`: { board, rank, best }.
    recordScore(score) {
        const rank = this._scores.filter(s => s > score).length; // strictly above
        this._scores.push(score);
        this._scores.sort((a, b) => b - a);
        this._scores = this._scores.slice(0, 10);
        this._saveScores();
        return {
            board: this._scores.slice(),
            rank: rank < 10 ? rank : -1,
            best: this._scores[0] || score,
        };
    }

    _scoresFile() {
        return Gio.File.new_for_path(GLib.build_filenamev(
            [GLib.get_user_config_dir(), 'gnomeshot', 'scores.json']));
    }

    _loadScores() {
        try {
            const [ok, bytes] = this._scoresFile().load_contents(null);
            if (ok) {
                const arr = JSON.parse(new TextDecoder().decode(bytes));
                if (Array.isArray(arr)) {
                    return arr.filter(n => Number.isFinite(n))
                        .sort((a, b) => b - a).slice(0, 10);
                }
            }
        } catch (e) {
            // no file yet / unreadable — start fresh
        }
        return [];
    }

    _saveScores() {
        try {
            const f = this._scoresFile();
            const dir = f.get_parent();
            if (!dir.query_exists(null))
                dir.make_directory_with_parents(null);
            f.replace_contents(
                new TextEncoder().encode(JSON.stringify(this._scores)),
                null, false, Gio.FileCreateFlags.NONE, null);
        } catch (e) {
            logError(e, '[GnomeShot] could not save scores');
        }
    }

    onGameStopped() {
        this._game = null;
    }
}
