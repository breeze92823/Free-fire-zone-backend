import { listen } from "@colyseus/tools";

import app from "./app.config.js";
import { connectDb } from "./db.js";
import { installReporters } from "./reporters.js";

// Player-progress persistence (src/db.ts) connects before the room accepts
// players; connectDb() itself never throws or hangs (degrades to "no persistence").
await connectDb();

// Listens on PORT (or 2567).
await listen(app);

// Bloxity: the Open Rooms directory (room reporter) and the batched leaderboard / stats reports.
installReporters();
