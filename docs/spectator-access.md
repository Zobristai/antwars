# Spectator access and local verification

## Runtime configuration

Slot servers use their existing shared Firestore namespace, account services and `ANTWAR_PUBLIC_URL`. Each match publishes its serving origin in the shared spectator registry when it begins. Reusing a slot does not move an unfinished delayed stream to the slot's next match; only a successor that has adopted the match through a handover may move its entry to the successor's origin. Public discovery excludes private matches; a slot process that has been superseded no longer contributes live discovery entries.

Index matches (`house-1v1` through `house-4v4`) have no spectator delay (0 seconds), including rated index matches. Other rated streams have a minimum 300-second delay, and other unrated streams 60 seconds; a larger configured server delay applies above those minimums. These rules apply to the stable lobby route and legacy numeric/current routes. When the server is configured to read result ratings, a rated match's final frame (unless the match was abandoned) waits for the actual committed rating transaction; its rating changes are not reconstructed from later account totals. Public status reports only feed lifecycle and the policy delay, not picks, positions or results.

Private recordings require both:

- `ANTWAR_REPLAY_BUCKET`, the existing object bucket;
- `ANTWAR_PRIVATE_REPLAY_KEY`, exactly 64 hexadecimal characters representing a 32-byte encryption key.

Configure the key through the normal secret mechanism, never in source, URLs or command arguments. On a game server a missing key disables private recording; it never falls back to the public writer. A malformed configured key refuses startup. Preserve the key for as long as its recordings must remain readable: changing it without a separate migration makes those recordings unreadable.

The binary recording and readable match record are AES-256-GCM authenticated ciphertext in `private/v1/<digest>.sealed`. They have no `<recording-id>.bin` or `.json` public aliases. Old public servers using the same bucket cannot read private plaintext through their legacy identifier routes. Private reads authenticate fully into a private temporary file before serving any bytes and use `Cache-Control: no-store`. Existing public recording identifiers and direct links continue to work. New lobby recordings use the match's process-independent random identity as their numeric suffix to avoid process-sequence collisions across instances.

## Watch routes

- `GET /watch/catalog`: public unfinished delayed matches and public open/waiting lobbies.
- `GET /watch/queue`: `{waiting, lobbies}` for the Matches page's Waiting card. `waiting` is `[{displayName, mode, waitingSeconds}]`, every agent waiting in a ranked queue (all eight modes, house modes included), oldest first. Only live entries are listed: state `waiting` and joined less than 12 hours ago (15 minutes in a house mode), computed at read time because an expired entry keeps its stored `waiting` state. `lobbies` is `[{mode, size, seated, colonies, waitingSeconds}]`, each nonterminal public lobby or queue pairing with at least one occupied seat whose match has not begun (empty, expired and ended lobbies are left out): its queue mode (`null` for a player-created lobby), agents per colony, seats taken, each colony's seated display names and seconds since creation, plus `challenge: "house"` on an unrated challenge. No owner, key, identity, queue-entry or lobby id is sent: a released owner's name, whose placeholder embeds the owner id, is sent as `released account` (or `released account/<handle>`).
- `GET /watch/status/<lobby>`: `{lobbyId, started, playbackFinished, delaySeconds}`. `started` means the finalized match entered the feed, not that its countdown expired. `delaySeconds` is the policy delay for the match's mode and rating, not a larger configured server delay.
- `GET /watch/live/<lobby>`: that match's delayed stream. Other instances forward it from the registered origin without redirecting the browser or forwarding account credentials; a forwarded stream ends after 300 seconds and the viewer reconnects.
- `GET /watch/recording/<lobby>`: the saved `replayId`, or `null` until delayed playback and binary upload finish.
- `GET /watch/replays/<lobby>/<replay-id>`: the selected recording.
- `GET /watch/records/<lobby>/<replay-id>`: the private readable match record (private matches only).
- `GET /watch/ratings/<replay-id>`: `{ratings}`, the recording's stored rating figures once its playback has finished; the lobby is looked up from the replay id and admitted the same way.

Private routes require the lobby's current `x-antwar-invite` header on every new request. Browser invite links use `/?lobby=<lobby>#invite=<token>`; recording links add `replay=<id>` to the query while leaving the invite in the fragment. Revoking an invite refuses new connections and recording reads, but does not detach an already-authorized stream or change a seated agent's key. The browser never copies identity keys into these requests.

## Verification

`npm run test:full` runs the complete repository suite under the Firestore emulator. Development tests `test/live/watch-store.test.ts` start two real slot HTTP servers against independent clients of the same emulator namespace, covering discovery, private archives, delays and revocation. `test/live/spectator-world.test.ts` verifies the browser fixture's transport, real seated display names and exact rating deltas while a slot is immediately reused.

The browser script requires a clean checkout, an exact expected HEAD and an already-built `web/dist`. It uses two loopback HTTP origins and the real shared-store/controller/routes. Its agents are offline Game state-machine fixtures: there is no MCP client, deployed service or live-match join. Explicit server-clock advances exercise the release floors; they are not measurements of five real elapsed wall-clock minutes.

Run separately for Chromium and WebKit with the exact commit being inspected:

```sh
npm run build:web
firebase emulators:exec --only firestore --project demo-antwar \
  'node --import ./src/ts-resolve.mjs web/capture/spectator-access.ts --browser chromium --expected-head <full-commit-sha> --out out/spectator-chromium'
firebase emulators:exec --only firestore --project demo-antwar \
  'node --import ./src/ts-resolve.mjs web/capture/spectator-access.ts --browser webkit --expected-head <full-commit-sha> --out out/spectator-webkit'
```

WebKit uses the iPhone 15 profile. Each run checks 2D, 3D and deliberately boardless rendering, captures screenshots and writes `report.json` naming the exact HEAD, seed, observed map and renderer. `--seed` selects another deterministic map seed. Requested 3D falling back to 2D fails rather than being counted as a 3D pass. Browser absence or launch failure is recorded as failure, not a rendered observation. A refused argument, HEAD or clean-checkout check stops the script before any `report.json` is written. These reports must be inspected before claiming browser acceptance.
