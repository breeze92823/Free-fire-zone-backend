import assert from "assert";

import { MAPS, WORLDS } from "../src/rules.js";
import { Zone } from "../src/zone.js";

// The client (src/game/zone.js) runs the same planner: these only check the server side's rules.
describe("safe zone per world (zone.ts)", () => {
  it("every map names a world with a zone plan", () => {
    for (const m of MAPS) assert.ok(WORLDS[m.world], `world ${m.world}`);
    assert.ok(MAPS.some((m) => m.world === "ridge"), "Dustline Ridge is in the vote");
  });

  it("uses the map's world plan and keeps every circle over that world's land", () => {
    for (const world of ["coral", "ridge"] as const) {
      const w = WORLDS[world];
      for (let seed = 1; seed < 60; seed++) {
        const z = new Zone(seed * 7919, [0, 0], world);
        assert.strictEqual(z.radius, w.zone.start);
        for (let t = 0; t <= 240; t += 0.5) {
          z.update(t);
          assert.ok(Math.hypot(z.cx, z.cz) <= Math.max(0, w.radius - z.radius * 0.6) + 1e-6 || z.radius > w.zone.phases[0].radius, `${world} seed ${seed} t ${t}`);
        }
        assert.strictEqual(Math.round(z.radius), w.zone.phases[w.zone.phases.length - 1].radius);
      }
    }
  });

  it("is deterministic for a seed (the clients plan the same circles)", () => {
    const a = new Zone(12345, [0, 0], "ridge");
    const b = new Zone(12345, [0, 0], "ridge");
    for (let t = 0; t <= 200; t += 5) {
      a.update(t);
      b.update(t);
      assert.deepStrictEqual([a.cx, a.cz, a.radius], [b.cx, b.cz, b.radius]);
    }
  });
});
