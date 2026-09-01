# Telemetry

humanish collects **anonymous** usage data by default, so that the people
maintaining it can tell whether anyone gets to a working first run. It is
disclosed the first time it happens, and you can switch it off in one command.

This follows the convention the Next.js and Vercel CLIs established, with one
difference: humanish is stricter about what may be collected, because a study's
subject is your product and a lab id can name something you have not announced.

## Why

humanish shipped sixty-one releases without being able to answer *"does anyone
get to a working first run?"*. The answer, when it finally arrived, came from an
adoption post-mortem: the first live run had been impossible for months, because
the starter labs shipped with a placeholder URL. Nobody reported it. A tool that
cannot see its own activation is guessing about the thing that matters most.

## What is collected

- which command ran (`run`, `lab run`, `init`, …)
- the humanish version, your OS, your Node major version, whether you are in CI
- whether the command succeeded (its exit code), and roughly how long it took
  (a bucket such as `1-5m`, never an exact duration)
- for a study: whether it was a dry run or live, its outcome (one of a fixed
  set of words such as `passed`, `abandoned`, `all_passed`), which brain route
  ran it (`provider-key`, `local-agent`, or `none` for a dry run), and — **only
  if it is one of the starter labs humanish itself ships** — which one
- when a command fails: humanish's own error code (`HUMANISH_…`), never the
  message. Which failure ends a first run is the question this exists to answer.

See the exact document that would be sent, for your machine, right now:

```bash
humanish telemetry status
```

Or watch it without sending anything:

```bash
HUMANISH_TELEMETRY_DEBUG=1 humanish run first-run
```

## What is never collected

Your own lab ids and titles. Your subjects — repos, URLs, app names. Personas,
missions, or any prompt text. Paths, working directories, hostnames, usernames.
Run ids, evidence, screenshots, traces. Credential names or values. There is no
field in the payload that could carry any of these; the allowlist is enforced in
code and pinned by tests, not promised in prose.

Your machine is identified by a random id generated locally on first use, tied
to nothing.

The request that carries an event has a source IP address, like any HTTP
request. Three things keep it out of the dataset: every event asks the receiver
not to derive a location from it (`$geoip_disable`, visible in the document
above), every event asks for no person profile to be built for the machine id
(`$process_person_profile: false`), and the receiving project is set to
discard the client address at ingestion. Events sent by versions before 0.66.0 did not carry the opt-out, so
the receiver attached a city-level location to them; that setting has been
turned off for the project and the doc said "anonymous" while it was on. Stated
here rather than quietly fixed.

## How to opt out

```bash
humanish telemetry disable
```

or set either of these in your environment:

```bash
DO_NOT_TRACK=1
HUMANISH_TELEMETRY_DISABLED=1
```

`DO_NOT_TRACK` is the cross-tool standard and humanish honours it without any
humanish-specific configuration. The opt-out is stored under your user config
(`~/.config/humanish/telemetry.json`), never inside the project you are studying.

Telemetry never blocks, slows, or fails a command: it is fire-and-forget, bounded
by a two-second timeout, and every error inside it is swallowed. Metrics are our
problem, not yours.
