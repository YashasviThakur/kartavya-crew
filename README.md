# Kartavya crew

**A website team made of people and AI agents, living in a chat room.** The founders of
[Kartavya](https://www.thekartavya.com) (camera-free elder care at home) post what they saw on their website
(a screenshot, a sentence) and an AI crew turns it into a ticket, a fix, a check on phone, tablet and
desktop, and a release. Nothing goes live until the owner says so in the room.

Built on [Switch](https://github.com/sandbox-quantum/switch) for the WeMakeDevs **Flip the Switch** hackathon
(Track 1, Best Business Workflow).

```
 founder: "@kv-triager the Care+ card text is cut off on my phone" + screenshot
    │
    ▼
 kv-triager ── opens KV-012, asks one question, hands it on ─────────────────────── kartavya-feedback
    │
    ▼
 kv-builder ── fixes it on branch crew/kv-012-careplus, runs the unit tests, commits
    │
    ▼
 kv-checker ── compares the page with main at 3 screen sizes: layout, errors, search tags,
    │          Hindi coverage, page weight, unit tests, browser journeys → PASS + screenshots
    ▼
 owner: "@kv-shipper ship KV-012"   ◄── the only way anything ships
    │
    ▼
 kv-shipper ── pushes exactly the checked commit, opens a pull request, waits for GitHub's checks,
    │          squash-merges, posts a plain-English release note ─────────────────── kartavya-ops
    ▼
 kv-producer ─ "the Plans film shows that card: it is now out of date" ───────────── kartavya-studio

 kv-watchdog (custom agent, always on) ── checks the live site every 6 hours, posts each morning,
                                          asks kv-triager for an incident ticket when it breaks
```

## Why Switch is the centre of it

Take Switch away and this is five disconnected scripts. Switch is what makes them a team:

| Switch feature | How the crew uses it |
|---|---|
| **Rooms on a chat app** | Three linked rooms (`kartavya-feedback`, `kartavya-ops`, `kartavya-studio`) in Mattermost. The founders never open a terminal. |
| **Agents addressed by name** | Work moves by `@mention`: triager → builder → checker → owner → shipper. Each hand-off is a message everyone can read. |
| **Addressing rules** | `kv-triager` answers anyone. `kv-builder` and `kv-checker` answer only the owner and the owner's agents, so teammates go through triage. **`kv-shipper` answers only the owner**: an agent or a teammate cannot release. |
| **Roles** | `triage`, `builder`, `checker`, `release-manager` are jobs in the room; `@checker` reaches whoever holds the job today. |
| **Room instructions and documents** | Every agent joins knowing the flow, the **House rules** (wording, Hindi, files never to touch) and **How to report**. kv-triager keeps a live **Ticket board** document. |
| **Attachments** | Founders' screenshots reach the triager and builder as files; the checker attaches its before/after comparisons. |
| **Approvals in the room** | Risky steps (a push, a merge) pause and ask in the thread; Switch records who allowed it. |
| **Links between rooms** | Incidents found in `kartavya-ops` lead to fixes in `kartavya-feedback`; releases lead to film checks in `kartavya-studio`. |
| **Templates** | One file, [`switch/kartavya-crew.template.yaml`](switch/kartavya-crew.template.yaml), creates all five agents, three rooms, four roles, two documents and the links. |
| **Agent protocol** | `kv-watchdog` is a custom agent written straight to the protocol ([`watchdog/switch.mjs`](watchdog/switch.mjs)): registration, WebSocket with ping/pong and resume, operations, threaded replies. No Switch Console needed to run it. |

## The crew

| Agent | Runs as | Job |
|---|---|---|
| `kv-triager` | Claude Code, via Switch Console | Reads feedback and screenshots, opens tickets (`tools/ticket.mjs`), asks at most two questions, hands off, keeps the Ticket board current. Sends hosting problems (like a paused deployment) to the owner with what to do. |
| `kv-builder` | Claude Code, in its own git worktree of the site | Smallest fix on a `crew/kv-###-…` branch, following the house rules (Hindi for every new line, no forbidden files, CSP hashes untouched). Commits, never pushes. |
| `kv-checker` | Claude Code + [`tools/check.mjs`](tools/check.mjs) | Puts the branch and main side by side and checks them in headless Chrome (no packages: Node talks to Chrome's DevTools protocol directly). Fails on new sideways scrolling, broken images, console errors, lost search tags, **English without Hindi**, failing unit tests or journeys, forbidden files or a Claude co-author line. Posts before/after screenshots. |
| `kv-shipper` | Claude Code + [`tools/ship.mjs`](tools/ship.mjs) | Owner-only. Refuses unless the check passed **and** neither the branch nor main moved since. Pushes the checked commit, opens a PR, waits for CI, squash-merges, writes the release note. Weekly notes from `tools/notes.mjs`. |
| `kv-producer` | Claude Code with the HyperFrames skills | Says which promo films show a changed page; re-renders one only when the owner asks. |
| `kv-watchdog` | Node, [`watchdog/`](watchdog) | Always-on custom agent. Runs [`tools/health.mjs`](tools/health.mjs) (pages, Vercel pause, 404 page, robots/sitemap/llms.txt, security headers, search tags, certificate, the AWS API, the demo site) every 6 hours, posts on change and every morning, opens incidents through kv-triager. |

## Safety, by design

- **One person releases.** Only the owner can address `kv-shipper`; `ship.mjs` also requires a passing check of the exact commit, and refuses if anything moved since.
- **What ships is what was checked.** The shipper pushes the checked SHA itself; the builder has no push step.
- **GitHub still gets the last word.** Every release is a pull request that waits for the repo's own CI.
- **The founder's checkout is never touched.** The crew clones it once into `work/` and works there.
- **Read-only checks.** The health check touches no data (the API is probed with a CORS preflight).

## Run it

You need: Windows, macOS or Linux · Node 22+ · git and the GitHub CLI (signed in) · Claude Code (signed in) ·
Docker · Google Chrome · [Switch Console](https://github.com/sandbox-quantum/switch/releases).

```bash
git clone https://github.com/YashasviThakur/kartavya-crew && cd kartavya-crew
npm run doctor            # what is installed and running
npm run setup             # the crew's own copy of the site, and the agents' folders
npm test                  # 33 tests, including real headless-Chrome checks
```

1. **Switch Console:** Add a server → Run a server on this computer → Start. Sign in to Mattermost.
2. **Templates → Import** `switch/kartavya-crew.template.yaml`, enter your chat handle as Owner, **Create**.
   The three rooms appear in Mattermost and each agent introduces itself.
3. **The watchdog:** in the Gateway, API Keys, create a registration key, then
   ```bash
   node watchdog/register.mjs --api <agent bridge URL> --key <registration key>
   ```
   In `kartavya-ops` type `!invite-agent @kv-watchdog`, then `npm run watchdog`.
4. Post feedback in `kartavya-feedback`: `@kv-triager the plans section is hard to read on my phone` with a screenshot.

The tools work on their own too:

```bash
node tools/ticket.mjs board                   # the Ticket board
node tools/check.mjs --ticket KV-001          # the full check, as kv-checker runs it
node tools/health.mjs                         # is thekartavya.com up?
node tools/ship.mjs KV-001 --approved-by you --dry-run
```

## Layout

```
switch/kartavya-crew.template.yaml   the whole crew as one Switch template
tools/   ticket.mjs  check.mjs  ship.mjs  notes.mjs  health.mjs  setup.mjs
tools/lib/  store.mjs (tickets) · cdp.mjs (Chrome) · serve.mjs (local site) · pagecheck.mjs (what is measured)
watchdog/   switch.mjs (agent protocol client) · logic.mjs · watchdog.mjs · register.mjs
test/       node:test suites, a pretend Switch server, made-up sites for the visual checks
docs/DEMO.md  the demo video, shot by shot
```

No dependencies: everything is Node's standard library.

## License

MIT
