# Actor Fidelity: whose behavior is this evidence about?

Status: research digest + design position. Sources are public papers and open-source
harnesses; every claim below carries its citation so it can be argued with rather
than inherited.

## The question

A computer-use actor in a study of a consumer web app typed a `javascript:` URL into
the browser address bar to get past a step. The run finished green.

Whether that is a defect depends entirely on a question the harness never asked:
**who is this study's user?**

- If the declared users are **people**, it is a defect — and a costly one. The actor
  routed around the friction the study existed to measure, so a passing run proves
  nothing about the human experience. Worse, it is silent: nothing in the bundle
  distinguishes that run from one where a person clicked through.
- If the declared users are **agents** — as they are for an agent-facing CLI, API, or
  MCP surface — the same act is faithful. It is the user population behaving normally,
  and the fact that the agent had to reach for that affordance is itself a product
  finding about how legible the surface is to its actual users.

The proof roadmap already anticipated this: its strongest evidence class,
`user-census`, is defined as "the users of the product ARE agents, and the lab runs
real production harnesses." This page is the layer that makes the distinction
operable.

## What the evidence says

### Direct URL navigation is a human affordance

WebLINX built its action space from 2,337 real human demonstrations; `load(url)`
appears in 2,324 of them — 99.4%, roughly 1.6 times per session
([arXiv 2402.05930](https://arxiv.org/abs/2402.05930)). Treating address-bar
navigation as non-human would make a human-declared lane *less* faithful, not more.
The anomalous class is script execution and developer tooling, not URL entry.
BrowserGym already factors these apart: its `nav` subset is exactly
`{goto, go_back, go_forward}`, separate from everything else
([arXiv 2412.05467](https://arxiv.org/abs/2412.05467)).

### Prose instructions are a weak control for action modality

- Tool-restriction constraints in realistic agentic prompts are honored 19.9–27.2% of
  the time (AgentIF).
- When a constraint conflicts with the task goal, obedience falls to 9.6–45.8%, and
  models usually do not register the conflict ("Control Illusion").
- Rule-file effects are largely content-independent: random rules tie with curated
  ones, and shuffling changes little — measured specifically on agent skills and
  persona definitions ([arXiv 2604.11088](https://arxiv.org/abs/2604.11088)). A
  modality rule can therefore appear to work while doing nothing.
- Persona adherence decays over a long trajectory rather than holding
  ([arXiv 2512.12775](https://arxiv.org/abs/2512.12775)).

The one large-scale prompt-level modality constraint in the literature —
Online-Mind2Web instructing agents not to use search — was not trusted by its own
authors, who published the measured constrained-vs-unconstrained delta (26% vs 31%)
instead of asserting the instruction took effect
([arXiv 2504.01382](https://arxiv.org/abs/2504.01382)). That is the discipline this
project copies: where a constraint cannot be mechanically enforced, measure what it
was worth.

### Broad motivational reframes have backfired; narrow countable ones have worked

Making realism the actor's stated objective is an appealing fix, and the nearest
measured attempts went the wrong way. A findings-informed realism persona prompt
lowered overall simulator fidelity (User-Sim Index 70.9 → 64.6) and worsened outcome
calibration (0.18 → 0.29): "moving some behaviors closer to humans can move others
further away" ([arXiv 2603.11245](https://arxiv.org/abs/2603.11245)). Explicitly
licensing persona-faithful failure fixed the *marginal* rate five-fold but left the
*conditional* structure nearly unchanged — it taught the simulator to disengage
uniformly rather than to disengage when a real user would
([arXiv 2606.20708](https://arxiv.org/abs/2606.20708)). By contrast, a narrow,
countable instruction did produce a measured improvement
([arXiv 2601.17087](https://arxiv.org/abs/2601.17087)).

Two further cautions for prompt design: telling an actor it is being observed and
scored is a documented behavior-changing cue whose effect grows with model scale
([arXiv 2505.17815](https://arxiv.org/abs/2505.17815)), and stating the grading
criterion to the actor invites optimization of the stated metric. Pre-action
self-checks are worse than neutral: deliberation before acting degrades constraint
adherence in most models measured ([arXiv 2505.11423](https://arxiv.org/abs/2505.11423)),
and chain-of-thought is an unreliable report of what actually drove an action
([arXiv 2505.05410](https://arxiv.org/abs/2505.05410)) — an actor that takes a
shortcut and then narrates a plausible justification for it is the expected output,
not an edge case.

What does hold, in the same literature: periodic re-injection of a short persona
contract (large, cheap, replicated), and grounding a persona in specifics rather
than exhorting it to be faithful (interview-grounded personas measurably beat prose
descriptions).

### Outcome-only scoring cannot see modality

WebArena's URL evaluator scores on the final page URL, so a single `goto` to the
reference URL earns full credit ([arXiv 2307.13854](https://arxiv.org/abs/2307.13854)).
τ-bench states the general form: a state-based reward is necessary but not
sufficient, since it cannot see whether policy was followed
([arXiv 2406.12045](https://arxiv.org/abs/2406.12045)). And the gradient is real —
calling site APIs instead of driving the UI roughly doubles WebArena scores
([arXiv 2410.16464](https://arxiv.org/abs/2410.16464)). Any harness that scores only
outcomes should expect actors to find that gradient, and should not be surprised when
a green run proves nothing.

## The position this project takes

**Declare, record, and let the adopter judge.**

1. **Declared population is a property of a persona, not of a lab.** One study program
   can legitimately run agents and people against the same surface; the comparison
   between them is a finding, not a contradiction. Prior art runs both populations
   through one instrument and reports the difference
   ([SusBench](https://arxiv.org/abs/2510.11035); MAS-Bench's GUI/shortcut split,
   [arXiv 2509.06477](https://arxiv.org/abs/2509.06477)).

2. **Record which affordance class each action used.** Recording is the layer that
   makes every other claim checkable, including whether the persona prompt worked at
   all. It is also the only honest answer to a defect whose verdict depends on a
   declaration the harness cannot verify.

3. **Do not bake a verdict.** Whether an affordance invalidates a study is product
   semantics, and product semantics belong to the adopter's scorer
   (`review.scorer.ref`). The harness emits facts; the adopter decides what they mean.

4. **Prompt guidance ships as a nudge whose take-rate is reported, never as the
   mechanism.** The evidence above is what that sentence is standing on.

5. **Capability settings are recruiting decisions, not instrument settings.** Which
   model runs a lane, and at what reasoning effort, changes who the participant IS —
   the same way a persona prompt does. It is tempting to sort these into "the
   participant" (persona) and "the harness" (model, effort) and treat a result that
   moves with effort as a confound. That split does not survive contact: both are
   things we set on a synthetic person before they touch the product, and the evidence
   above says the persona half is the *weakly* grounded one. So a lane that abandons at
   `medium` and completes at `high` produced two findings about two participants, not
   one finding and one artifact.

   What follows is a recording obligation, not a control obligation. Vary them
   deliberately, declare what was recruited, and record the resolved value on the trace
   (`ids.model`, `modelSettings.reasoningEffort`) so a reader can tell which participant
   produced which result. The failure mode is not "we ran at medium" — it is running at
   medium without saying so, then attributing the outcome to the one variable we did
   declare.

   **What this does not license:** claiming that any (model, effort) pair corresponds to
   a real user population. No such mapping is calibrated here, and this project does not
   assert one. A declared population says who was recruited; it does not say whom they
   stand for.

6. **Fail closed only on harness integrity, never on product semantics** — a lane that
   cannot report what it did is a broken instrument, which is a different thing from
   an actor that behaved unexpectedly.

## What this does not claim

Fidelity here is scoped to **affordance and decision** level: which routes an actor
took, and whether they belong to the declared population. It is not a claim of
behavioral realism. At the kinematic level — pointer paths, timing, motor noise — the
gap between agents and people is total and trivially detectable
([arXiv 2604.09574](https://arxiv.org/abs/2604.09574)). Any claim beyond the
affordance/decision level would be dishonest, and this project does not make one.

Two further limits worth stating plainly. Restricting script execution and developer
tooling for *fidelity* reasons has no precedent — where such restrictions exist
elsewhere, the stated motive is code-execution safety — so this is new ground rather
than an inherited convention. And nobody has yet measured whether affordance-class
recording changes what adopters decide; that is the experiment this layer makes
possible, not a result it can assume.

## Vocabulary

Terms are borrowed rather than coined, so results stay comparable with the
surrounding literature:

| Term | Source | Meaning here |
| --- | --- | --- |
| action space / action set | WebArena, BrowserGym, OSWorld | the set of actions an actor can express |
| `nav` subset | BrowserGym | `goto`, `go_back`, `go_forward` — direct navigation, a human affordance |
| naturalistic actions | AndroidWorld | the human-modality subset, contrasted with exposed function-calling APIs |
| shortcut action | MAS-Bench | a non-UI route to the same outcome (API, deep link, script) |
| algorithmic fidelity | Argyle et al., *Out of One, Many* | how well a conditioned model emulates a specific population |
| Agent Experience (AX) | Biilmann (Netlify) | the experience of a product whose users are agents |

Three collisions to avoid: "agent usability testing" already means an agent
*simulating* a human, which is the opposite of the agent-population case; `cheat()` in
BrowserGym means the reference solution, not misbehavior; and "reward hacking" refers
to attacking a grader, which is a different failure from routing around a UI.
