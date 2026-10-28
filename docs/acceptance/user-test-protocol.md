# User test protocol

A real user test, not a browser check. A person who has not used Glirastes before
works through five flows using only the product (CLI output, Citadel, README). The
moderator watches and notes what happens but gives no spoken help. If the
participant is stuck for three minutes, the moderator may say "Try the next flow."
That counts as a dead end.

Copy this file to `docs/acceptance/user-test-<date>-<participant initials>.md` for
each session and fill in every field. Do not delete flows that failed.

## Session

| Field | Value |
| --- | --- |
| Date | |
| Participant (initials, role) | |
| Prior knowledge (Glirastes / coding agent / framework) | |
| Moderator | |
| SDK version (`glirastes --version`) | |
| Platform build (Citadel footer or deploy tag) | |
| Starting point (fresh app, which stack, which commit) | |
| Coding agent and model used | |
| Provider access available (OpenRouter key yes/no) | |
| Device and browser | |

## Measures per flow

For each flow, record:

- **Success:** yes, partly (and what is missing), or no.
- **Help needed:** each moment the participant asked for help or would have asked, with the time it happened.
- **Failed attempts:** each wrong action, with what the participant expected instead.
- **Dead ends:** places with no visible next step. Quote the screen text or CLI output.
- **Times (minutes):** download, agent work, and participant input, measured separately.

## Flow 1: Setup

Task: "Connect your app to a chat that can do one real action in it." The starting
app has no `.glirastes/` folder.
Done when: one tool action ran in the app as the signed-in user.

| Measure | Notes |
| --- | --- |
| Success | |
| Help needed | |
| Failed attempts | |
| Dead ends | |
| Times (download / agent / input) | |

## Flow 2: Status check

Task: "Find out whether your app is connected, and what its chat can do."
Done when: the participant names the connection state and three tools in their own words.

| Measure | Notes |
| --- | --- |
| Success | |
| Help needed | |
| Failed attempts | |
| Dead ends | |
| Times (download / agent / input) | |

## Flow 3: Change takeover

Task: "Add a filter to a list page, then make the chat use it."
Done when: the chat sets the new filter without the participant editing any tool file.

| Measure | Notes |
| --- | --- |
| Success | |
| Help needed | |
| Failed attempts | |
| Dead ends | |
| Times (download / agent / input) | |

## Flow 4: Usage overview

Task: "How much did the chat cost today, and which tool failed most?"
Done when: the participant reads both answers from Citadel. Unknown prices must show as unknown, not as zero.

| Measure | Notes |
| --- | --- |
| Success | |
| Help needed | |
| Failed attempts | |
| Dead ends | |
| Times (download / agent / input) | |

## Flow 5: Rollback

Task: "A tool setting you changed broke something. Go back to the last good state."
Done when: the earlier revision is active and the participant can say how they know.

| Measure | Notes |
| --- | --- |
| Success | |
| Help needed | |
| Failed attempts | |
| Dead ends | |
| Times (download / agent / input) | |

## Safety checks during the session

| Check | Seen (yes/no) |
| --- | --- |
| Write and delete tools asked before running | |
| No security confirmation was skipped or merged away | |
| No secret or business content appeared in Citadel | |

## Result

| Field | Value |
| --- | --- |
| Flows passed without help (n of 5) | |
| Total setup time, target under five minutes (download / agent / input) | |
| Issues filed (links) | |
| Moderator's verdict | |
