# IMPOSTOR // AFTER DARK

A mobile-first social deduction party game for 2–4 players. Players join by room code, receive private role information, submit clues, vote, and compete for the highest score.

## Stack
- Static frontend: HTML, CSS, vanilla JavaScript (no frontend build framework required at runtime)
- Serverless game API: Netlify Function (`netlify/functions/game.ts`)
- Shared room persistence: Netlify Blobs with strong consistency and conditional room creation / write lock
- Polling: clients request the current room state every 1.2 seconds

## Deploy with Netlify
1. Download and extract the ZIP.
2. Go to https://app.netlify.com/drop and upload the extracted project folder or a ZIP if the current Drop UI accepts it.
3. Netlify uses `netlify.toml` to run `npm run build` and publish `dist/`.
4. Open the deployed URL in two separate browser sessions, create a room, and join with the code.

## Local development
Requires Node.js 20 or newer.

```bash
npm install
npm run dev
```

The frontend dev server does not emulate Netlify Functions by itself. For full local multiplayer testing, use the Netlify CLI (`npx netlify dev`) after installing dependencies, or deploy a test site to Netlify.

## Rules
- 3–4 players: one impostor gets the category but not the secret word; operatives receive the word.
- 2 players: head-to-head bluff mode with two related-category words.
- Players submit one clue in turn, discuss, and vote privately.
- Correct operative votes award 2 points; a caught impostor who guesses the word earns a 2-point bonus; an uncaught impostor earns 3 points.
- Three rounds by default; five rounds can be selected by the host.

## Important implementation notes
- No player account is required. The browser stores a random session token so a player can reconnect on the same device.
- Netlify Functions are stateless, so updates use HTTP polling rather than persistent WebSockets.
- Room writes are serialized with a short-lived conditional lock; room creation uses conditional creation to avoid room-code collisions.
- Rooms expire after four hours.
- This is a starter implementation. Before public competition submission, test concurrent joins, expired locks, host disconnects, score edge cases, and the deployed Netlify Blobs behavior. Never treat a successful frontend build as proof of multiplayer correctness.
