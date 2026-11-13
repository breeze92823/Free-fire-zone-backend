import { ISLAND_RADIUS, ZONE } from "./rules.js";

// The safe zone on the round clock, from the round's seed. The client (src/game/zone.js) runs the
// same planner with the same seeded random numbers, so both agree on every circle without the
// server streaming it. Two random numbers per phase, in this order: angle, distance. Each circle
// heads for the voted map's district (focus), jittered around it, never leaving the last circle.

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Zone {
  cx = 0;
  cz = 0;
  radius = ZONE.start;
  private fromX = 0;
  private fromZ = 0;
  private fromR = ZONE.start;
  private nextX = 0;
  private nextZ = 0;
  private nextR = ZONE.start;
  phase = -1;
  shrinking = false;
  damage = ZONE.damage[0];
  private rand: () => number;

  private focusX: number;
  private focusZ: number;

  constructor(seed: number, focus: [number, number] = [0, 0]) {
    this.rand = mulberry32(seed);
    this.focusX = focus[0];
    this.focusZ = focus[1];
    this.planNext(0);
  }

  private planNext(i: number) {
    const p = ZONE.phases[i];
    const slack = Math.max(0, this.radius - p.radius);
    const a = this.rand() * Math.PI * 2;
    const j = Math.sqrt(this.rand()) * p.radius * 0.45;
    const tx = this.focusX + Math.cos(a) * j - this.cx;
    const tz = this.focusZ + Math.sin(a) * j - this.cz;
    const len0 = Math.hypot(tx, tz);
    const d = Math.min(len0, slack * 0.85);
    let x = this.cx + (len0 > 0 ? (tx / len0) * d : 0);
    let z = this.cz + (len0 > 0 ? (tz / len0) * d : 0);
    const maxC = Math.max(0, ISLAND_RADIUS - p.radius * 0.6);
    const len = Math.hypot(x, z);
    if (len > maxC && len > 0) {
      x = (x / len) * maxC;
      z = (z / len) * maxC;
    }
    this.nextX = x;
    this.nextZ = z;
    this.nextR = p.radius;
  }

  update(t: number) {
    const nextI = this.phase + 1;
    if (!this.shrinking && nextI < ZONE.phases.length && t >= ZONE.phases[nextI].at) {
      this.phase = nextI;
      this.shrinking = true;
      this.fromX = this.cx;
      this.fromZ = this.cz;
      this.fromR = this.radius;
      this.damage = ZONE.damage[Math.min(nextI, ZONE.damage.length - 1)];
    }
    if (this.shrinking) {
      const p = ZONE.phases[this.phase];
      const k = Math.min(1, (t - p.at) / p.shrink);
      this.cx = this.fromX + (this.nextX - this.fromX) * k;
      this.cz = this.fromZ + (this.nextZ - this.fromZ) * k;
      this.radius = this.fromR + (this.nextR - this.fromR) * k;
      if (k >= 1) {
        this.shrinking = false;
        if (this.phase + 1 < ZONE.phases.length) this.planNext(this.phase + 1);
      }
    }
  }

  outside(x: number, z: number, margin = 0) {
    return Math.hypot(x - this.cx, z - this.cz) > this.radius - margin;
  }
}
