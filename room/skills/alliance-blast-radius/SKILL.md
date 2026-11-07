---
name: alliance-blast-radius
description: Find what a shared-code change breaks beyond its diff and prove its safety assumptions by running code. Use before handback or review, not for a change wholly inside new code.
---

# Blast radius

Find what a change breaks somewhere else before it ships. Listing callers is not the job; a search does that quickly. The job is the breakage a search will not show you, and the proof that it is not there.

A convincing write-up is not proof. Find the one or two facts the change's safety depends on and prove them.

## How sure

Take each fact as far down this ladder as is cheap and within the assignment, and say where it stopped:

1. You said so. Worth nothing alone.
2. You pointed at the line: a real `path:line`, or the library's own source.
3. You walked the bad case step by step and showed it cannot reach.
4. You ran it: a script or test that calls the real code and fails loud if you are wrong.
5. You reproduced it in the running app.

A component test that injects a callback proves that component's response; it does not prove the native provider emits that callback. Name the boundary, candidate and actual target.

## Do

1. **Read the change:** what it adds, changes and deletes, and what it now does differently that the diff does not spell out.
2. **Find the one fact** it is safe because of, such as “this only drops entries that are already dead.” If it holds, most risks clear at once.
3. **Look where search stops:** the library's source at the pinned version, when things run (async order, teardown), a JSON field, a database column, a wire format, another language reading the same bytes, a flag, code three hops downstream. Look for the same fault elsewhere; fix the class within authorized scope and report adjacent work to its owner.
4. **Run what passed before.** Tests that passed on the base must still pass on your head: run the tests that use what you changed, plus required repository checks. A test that newly fails is yours until shown otherwise; a failure already on the base is named as such.
5. **Control.** A new regression test goes red on the code without the fix, for the bug's reason, and green with it. If the base cannot run, state the missing proof.
6. **Mutate once** when a single test is the only proof of a contract: break the behaviour it guards, see it go red, restore byte for byte. Use a disposable copy when mutating the shared checkout would affect another writer, running job or accepted candidate. A read-only assignment authorizes analysis and permitted checks, not source edits; report the proposed mutation if it cannot be run within that scope.

Do not stash, reset or restore shared work to manufacture the control. Keep the exact base/candidate identities and changed test in the evidence. Bound the experiment; do not turn every change into a mutation campaign or add a review quota.

## Report

In the existing candidate handback or review:

- **The fact:** what safety depends on, the rung reached, and the proof; `unproven` if it is not.
- **Risks:** how each breaks, `path:line`, how likely and how bad, how to check.
- **Cleared:** what you checked and why it is fine.
- **Ran:** neighbouring tests and their results, the control, the mutation if any; what you could not run and why.

Use candidate-bound evidence through `alliance-verify` when recording acceptance proof. The responsible owner decides; the normal room handback needs no extra prompt or acknowledgement.

This Alliance adaptation retains the upstream blast-radius guidance; attribution and changes are in [NOTICE.md](NOTICE.md).
