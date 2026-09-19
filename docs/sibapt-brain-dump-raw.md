# Sibapt — Brain Dump (Raw, with clarifications from discussion)

What is the anatomy/definition for/of a Sibapt?

## Core Structure

- it has a job (Claude.md)
    - the overall objective is stated
    - this is mostly describing basic functions:
        - managing - main agent is told to just invoke subagents and take in direct user feedback
        - action - invoking subagent who is pointed towards Strategy.md as the source of truth for "the game plan"
        - feedback - invoking subagent with feedback from the user concerning an interaction who is told to go and read the Strategy and MetaStrategy.md.
        - stats - NOT a subagent invoked via queue. The main agent handles stats itself inline.

    - it will point towards a document of shared tools that are available to it and heavily encouraged to use to understand and solve any relevant problem (our mcp servers, and other helpful universal stuff)

### Queue Items (only two types)
- **Action** — a request comes in, main agent invokes the action subagent with the query/file/whatever
- **Feedback** — user feedback comes in, main agent invokes the feedback subagent with the feedback

### Stats (handled by the main agent, not queued)
- The main agent collects stats at three moments:
    1. **On intake** — a request arrives, main agent looks at it, updates stats (categorize the request type, increment counters)
    2. **On output** — action subagent finishes, main agent looks at the output, collects stats
    3. **On feedback** — feedback comes in, main agent records good/bad, timestamps
- Stats start extremely simple:
    - Total requests, total feedback given
    - Good feedback count, bad feedback count (with timestamps for progress over time)
    - That's it at the beginning
- Only add new stats when they're actually useful — user can request new tracking, or the agent can propose it
- Over time stats might grow to include: request categorization (testing vs summarizing vs etc), per-project counts, automation rate, response patterns
- **Do NOT track stats for the sake of tracking stats** — worst case is managing useless numbers
- Stats need some kind of local storage structure that gives flexibility to grow but doesn't force raw markdown for everything
    - Could be a daily stat book (one file per day)
    - Could be a simple local DB (SQLite)
    - Could start as JSON and evolve — the storage method itself should be allowed to evolve via MetaStrategy
- Stats schema should be documented: what we're tracking + rationale for why

- it has a MetaStrategy.md (starts simple, slight guiding from the creator)
    - this document describes how BOTH the Strategy.md AND the stats system are supposed to work
    - this is the part that only the feedback agent is able to update (along with the Strategy doc)
    - on every feedback cycle, the feedback agent considers all three: do I want to change the strategy? do I want to change the stats tracking? do I want to change the meta strategy itself?
    - it can say "the strategy isn't working, we should use a different tool/memory system/categorization" or it can say "we're nailing it, we're gonna keep going"

- the main orchestrator can be directly interfaced with by the user at any time
    - if things go off the rails, user hops into the instance and gives direct input
    - it's not just a router — it's also a direct conversation partner when needed

- it has a Strategy.md (starts blank)
    - this is the game plan taken into every "action"
        - it should be followed to a tee
        - contains:
            - direct "goals"
            - examples of previous
    - the main file should be < 350 lines long but its reach and tooling can be infinite
        - the whole file might be a simply written strategy
        - or it might be just a big glossary pointing the agent down many paths of documents before finding something real well organized.
        - it may be a list of tools and how to use them in order to understand and solve the problem

- one queue run every 10s and divies out of all the jobs to all of the workers
    - one centralized place to see all of the work that is flowing through and makes each Sibapts potential open to all of the others.
    - can always ask the question "is the Sibapt ready or is it still working?" and not deliver it if the instance is still running.

---

## Activation & Memory

- it gets activated
    - this can be one-off instances or running queues
    - both ad-hoc and timed

- it has a memory system and a definition for how it works
    - this starts as simple as "we don't know yet, we just started so we are recording everything" until patterns emerge
    - the memory system should try to use stats where is possible as a means of tracking progress and seeing growth/stagnation/decline
        - it should only be trying to track helpful stats like actually useful ones (did I get good feedback or bad feedback is going to be about the most useful every time).
    - every memory system should be asked to refine itself regularly, not just the stored memories themselves which it should be doing every but with the actual memory system itself. Like, it should be allowed to just actually ask the question "based on the most recent activity I've seen and the users feedback to it, is there anything I could change about the actual technique I'm using to store this information in order to better serve the user through my work".
        - the agent should be encouraged to keep things as is if things are going well,
        - the response may be "no, we nailed all of the responses, we gucci dawg"
        - the response may be "absolutely! we just started and have no real structure so
    - while each strategy system will essentially starting out as a blank .md file, it should be encouraged to evolve that system as well. So, while the base state

- must be able to receive feedback about a certain response (at least while training)
    - the "response" for each Sibapt must be captured for feedback
        - this should include the thinking and actual output
    - if feedback is given directly to a response, then the "response" and feedback are fed back into the same agent for the sake of updating understanding about preferences
    - the typical flow should be that the agent just acts when activated and then refines itself on feedback until the automation is the dominant experience.

---

## Agent Architecture

- Each Sibapt is just an agent with all-powerfully tooled subagents:
    - action agent
        - the action agent must perform the desired task AND must set up the user to give feedback
            - (shows thinking, summary of action, "thumbs up" button and text box for feedback)
    - feedback agent
        - must take in the feedback and use it to improve its memory/strategy system
    - user can directly interface with the agent whenever to give direct feedback
    - each Sibapt is registered in a central system (along with other central services like tools and techniques) that are all referenced from the Claude.md. We just put anything in agents/all or something that applies to all agents and all of the files point there.

---

## Group Activities & Version Control

- We could set up "group" activities like have an alarm that goes off once a week and gives each Sibapt an instruction to go look into agents/all/instructions/WEEKLY_TASKS.md update that just does little things like updates it's description in shared locations and does other weekly things for all Sibapts. This is just one of many "group" activities I would want to schedule including brain swaps and open discussion about changes and why they were made. That is why we should be making it an automatic thing that every time that a change is made to either the META_STRATEGY.md or STRATEGY.md, a commit must be made explaining what the change was. At the beginning, this will be like every time but it will be an easy way to keep track of why we do things.

---

## Three Sibapts

### 1. Alert Worker (retrofit existing)
- **Job:** Preprocess Joshua's notifications. Speed him through by doing everything he would do up front — research, categorize, auto-dismiss noise, surface what actually needs his attention.
- **Already exists** at `~/.homestead/alert-worker/` — needs to be restructured into the Sibapt shape (split CLAUDE.md into managing/action/feedback/stats subagents, add MetaStrategy.md and Strategy.md).

### 2. Plan/State Doc Manager
- **Job:** Help Joshua manage PLAN.md + STATE.md docs for ongoing development projects.
- Keeps docs from going stale. Reads recent session activity, git commits, completed work, proposes updates.

### 3. One-Interface Manager
- **Job:** Help Joshua manage responding to all running Claude Code instances from one place.
    - Turn summarization, pre-testing, preparing tests, enabling "quick actions", auto-responding to common moments
    - Reads the most recent chat + PLAN.md + STATE.md + maybe a project-specific doc for this manager, then adds to a list of "responses" for Josh to approve/modify
    - Same manager gets spun up whenever "feedback" is given
- **Demo mode:** After completing many items (via /todo-list skill), prepares a full presentation — takes you screen to screen with voiceover and actual button-click demos to show each feature working. This is baked into existing functionality, just a "guided demo" mode.
- **Immediacy:** Pops up as soon as you respond to whatever is in front of you. You're either giving feedback to the manager or doing what the manager is giving you.
- **Open question:** Should the manager operate completely via the terminal?

---

## FUTURE

- if it seems like a worker has been working for a while, it may be worth it to have a "fixer" bot that marches through every ones and a while and tries to fix up any bot that has been "working" for 10 min or in some way hasn't responded in a while.
- Every change to the instructions is committed to github (not future, that part should be now). Every week, each SISWAP is asked to review its commits (and any available stats) throughout the week and try to give itself a review of how it thinks it is trending. It should not try to beat around the bush but should instead try to be as direct and honest as it can be and then we can decide to cut him or grow him.

### Evolution
- At a cadence, we could ask certain or all SISWAPs to consider an alternative strategy for doing its task. For example, we could potentially ask it to try and mature its brain by adding a more expansive layer that might include a database or something. Then, we attempt an A/B split for that feature and then via feedback, we can discover which method is effective.
    - This should only be done to low-performing SISWAPs.

### Multiplication
- Each SISWAP should be asked at a cadence if it is doing more than one discrete task and if it should be split into 2 SISWAPs for the sake of quality.
- Even this could be done via A/B testing and then reported on.
- It would also be great if this could work the other way — that somehow we could also ask our machine in general "what other SISWAPs could be developed based on the user's behavior".

### Local-to-Cloud Escalation
- Prove out that a local model (running on-device) can conduct the bulk of a flow cheaply and locally, but has the ability to "call upon a higher power" when it needs it — escalating to a full Claude Code session (a SISWAPT manager) for the heavy lifting.
- The local agent runs the routine work. When it hits something beyond its capability, it sends a message up to its manager (a SISWAPT), which handles it and sends the result back down.
- This keeps credit usage low (local model is free) while still having access to the full power of Claude when actually needed.
- The goal is to prove this flow works end-to-end: local agent running → detects it needs help → escalates to Claude Code → gets answer → continues locally.
