# Uno Night

Multiplayer card game for you and your friends. One Node file, no dependencies.

## Run it

    node server.js          # http://localhost:3000  (set PORT to change)

Needs Node 18+. Open the page, enter a name, **Create a room**, then send friends the invite link or the 4-letter code.

## Play with friends over the internet

Pick one:

- **Quick, from your own computer:** run the server, then expose it with a tunnel such as `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`. Share the URL it prints.
- **Always-on server:** deploy this folder to any Node host (Render, Railway, Fly.io, a VPS). Start command: `node server.js`. The host's `PORT` is picked up automatically. Use a single instance, since game state lives in memory.

If you put it behind nginx, disable buffering for `/events` (the server already sends `X-Accel-Buffering: no`).

## Features

- Unlimited rooms at once, 2–10 players per room (two decks automatically above 6 players)
- Standard rules: skip, reverse, +2, wild, wild +4, draw-and-play-or-pass
- Optional **+2 / +4 stacking** (host toggles it in the lobby)
- **UNO!** call, and anyone can catch a player who forgot (+2 cards)
- Round scoreboard (wins) that persists across rounds, "Play again" for the host
- Chat and game log, reconnect after a refresh, host can remove players
- Server-authoritative: hands are only ever sent to their owner

## Notes

- Rooms are held in memory and cleaned up after an hour of inactivity; a restart clears them.
- A disconnected player's turn is skipped after 15 seconds (they can rejoin by reopening the page).
