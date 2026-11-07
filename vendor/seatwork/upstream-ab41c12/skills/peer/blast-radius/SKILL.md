---
name: blast-radius
description: "Finds what a change breaks beyond its diff (callers, sibling cases, tests that use it) and proves the one fact that makes it safe by running code. Use before handing in or judging a change to shared code; not for a change wholly inside new code."
---

# Blast radius

Find what a change breaks somewhere else before it ships. Listing callers is not the job; a search does that in a second. The job is the breakage a search will not show you, and the proof that it is not there.

A write-up that sounds right is worthless: it reads as convincing whether or not it is true. Find the one or two facts the change's safety depends on and prove them.

## How sure

Take each fact as far down this ladder as is cheap, and say where it stopped:

1. You said so. Worth nothing alone.
2. You pointed at the line: a real `path:line`, or the library's own source.
3. You walked the bad case step by step and showed it cannot reach.
4. You ran it: a script or test that calls the real code and fails loud if you are wrong.
5. You reproduced it in the running app.

## Do

1. **Read the change**: what it adds, changes and deletes, and what it now does differently that the diff does not spell out.
2. **Find the one fact** it is safe because of ("this only drops entries that are already dead"). If it holds, most risks clear at once.
3. **Look where search stops**: the library's source at the pinned version, when things run (async order, teardown), a JSON field, a database column, a wire format, another language reading the same bytes, a flag, code three hops downstream. Fix the class: the same fault elsewhere is part of this change.
4. **Run what passed before.** The tests that passed on the base must still pass on your head: run the tests that use what you changed. A test that newly fails is yours until shown otherwise; a failure already on the base is named as such.
5. **Control.** The new test goes red on the code without the fix, for the bug's reason, and green with it.
6. **Mutate once** when a single test is the only proof of a contract: break the behaviour it guards, see it go red, restore byte for byte.

## Report

In `CANDIDATE` or `REVIEW`:
- **The fact** it is safe because of, the rung reached, and the proof; `unproven` if it is not.
- **Risks**: how each breaks, `path:line`, how likely and how bad, how to check.
- **Cleared**: what you checked and why it is fine.
- **Ran**: the neighbouring tests and their result, the control, the mutation if any; what you could not run and why.
