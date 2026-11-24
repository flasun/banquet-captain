# Banquet Captain

A personal agent that works my side-project tasks on a [Fly.io Sprite](https://fly.io/sprites) while I'm working a banquet shift.

It holds no third-party credentials. Every outside call goes through Sprites connectors, which keep the keys in Fly's control plane and attach them on the way out. It also works under leases: it checks in before touching anything, checks out "waiting on Ryan" when it needs a decision, and if it goes dark, another Sprite picks up where it stopped.

Built for Fly.io's [Hacksgiving](https://fly.io/hacksgiving/), Nov 23 to 29, 2026.

## What was built this week, and what already existed

The agent in this repo is new: it was started on Nov 23, 2026, the first day of Hacksgiving. It talks to my **hub**, a personal operating system I built before the hackathon (a Cloudflare Worker serving MCP, with projects, tasks and an agent board). These pre-hackathon hub features are what Captain leans on:

- the agent board: leases with a 2-hour check-in rule and MIA after 4 hours
- lease tokens, per-agent hub keys, and Ed25519-signed check-ins
- the Waiting on Ryan list, where agents leave decisions for me

Everything in this repo, and any hub change made for the demo during the week, is Hacksgiving work. Hub changes are listed under Progress.

## How it works

```
 Hub (Cloudflare Worker)                       Sprite: banquet-captain
 agent board · tasks · Waiting on Ryan        +----------------------------------+
        ^                                      |  captain serve  (Sprite service) |
        |  Authorization: Bearer <hub key>     |   - POST /wake  -> one tick      |
        |  (added by the gateway)              |   - polls while awake            |
 Sprites API gateway  <-- no credentials ------|   - ed25519 identity key         |
 custom API connector, path allowlist          |  ~/.captain/state.json           |
                                               +----------------------------------+
```

One tick does this:

1. If I decided something on the Waiting list (done = yes, dropped = no), it resumes that lease with `agent_checkin resume` and the notes it left.
2. Otherwise it takes the first open hub task tagged `captain`: it checks in with the task as its claim, heartbeats while it works, and checks out `done`, `handoff`, or `waiting`.
3. A task another live agent holds is skipped. A task whose holder went MIA is taken over, and the hub hands over that agent's last progress and next notes.

The Sprite sleeps between ticks and isn't billed for compute while asleep. A request to its URL wakes it.

## What "no credentials in the box" means here

- **No service credentials on the Sprite.** The hub key lives in a Sprites custom API connector. Calls to `api.sprites.dev/v1/gateway/...` carry no Authorization header; the gateway identifies the Sprite by Fly's request signature and adds the key. `captain doctor` and `captain serve` refuse to run if the config or the environment looks like it holds a token.
- **One private key does live on the Sprite:** an Ed25519 identity key made on the Sprite (`~/.captain/identity.pem`, mode 600). It opens nothing outside the hub's agent board. The owner approves its public key on the hub, and from then on every check-in, heartbeat and check-out is signed, so the board shows the lease as `verified (signed)`.
- **Lease tokens** are stored in `~/.captain/state.json`. They only renew or close a lease this agent already holds.
- **Limit:** the gateway can restrict paths, not MCP tools. The hub key is scoped to the hub's Work compartment, so the Sprite can read other Work records. Captain only acts on tasks tagged `captain`, but that is code, not a gateway rule.

## Setup

You need a Sprite, the `sprite` CLI, and a hub you own.

1. **Hub key.** On the hub's `/settings/keys`, create a key named exactly like the agent id (`banquet-captain`), for the **Work** compartment, with full scope. The hub requires the agent id to match the key's name.
2. **Connector.** In the Fly.io dashboard, go to Sprites → Connectors → Add connector → Custom API:
   - base URL: your hub's URL
   - token: the hub key; auth method: header, prefix `Bearer`
   - access: turn off "Allow all sprites" and allow the name prefix `banquet-captain`
   - endpoint allowlist (API only): `["/mcp/work"]`
3. **Deploy** from this folder:
   ```powershell
   .\scripts\deploy.ps1                 # Windows
   ```
   ```bash
   ./scripts/deploy.sh                  # macOS/Linux
   ```
   The first run builds, makes the identity key, and stops at the config.
4. **Config.** On the Sprite, get the connector's gateway URL and put it in `~/.captain/config.json` as `hubGatewayUrl`:
   ```bash
   sprite exec -s banquet-captain -- curl -s https://api.sprites.dev/v1/gateway/list
   ```
   Run the deploy script again. It runs `captain doctor` and installs the `captain` Sprite service on port 8080.
5. **Sign.** Run `captain register-key` on the Sprite, then approve the fingerprint it prints on the hub's `/agents` page.
6. **Give it work.** Tag a hub task `captain`, then wake it with `POST https://<sprite-url>/wake`, or wait for the next poll.

## Commands

| Command | What it does |
|---|---|
| `captain init [agent-id]` | Makes the identity key and a config template |
| `captain doctor` | Checks for stray credentials, the config, the identity key, and the hub through the gateway |
| `captain register-key` | Asks the hub owner to approve this Sprite's public key |
| `captain tick` | Runs one pass |
| `captain serve` | Serves `POST /wake` and `GET /health` on :8080, and polls while awake |
| `captain status` | Shows the lease it holds and what waits on the owner |

## Progress

- [x] Day 1 (Nov 23): lease loop, signed calls matching the hub's format, the Waiting-list round trip, the HTTP wake endpoint, Sprite service setup, tests against a fake hub. The worker is a dry run that only touches the hub.
- [ ] Day 2: real worker. Claude Code headless in a scratch clone, model calls through the Anthropic connector, and a PR opened through the GitHub connector's Git Data API (no git credentials).
- [ ] Day 3: phone ping through the Pushover connector when it checks out waiting; the hub's cron wakes the Sprite after I answer.
- [ ] Day 5: MIA handoff demo with a second Sprite (`deploy.ps1 -Sprite captain-2`) and a short demo timer.

## Develop

```bash
npm install
npm test        # builds, then runs node:test
```

TypeScript in strict mode, Node 22+, no runtime dependencies.
