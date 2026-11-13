// Server identity (docs.bloxity.io: "Server identity"): the client sends Legion.SDK.auth.getToken()
// in its join options; the server asks Bloxity who that is and uses ONLY the returned user._id.
// A missing or refused token is a guest with a server-made id (never saved, never reported).

export interface Identity {
  userId: string; // Bloxity user id (verified), or GUEST_ID_PREFIX + sessionId
  verified: boolean;
  username: string;
  pfp: string;
  carriedFrom: string[]; // guest ids this browser played as before signing in (up to 5)
  outfitKey?: string; // the player's look as Bloxity verified it (character kit key)
}

// Bloxity outfit keys (character kit): short url-safe strings.
export const OUTFIT_KEY = /^[A-Za-z0-9_.~-]{1,256}$/;

export const GAME_SLUG = process.env.BLOXITY_GAME_ID || "free-fire-zone";
export const apiUrl = () => (process.env.BLOXITY_API_URL || "https://api.bloxity.io").replace(/\/$/, "");

type Verifier = (token: string) => Promise<Omit<Identity, "verified"> | null>;

async function verifyWithBloxity(token: string): Promise<Omit<Identity, "verified"> | null> {
  try {
    const res = await fetch(`${apiUrl()}/v1/auth/game-token/verify`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ gameSlug: GAME_SLUG }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    const u = json?.user;
    if (!json?.valid && json?.valid !== undefined) return null;
    if (!u || typeof u._id !== "string" || !u._id) return null;
    return {
      userId: u._id,
      username: String(u.displayName || u.username || "Player"),
      pfp: typeof u.pfp === "string" ? u.pfp : "",
      carriedFrom: Array.isArray(json.carriedFrom) ? json.carriedFrom.filter((x: unknown) => typeof x === "string").slice(0, 5) : [],
      outfitKey: typeof u.outfitKey === "string" && OUTFIT_KEY.test(u.outfitKey) ? u.outfitKey : "",
    };
  } catch (err) {
    console.warn("[auth] verify failed", (err as Error)?.message ?? err);
    return null;
  }
}

let verifier: Verifier = verifyWithBloxity;
// Test-only seam: fake the Bloxity verify endpoint.
export function __setVerifierForTest(fn: Verifier | null) {
  verifier = fn ?? verifyWithBloxity;
}

export async function verifyToken(token: unknown): Promise<Omit<Identity, "verified"> | null> {
  if (typeof token !== "string" || token.length < 8 || token.length > 4096) return null;
  return verifier(token);
}

// The id Bloxity's leaderboards and stats rank: "legion_<id>", any "#m..." mode suffix removed.
export function reportId(userId: string): string | null {
  const id = userId.split("#m")[0];
  if (!id) return null;
  return id.startsWith("legion_") ? id : `legion_${id}`;
}
