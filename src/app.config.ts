import cors from "cors";
import { defineServer, defineRoom, monitor, playground, WebSocketTransport } from "colyseus";

import { MatchRoom } from "./rooms/MatchRoom.js";
import { MAX_PAYLOAD_BYTES } from "./constants.js";

const server = defineServer({
  transport: new WebSocketTransport({ maxPayload: MAX_PAYLOAD_BYTES }),

  rooms: {
    // The client calls joinOrCreate("match", { token, name, pfp, avatar, party }) through the
    // Bloxity matchmaker endpoint (resolveEndpoint), joinById for invites / Open Rooms, and
    // create("match", { private: true }) for Play with friends.
    match: defineRoom(MatchRoom),
  },

  express: (app) => {
    // Readiness/liveness probe required by Bloxity Legion.
    app.get("/health", (_req, res) => {
      res.sendStatus(200);
    });

    // Bloxity injects CLIENT_ORIGIN in deployed environments; wildcard
    // remains for local dev where the var isn't set.
    app.use(cors({
      origin: process.env.CLIENT_ORIGIN || "*",
    }));

    // Dev-only tooling -- never expose in production.
    if (process.env.NODE_ENV !== "production") {
      app.use("/monitor", monitor());
      app.use("/", playground());
    }
  },
});

export default server;
