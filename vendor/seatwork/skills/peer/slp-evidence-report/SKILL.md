---
name: slp-evidence-report
description: Peer procedure to report findings so the Owner can decide: verified, untested, failed, unknown kept apart, each with its proof; the shape of REVIEW and research results.
---
# Evidence report (Peer)
1. Four lists, never merged: **verified** (file:line, command, or document that proves it) ·
   **untested** (what you did not run and why) · **failed** (exact output, last lines) ·
   **unknown**. A before/after number is evidence only with its conditions: measured the same
   way, on a machine you checked was idle (a message that it is free is not a check), with the
   same workload; state the conditions next to the number.
2. Separate the real need from the candidate solution when the brief named one; say whether the
   evidence supports the candidate, without optimizing it.
3. Cite, do not paste: paths with line ranges, commands with last lines; stay under the brief's
   budget (default ~2k tokens).
4. Never state an API, flag, or behavior you did not check in this repo or its installed
   dependencies. Transport send, ACK, log presence, or a green suite are not
   proof of application behavior (see the structural anti-pattern catalog, "proof laundering").
5. Signal first line, `RECAP:` last line.
