# Multiplayer Fighting Game

This branch now contains a realtime 2-player fighting game with persistent room sessions.

## Features

- Username-based lobby
- Invite room creation and join by code/link
- Realtime movement + attacks over Socket.IO
- Health bars and winner state
- Reconnect support (player can disconnect and return to same slot)
- Disconnect grace window (slot is reserved for 90 seconds)
- Match countdown (`3, 2, 1`) before every round
- Rematch flow (request/accept/decline) after each round
- Room closes for both players when one player leaves
- Controls:
  - `ArrowLeft` move left
  - `ArrowRight` move right
  - `ArrowUp` jump
  - `A` punch
  - `D` front kick

## Run locally

```bash
npm install
npm run dev:all
```

Then open:

- Frontend: `http://localhost:5173`
- Socket server: `http://localhost:3000`

In local dev, Vite proxies Socket.IO to the backend automatically.

## Production / Docker

```bash
npm run build
npm run start
```

Docker image runs on port `3000`.
