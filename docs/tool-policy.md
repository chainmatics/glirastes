# Tool policy

`glirastes tools refresh` derives every tool from the code with deterministic
defaults: reads run directly, writes ask first, deletes and anything external
or financial always ask. Two layers may change a tool, and across all layers
the strictest value wins.

| Layer | Where | Written by |
| --- | --- | --- |
| Code defaults | method, destructive path tokens, declared effects | the generator |
| Local policy | `.glirastes/tool-policy.json`, committed | the developer or the CLI, never an agent |
| Platform decisions | signed `toolOverrides` of the deployed configuration | owners and admins of a connected app |

## Risk tiers and confirmation

| Tier | Risk classes | Confirmation |
| --- | --- | --- |
| 0 | `safe-read` | off |
| 1 | `read-sensitive` | off |
| 2 | `write` | on; a reviewed, pinned entry may switch it off |
| 3 | `delete`, `financial`, `external`, `unknown` | always on, enforced by the runtime |

Every layer may disable a tool, raise its risk class, narrow its roles and
require confirmation. No layer enables a tool the code disabled or lacks,
lowers a risk class or adds roles.

## Switching a confirmation off locally

A tier-2 relaxation needs a reviewed entry pinned to the tool id and its
current class. It lapses when the code raises the risk above the pin.

```json
{
  "schemaVersion": 1,
  "tools": {
    "PATCH /api/tasks/:id": {
      "requiresApproval": false,
      "reason": "reviewed in PR 42",
      "pin": { "toolId": "<toolId from .glirastes/setup-artifact.json>", "atRiskClass": "write" }
    }
  }
}
```

## Platform relaxations (connected apps)

An owner or admin can switch a tool's confirmation off in the dashboard. The
signed decision takes effect in the running chat only when all of this holds:

1. It is part of a verified configuration and pinned to this tool id at the
   risk class the code reported when it was saved.
2. The tool's effective risk class is at most tier 2 and not above the pin.
   When the code or a later decision raises the risk, the relaxation lapses
   and the tool asks again. Tier 3 and `unknown` never relax.
3. The code report attributes the confirmation to the code default. Anything
   `tool-policy.json` decided is a local lock the Platform never relaxes: an
   explicit `"requiresApproval": true` (also on a tool that asks anyway) and a
   risk raise that brings confirmation.
4. The runner reports relaxation support at registration
   (`capabilities.policyRelaxations`), which it does when it registers with
   its setup artifact. The dashboard shows the relaxation as effective only
   for such runners; everywhere else it stays pending and the tool asks.

To keep a confirmation whatever the dashboard says, lock it:

```json
{
  "schemaVersion": 1,
  "tools": {
    "POST /api/invoices": { "requiresApproval": true, "reason": "always confirm invoices" }
  }
}
```

After `glirastes tools refresh` the code report names the confirmation
`local-policy`. `glirastes tools status` shows each asking tool as
`asks first, Platform may relax` or `asks first, locked in tool-policy.json`
(tier 3 just `asks first`).
