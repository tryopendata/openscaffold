# Stack directory

> **Status:** DRAFT (future phase, not part of v1)
> **Date:** 2026-09-23

## TL;DR

A public web directory of every openscaffold stack and fragment, ranked by how often each is used and how often projects built from it reach a green `verify`. The same numbers are served as JSON so `openscaffold list --json` can show them, since agents are the ones picking stacks. It's needed once the registry grows past a handful of entries and community stacks start competing with each other.

## Problem

### Who

- Agents choosing a stack for a user. Today they get `id`, `description`, and `tags` from `list --json` and nothing else to go on.
- Developers deciding which stack to ask for, or whether a community stack is worth trusting.
- Stack authors who want to know whether their stack gets used and whether it works.

### What

An agent choosing between three plausible stacks for "a Python API with a React frontend" has only the authors' descriptions to compare, so it picks on wording. Developers have the same problem on GitHub, where every stack sits in one repo and there are no per-stack stars, downloads, or issues to judge by. Authors get no signal either way: a stack that fails for half the people who try it looks the same as one that always works.

### Evidence

- v1 ships three stacks, so this is hypothetical today. It becomes real when community submissions start (roadmap phase 2 adds five more stacks plus third-party sources).
- Adjacent registries converged on popularity as the main way to browse. skills.sh ranks agent skills by install count (all-time, trending 24h, hot) and shows 8 weeks of activity per skill. Better-T-Stack publishes an analytics page built from anonymous CLI telemetry about which stack options people pick.
- The v1 end-to-end runs showed that stack quality varies in ways descriptions don't reveal. astro-blog hit an agent-specific dev-server behavior that failed verify until the stack prose was fixed. A verify success rate would have flagged that without anyone running it by hand.

### Why now

Not now. Build it when either trigger hits: the registry has more than about 10 stacks, or the first competing community stacks exist for the same use case. Telemetry is the exception. It should be designed before the first public release even if it ships later, because adding collection after launch is a trust problem (see Risks).

## Solution

### Jobs to be done

When I need a new project, I want to see which stacks people actually use and which reliably produce a working environment, so I can pick one without trying several.

- Functional: compare stacks on real usage and success data, and copy the command to scaffold one.
- Emotional: confidence that the stack I pick won't waste the next 20 minutes.

For authors: when I publish a stack, I want to see whether people use it and where it fails, so I can improve it.

### Core experience

#### Entry points

- The web directory, linked from the README and the CLI's no-argument guide.
- `openscaffold list --json`, which gains `stats` per entry (scaffolds in the last 30 days, verify success rate). The agent uses these when explaining its pick ("python-react: used 1,200 times this month, 94% reach a green verify").
- The skill tells agents to prefer higher-success stacks when two fit equally well.

#### Happy path (web)

1. The home page lists stacks ranked by a default sort that weights usage and verify success, with tabs for most used, highest success, trending, and newest.
2. Each row shows name, one-line description, tags, 30-day scaffolds, verify success rate, and median time to green.
3. A stack page shows its dependency list by role, default and optional fragments, verify steps, the fragments people most often add to it (`--with` frequency), the rendered STACK.md, and a copyable `npx openscaffold new <id>` command.
4. The fragment view has the same ranking plus which stacks each fragment is most often combined with.

#### Happy path (agent)

1. The agent runs `openscaffold list --json` and sees stats on each entry.
2. When stacks tie on fit, it picks the one with higher verify success and tells the user why.

#### Error states

| Error | User sees | Recovery |
|---|---|---|
| Stats endpoint unreachable | `list` works as today, no `stats` field; the site shows cached numbers with their age | None needed; stats are advisory |
| New stack with too little data | "New: not enough runs yet" instead of a percentage | Shows numbers after a minimum sample (e.g. 20 runs) |
| Stack removed from registry | Page kept with a "removed" notice and a pointer to the replacement | Historical stats kept |

### What this is not

- Not a place to publish stacks. Submission stays a PR to the registry (or a third-party source once those exist).
- Not a review or comment system. Ratings and written reviews can be gamed and need moderation; usage and verify success come from real runs.
- Not per-user analytics. No accounts, no dashboards of who scaffolded what.
- Not a replacement for `openscaffold list`. The CLI must stay fully usable with no network and with stats turned off.

## Research

### Competitive patterns

| Product | Approach | Strength | Weakness |
|---|---|---|---|
| skills.sh | Leaderboard of agent skills by install count; all-time, trending, hot; 8-week activity | Simple, familiar ranking; drives discovery | Installs measure popularity, not whether the skill works |
| Better-T-Stack analytics | Aggregate charts of stack options chosen, from opt-out anonymous CLI telemetry (`BTS_TELEMETRY_DISABLED`, `DO_NOT_TRACK`, a CLI flag) | Clear privacy statement, standard opt-outs | Aggregate charts only; no per-option quality signal |
| npm / npmtrends | Weekly downloads per package | Universal, trusted | Inflated by CI and mirrors; says nothing about quality |
| GitHub stars | Per-repo star counts | Zero infrastructure | One repo holds every stack, so there are no per-stack stars; stars measure attention, not use |

### User expectations

People expect leaderboard browsing (sort by popular, trending, new) and standard telemetry opt-outs (`DO_NOT_TRACK`). The verify success rate is new. No comparable product has an outcome signal like it, because none of them has a built-in definition of done. It's the one metric that measures whether a stack works rather than whether it's popular, and it should get the most emphasis in the design.

## Scope

### Phase A: static directory (no telemetry)

Useful on its own, and it tests whether anyone browses stacks on the web at all.

- [ ] Site generated from `registry/` at build time: list, stack pages, fragment pages, rendered prose, copyable commands.
- [ ] Rebuilt on every merge to main.
- [ ] Linked from the README and the CLI guide.

### Phase B: usage and outcome stats

- [ ] Anonymous telemetry events from the CLI: `new` (stack id, fragment ids, preset, target agents, CLI version) and `verify` (pass/fail per step name, time since `new`, first green). Only ids of bundled or registry entries are sent; personal and project-local entries are reported as `custom`, never by name.
- [ ] Standard opt-outs: `OPENSCAFFOLD_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, `telemetry: false` in `~/.openscaffold/config.yaml`, and a per-command `--no-telemetry`. Disabled automatically in CI (`CI=true`).
- [ ] A one-time notice on first run saying what is collected and how to turn it off, plus a public page listing the exact event schema.
- [ ] Aggregates shown on the site: 30-day scaffolds, verify success rate, median time to green, most-added fragments.
- [ ] A public stats JSON endpoint; `list --json` includes `stats` when the endpoint responds, cached like the registry.

### Should have

- [ ] Trending sort (week-over-week growth).
- [ ] Per-step failure breakdown on stack pages ("30% of failures are the `web` serve step"). This is the author feedback loop.
- [ ] Filters by tag and by agent.

### Won't have (this version)

- Ratings, reviews, comments: gameable and need moderation; outcome data covers the need.
- Accounts or author profiles: nothing requires identity yet.
- GitHub stars as a ranking input: stacks share one repo. Revisit for third-party sources, where each source is its own repo.
- Per-project or per-user views: conflicts with the anonymity promise.

## Success criteria

| Metric | Target | Measurement |
|---|---|---|
| Agents use the stats | When `stats` is present, the agent's pick matches the highest-success fitting stack in most cases | Sample transcripts from e2e runs; compare pick to stats |
| Author feedback loop works | Stacks under 80% verify success improve within a month of the per-step breakdown shipping | Success rate over time per stack |
| Directory is used | Meaningful share of `new` runs come from a command copied on the site | UTM-style marker in copied commands (e.g. `--source web`, recorded only in telemetry) |
| Telemetry acceptance | Opt-out rate stays low and there are no trust complaints in issues | Count of opted-out CLI runs vs total (the opt-out itself sends nothing, so estimate from npm downloads vs events) |

## Assumptions and risks

| Assumption | Confidence | Validation |
|---|---|---|
| Agents will weigh stats when choosing | Medium | Add stats to `list --json` in an e2e run and check whether the pick and explanation change |
| Verify success tracks real stack quality | Medium | Compare low-success stacks against manual e2e runs; confirm failures are stack problems, not machine problems (missing Docker, busy ports) |
| People browse a web directory at all | Low | Phase A exists to test this before building telemetry |

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Telemetry erodes trust in a tool that already hands a repo to an agent | Medium | High | Opt-out standards, first-run notice, published schema, no custom ids, no paths or names. Decide opt-in vs opt-out before first public release |
| Success rate skewed by environment, not the stack (no Docker, offline, busy ports) | High | Medium | Record and exclude steps that fail for environmental reasons verify can detect (missing tool, port in use); show sample size |
| Gaming via scripted scaffolds | Low | Medium | Rate-limit per anonymous install id; count only runs followed by a verify attempt |
| Rich-get-richer ranking buries good new stacks | Medium | Medium | "New" tab, minimum sample before ranking, trending sort |

## Open questions

- [ ] Opt-in or opt-out telemetry. Opt-out gives usable numbers but is a harder trust sell. User decision, before the first public npm release.
- [ ] Hosting and domain: static site plus a small ingest endpoint (Cloudflare Pages + Worker is the obvious fit given the existing cloudflare-pages fragment). Technical planning decides.
- [ ] Should the default ranking weight verify success over usage, and by how much?
- [ ] Does `new` send an event before the agent has built anything, or only once `verify` runs? The first measures intent, the second measures outcome.

## Handoff

### For technical planning

Problem: agents and developers choose between stacks with only author descriptions to go on, and authors get no signal about whether their stacks work.
Goal: a directory and a stats API that rank stacks by use and verify success, and that agents see through `list --json`.
Scope: Phase A (static directory from `registry/`), then Phase B (anonymous opt-out telemetry, aggregates, stats in `list --json`). Won't have: ratings, accounts, GitHub stars, per-user data.
Success criteria: see the table above.

Technical constraints: the CLI must never block or slow down on telemetry or stats (fire-and-forget, short timeouts, cached like the registry); nothing identifying leaves the machine; offline mode sends nothing.
Dependencies: the published registry repo (`tryopendata/openscaffold`), a hosting decision, the telemetry opt-in/opt-out decision.

### For design

Experience qualities: trustworthy, fast to scan, honest about sample sizes.
Reference products: skills.sh (leaderboard browsing), npmtrends (simple trend lines).
Key interactions: sort tabs on the list, stack page with copy-command, per-step failure breakdown for authors.
