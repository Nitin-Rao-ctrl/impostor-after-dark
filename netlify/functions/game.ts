
import type { Handler } from "@netlify/functions";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";

type Player = {
  id: string;
  name: string;
  score: number;
  connected: boolean;
  joinedAt: number;
  ready?: boolean;
};

type Clue = { playerId: string; playerName: string; text: string };
type Vote = { voterId: string; targetId: string };

type Room = {
  code: string;
  hostId: string;
  players: Player[];
  phase: string;
  roundNumber: number;
  totalRounds: number;
  version: number;
  createdAt: number;
  updatedAt: number;
  currentPlayerId?: string;
  turnOrder?: string[];
  clues: Clue[];
  votes: Vote[];
  impostorId?: string;
  word?: string;
  category?: string;
  roleReady?: string[];
  lastResult?: {
    caught: boolean;
    word: string;
    impostorName: string;
    votes: Record<string, number>;
  };
  roundStartedAt?: number;
  expiresAt: number;
  mode?: string;
};

type Stored = {
  room: Room;
  tokens: Record<string, string>;
  secrets: Record<string, { role: string; word?: string; category?: string }>;
};

type BlobStore = {
  get: (key: string, options?: { type?: "json" | "text" }) => Promise<any>;
  set: (key: string, value: string, options?: { onlyIfNew?: boolean }) => Promise<{ modified: boolean }>;
  setJSON: (key: string, value: unknown, options?: { onlyIfNew?: boolean }) => Promise<{ modified: boolean }>;
  delete: (key: string) => Promise<void>;
};

// LOCAL DEVELOPMENT ONLY: data stays in this process memory and is lost when
// Netlify Dev restarts. Do not use this store for a deployed multiplayer game.
const localData = new Map<string, string>();
const store: BlobStore = {
  async get(key, options) {
    const value = localData.get(key);
    if (value === undefined) return null;
    return options?.type === "text" ? value : JSON.parse(value);
  },
  async set(key, value, options) {
    if (options?.onlyIfNew && localData.has(key)) return { modified: false };
    localData.set(key, value);
    return { modified: true };
  },
  async setJSON(key, value, options) {
    if (options?.onlyIfNew && localData.has(key)) return { modified: false };
    localData.set(key, JSON.stringify(value));
    return { modified: true };
  },
  async delete(key) {
    localData.delete(key);
  },
};

const WORDS: Record<string, string[]> = {
  Food: [
    "Taco", "Pancake", "Sushi", "Popcorn", "Mango",
    "Pizza", "Dumpling", "Brownie", "Noodles", "Waffle",
  ],
  Technology: [
    "Keyboard", "Drone", "Satellite", "Headphones", "Robot",
    "Smartphone", "Router", "Camera", "Laptop", "Microchip",
  ],
  Movies: [
    "Titanic", "Avatar", "Jaws", "Inception", "Frozen",
    "Interstellar", "Coco", "Gladiator", "Shrek", "The Matrix",
  ],
  Places: [
    "Airport", "Library", "Beach", "Museum", "Hospital",
    "Stadium", "Subway", "Desert", "Aquarium", "Castle",
  ],
  "Everyday objects": [
    "Umbrella", "Toothbrush", "Backpack", "Mirror", "Pillow",
    "Scissors", "Candle", "Wallet", "Suitcase", "Clock",
  ],
};

const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  },
  body: JSON.stringify(body),
});

const codeChars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeCode() {
  return Array.from(
    { length: 6 },
    () => codeChars[randomInt(codeChars.length)]
  ).join("");
}

function id() {
  return randomBytes(12).toString("hex");
}

function token() {
  return randomBytes(24).toString("base64url");
}

function cleanName(v: unknown) {
  return String(v ?? "").trim().replace(/[<>]/g, "").slice(0, 18);
}

function publicRoom(r: Room, playerId: string) {
  const { word, impostorId, category, ...safe } = r;

  return {
    ...safe,
    players: safe.players.map((p) => ({
      ...p,
      connected: true,
    })),
    hasVoted: r.votes.some((v) => v.voterId === playerId),
    clueCount: r.clues.length,
    voteCount: r.votes.length,
  };
}

function getSecret(s: Stored, playerId: string) {
  return s.secrets[playerId] || null;
}

async function read(store: BlobStore, code: string): Promise<Stored | null> {
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) {
    return null;
  }

  return (await store.get(code, {
    type: "json",
  })) as Stored | null;
}

async function writeNew(store: BlobStore, key: string, value: Stored) {
  const result = await store.setJSON(key, value, {
    onlyIfNew: true,
  });

  return result.modified;
}

async function acquireRoomLock(store: BlobStore, lockKey: string, lockToken: string) {
  const lockValue = JSON.stringify({
    token: lockToken,
    expiresAt: Date.now() + 10_000,
  });

  // Netlify Blobs supports conditional creation, but not a TTL option on set().
  // Store an expiry in the value so abandoned locks can be recovered.
  let result = await store.set(lockKey, lockValue, { onlyIfNew: true });

  if (result.modified) {
    return lockValue;
  }

  const existing = await store.get(lockKey, { type: "text" });
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as { expiresAt?: number };
      if (typeof parsed.expiresAt === "number" && parsed.expiresAt < Date.now()) {
        await store.delete(lockKey);
        result = await store.set(lockKey, lockValue, { onlyIfNew: true });
        if (result.modified) {
          return lockValue;
        }
      }
    } catch {
      // An unreadable lock is treated as busy rather than overwritten unsafely.
    }
  }

  throw new Error("Room is busy updating. Please try again in a moment.");
}

async function mutate(
  store: BlobStore,
  code: string,
  playerId: string,
  authToken: string,
  fn: (s: Stored) => unknown | Promise<unknown>
) {
  const lockKey = `lock-${code}`;
  const lockToken = token();
  const lockValue = await acquireRoomLock(store, lockKey, lockToken);

  try {
    const s = await read(store, code);

    if (!s) {
      throw new Error("Room not found. Check the code or create a new room.");
    }

    const known = s.tokens[playerId];

    if (
      !known ||
      !authToken ||
      known.length !== authToken.length ||
      !timingSafeEqual(Buffer.from(known), Buffer.from(authToken))
    ) {
      throw new Error("Your session expired. Rejoin the room with its code.");
    }

    const result = await fn(s);

    s.room.version += 1;
    s.room.updatedAt = Date.now();

    await store.setJSON(code, s);

    return { result, stored: s };
  } finally {
    const current = await store.get(lockKey, { type: "text" });
    if (current === lockValue) {
      await store.delete(lockKey);
    }
  }
}

function requireHost(s: Stored, pid: string) {
  if (s.room.hostId !== pid) {
    throw new Error("Only the room host can do that.");
  }
}

function requirePhase(s: Stored, phase: string) {
  if (s.room.phase !== phase) {
    throw new Error("That action is not available in the current phase.");
  }
}

function startRound(s: Stored) {
  const r = s.room;

  r.clues = [];
  r.votes = [];
  r.roleReady = [];
  r.lastResult = undefined;
  r.roundStartedAt = Date.now();

  if (r.players.length === 2) {
    r.mode = "duel";

    const categories = Object.keys(WORDS);
    const cat = categories[randomInt(categories.length)];
    const pool = WORDS[cat];

    const first = pool[randomInt(pool.length)];
    let second = pool[randomInt(pool.length)];

    while (second === first) {
      second = pool[randomInt(pool.length)];
    }

    r.word = first;
    r.category = cat;
    r.impostorId = undefined;

    s.secrets[r.players[0].id] = {
      role: "duelist",
      word: first,
      category: cat,
    };

    s.secrets[r.players[1].id] = {
      role: "duelist",
      word: second,
      category: cat,
    };
  } else {
    r.mode = "impostor";

    const categories = Object.keys(WORDS);
    const cat = categories[randomInt(categories.length)];
    const pool = WORDS[cat];

    r.word = pool[randomInt(pool.length)];
    r.category = cat;
    r.impostorId = r.players[randomInt(r.players.length)].id;

    for (const p of r.players) {
      s.secrets[p.id] =
        p.id === r.impostorId
          ? { role: "impostor", category: cat }
          : { role: "operative", word: r.word, category: cat };
    }
  }

  r.turnOrder = [...r.players]
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((p) => p.id);

  r.currentPlayerId = r.turnOrder[0];
  r.phase = "role";
}

function awardReveal(s: Stored) {
  const r = s.room;
  const counts: Record<string, number> = {};

  for (const v of r.votes) {
    counts[v.targetId] = (counts[v.targetId] || 0) + 1;
  }

  if (r.mode === "duel") {
    const first = s.secrets[r.players[0].id];
    const second = s.secrets[r.players[1].id];

    const targetWordGuess = (r as any).wordGuess as
      | Record<string, string>
      | undefined;

    if (targetWordGuess) {
      for (const p of r.players) {
        const opponentId =
          p.id === r.players[0].id
            ? r.players[1].id
            : r.players[0].id;

        if (targetWordGuess[p.id] === s.secrets[opponentId]?.word) {
          p.score += 2;
        }
      }
    }

    r.lastResult = {
      caught: false,
      word: `${first.word} / ${second.word}`,
      impostorName: "No impostor in duel mode",
      votes: counts,
    };
  } else {
    const max = Math.max(0, ...Object.values(counts));

    const top = Object.keys(counts).filter(
      (k) => counts[k] === max
    );

    const caught =
      top.length === 1 &&
      top[0] === r.impostorId &&
      max > 0;

    if (caught) {
      for (const v of r.votes) {
        if (v.targetId === r.impostorId) {
          const p = r.players.find((x) => x.id === v.voterId);

          if (p) {
            p.score += 2;
          }
        }
      }

      const impostorGuess = (r as any).impostorGuess as
        | string
        | undefined;

      if (
        impostorGuess &&
        impostorGuess.trim().toLowerCase() === r.word?.toLowerCase()
      ) {
        const p = r.players.find((x) => x.id === r.impostorId);

        if (p) {
          p.score += 2;
        }
      }
    } else {
      const p = r.players.find((x) => x.id === r.impostorId);

      if (p) {
        p.score += 3;
      }
    }

    r.lastResult = {
      caught,
      word: r.word || "",
      impostorName:
        r.players.find((p) => p.id === r.impostorId)?.name || "Unknown",
      votes: counts,
    };
  }

  r.phase = "reveal";
}

async function mainHandler(event: any) {
  if (event.httpMethod === "OPTIONS") {
    return json(204, {});
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Use POST for game actions." });
  }

  let body: any;

  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body." });
  }

  const action = String(body.action || "");
  const code = String(body.roomCode || "").toUpperCase();
  const pid = String(body.playerId || "");
  const auth = String(body.token || "");

  try {
    if (action === "create") {
      const name = cleanName(body.name);

      if (!name) {
        throw new Error("Choose a codename first.");
      }

      const totalRounds = Number(body.totalRounds) === 5 ? 5 : 3;

      for (let attempt = 0; attempt < 5; attempt++) {
        const c = makeCode();
        const playerId = id();
        const secretToken = token();
        const now = Date.now();

        const room: Room = {
          code: c,
          hostId: playerId,
          players: [
            {
              id: playerId,
              name,
              score: 0,
              connected: true,
              joinedAt: now,
            },
          ],
          phase: "lobby",
          roundNumber: 0,
          totalRounds,
          version: 1,
          createdAt: now,
          updatedAt: now,
          clues: [],
          votes: [],
          expiresAt: now + 1000 * 60 * 60 * 4,
        };

        const stored: Stored = {
          room,
          tokens: { [playerId]: secretToken },
          secrets: {},
        };

        const result = await writeNew(store, c, stored);

        if (result) {
          return json(200, {
            room: publicRoom(room, playerId),
            player: { id: playerId, name },
            token: secretToken,
          });
        }
      }

      throw new Error("Couldn't generate a room code. Please try again.");
    }

    if (action === "join") {
      const name = cleanName(body.name);

      if (!name) {
        throw new Error("Choose a codename first.");
      }

      const s = await read(store, code);

      if (!s) {
        throw new Error("Room not found. Check the code.");
      }

      if (Date.now() > s.room.expiresAt) {
        throw new Error("This room has expired.");
      }

      if (s.room.phase !== "lobby") {
        throw new Error("This match has already started.");
      }

      if (s.room.players.length >= 4) {
        throw new Error("This room is full (4 players maximum).");
      }

      const playerId = id();
      const secretToken = token();
      const now = Date.now();

      const outcome = await mutate(
        store,
        code,
        s.room.hostId,
        s.tokens[s.room.hostId],
        async (current) => {
          if (
            current.room.phase !== "lobby" ||
            current.room.players.length >= 4
          ) {
            throw new Error("This room is no longer available.");
          }

          current.room.players.push({
            id: playerId,
            name,
            score: 0,
            connected: true,
            joinedAt: now,
          });

          current.tokens[playerId] = secretToken;

          return null;
        }
      );

      return json(200, {
        room: publicRoom(outcome.stored.room, playerId),
        player: { id: playerId, name },
        token: secretToken,
      });
    }

    if (action === "state") {
      const s = await read(store, code);

      if (!s) {
        throw new Error("Room not found. It may have expired.");
      }

      if (!s.tokens[pid] || s.tokens[pid] !== auth) {
        throw new Error("Session not found. Join the room again.");
      }

      const secret = getSecret(s, pid);

      return json(200, {
        room: publicRoom(s.room, pid),
        player: {
          id: pid,
          name: s.room.players.find((p) => p.id === pid)?.name,
        },
        secret,
        serverTime: Date.now(),
      });
    }

    const out = await mutate(store, code, pid, auth, (s) => {
      const r = s.room;
      const p = r.players.find((x) => x.id === pid);

      if (!p) {
        throw new Error("You're no longer in this room.");
      }

      if (action === "leave") {
        r.players = r.players.filter((x) => x.id !== pid);

        delete s.tokens[pid];
        delete s.secrets[pid];

        if (r.hostId === pid && r.players.length) {
          r.hostId = r.players[0].id;
        }

        if (r.players.length === 0) {
          r.phase = "finished";
        }
      } else if (action === "start") {
        requireHost(s, pid);
        requirePhase(s, "lobby");

        if (r.players.length < 2) {
          throw new Error("At least two players are required.");
        }

        r.roundNumber = 1;

        for (const pl of r.players) {
          pl.score = 0;
        }

        startRound(s);
      } else if (action === "ready") {
        requirePhase(s, "role");

        if (!r.roleReady) {
          r.roleReady = [];
        }

        if (!r.roleReady.includes(pid)) {
          r.roleReady.push(pid);
        }

        if (r.roleReady.length >= r.players.length) {
          r.phase = "clues";
          r.currentPlayerId = r.turnOrder?.[0];
        }
      } else if (action === "clue") {
        requirePhase(s, "clues");

        if (r.currentPlayerId !== pid) {
          throw new Error("It's not your turn yet.");
        }

        if (r.clues.some((c) => c.playerId === pid)) {
          throw new Error("You've already submitted a clue this round.");
        }

        const clueText = String(body.text || "").trim().slice(0, 70);

        if (!clueText) {
          throw new Error("Enter a clue first.");
        }

        if (r.word && clueText.toLowerCase() === r.word.toLowerCase()) {
          throw new Error("Don't submit the secret word itself.");
        }

        r.clues.push({
          playerId: pid,
          playerName: p.name,
          text: clueText,
        });

        const order = r.turnOrder || [];

        const next = order.find(
          (player) => !r.clues.some((c) => c.playerId === player)
        );

        if (next) {
          r.currentPlayerId = next;
        } else {
          r.phase = "discussion";
        }
      } else if (action === "advanceClues") {
        requireHost(s, pid);
        requirePhase(s, "clues");
        r.phase = "discussion";
      } else if (action === "openVoting") {
        requireHost(s, pid);
        requirePhase(s, "discussion");
        r.phase = "voting";
      } else if (action === "vote") {
        requirePhase(s, "voting");

        const target = String(body.targetId || "");

        if (target === pid || !r.players.some((x) => x.id === target)) {
          throw new Error("Choose another player in this room.");
        }

        if (r.votes.some((v) => v.voterId === pid)) {
          throw new Error("Your vote is already locked.");
        }

        r.votes.push({ voterId: pid, targetId: target });

        if (r.votes.length >= r.players.length) {
          awardReveal(s);
        }
      } else if (action === "reveal") {
        requireHost(s, pid);
        requirePhase(s, "voting");
        awardReveal(s);
      } else if (action === "nextRound") {
        requireHost(s, pid);
        requirePhase(s, "reveal");

        if (r.roundNumber >= r.totalRounds) {
          r.phase = "finished";
        } else {
          r.roundNumber += 1;
          startRound(s);
        }
      } else if (action === "restart") {
        requireHost(s, pid);
        requirePhase(s, "finished");

        r.roundNumber = 1;
        r.phase = "lobby";
        r.clues = [];
        r.votes = [];
        r.lastResult = undefined;

        for (const pl of r.players) {
          pl.score = 0;
        }
      } else {
        throw new Error("Unknown game action.");
      }

      return null;
    });

    const s = out.stored;

    return json(200, {
      room: publicRoom(s.room, pid),
      player: {
        id: pid,
        name: s.room.players.find((x) => x.id === pid)?.name,
      },
      token: auth,
      secret: getSecret(s, pid),
    });
  } catch (e: any) {
    const message = String(e?.message || "Unexpected server error.");

    const status =
      /not found|expired|session|full|already started/i.test(message)
        ? 409
        : 400;

    return json(status, { error: message });
  }
}

export const handler: Handler = async (event) => mainHandler(event);
