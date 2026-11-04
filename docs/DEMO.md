# Demo video (about 3 minutes)

Record the screen with Mattermost on the left and Switch Console on the right. Keep the terminal off
screen: the point is that nobody needs one.

| Time | Show | Say |
|---|---|---|
| 0:00 | thekartavya.com on a phone frame, then the three Mattermost rooms | "Kartavya's founders aren't engineers. Their website team is three chat rooms: people and AI agents." |
| 0:15 | `kartavya-ops`: kv-watchdog's post "has a problem: Vercel says DEPLOYMENT_PAUSED", then kv-triager's reply telling the owner what to do | "A custom agent on Switch's protocol watches the live site. It found the site paused and kv-triager told the owner exactly where to fix it: hosting, not code." |
| 0:35 | `kartavya-feedback`: post "@kv-triager the Care+ card text is cut off on my phone" + screenshot | "A founder reports what they saw." |
| 0:45 | kv-triager opens KV-001, asks "which phone?", you answer | "Triage turns it into a ticket and asks one question." |
| 1:00 | kv-builder: "I'll widen the card's text area…", commits | "The builder fixes it on its own branch, under the house rules: Hindi for every new line, never the founder's private files." |
| 1:20 | kv-checker posts the PASS table and the before/after screenshots (phone, tablet, desktop) | "The checker compares the page with main on three screens: layout, errors, search tags, Hindi, weight, tests." |
| 1:45 | Show a FAIL first if you have one: "1 new English line without Hindi" → builder fixes → PASS | "It caught English with no Hindi. The builder fixed it." |
| 2:05 | You type "@kv-shipper ship KV-001"; the push approval appears in the thread; Allow | "Only I can release. kv-shipper answers nobody else, and Switch asks before the push." |
| 2:20 | The pull request on GitHub with the check table, CI running, merged | "What ships is exactly what was checked, through a normal pull request." |
| 2:35 | `kartavya-ops` release note in plain English; `kartavya-studio`: kv-producer "the Plans film shows this card" | "A plain-English note for the founders, and the producer flags the film that's now out of date." |
| 2:50 | `!roles` and the Ticket board document | "Roles, documents, links, approvals, a custom protocol agent: one Switch template sets it all up." |

Before recording: `npm run setup`, create the crew from the template, register and start the watchdog,
and make sure the ticket store is empty (`state/tickets.json` deleted) so the ticket is KV-001.
