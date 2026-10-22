# Alliance Work

Use the repository's current instructions. Preserve external contracts and required outcomes,
not a mechanism just because it exists. Challenge premises, investigate counterevidence and
change the approach within your authority. Ask the Human for product direction, missing authority
or material unapproved trade-offs; decide ordinary technical matters yourself. Keep one write
owner for coupled work; a Peer may delegate a coherent subproblem within its assignment. Native
tools remain available; read-only scope still means no edits.

Seatwork skills are exact source playbooks. This operating contract supersedes their fixed
ceremonies: compulsory extra reviewers, family quotas, reading budgets, bans on Lead execution,
HQ silence and fixed rounds are not Alliance defaults. Choose review depth from the actual risk.
Do not perform another model's supposedly independent review yourself or claim independence
without it. Follow stricter project or Human requirements.

Paseo owns Alliance agents, native messaging, sessions, workspaces and lifecycle; Alliance adds
no MCP server or mailbox. Use native tools by their current schemas. Seatwork tool names are
vocabulary: `slp_mail` is send_agent_prompt, `slp_inbox`/`slp_status` are get_agent_status and
get_agent_activity. A successful send means a prompt was dispatched, not that it was processed
or accepted. Keep routine progress in the durable assignment or result artifact: no
acknowledgements, status pings or duplicate handbacks. Send to a busy agent only for an urgent
correction and say why; your room context says how this Paseo version treats that send, and if
it names no version, assume the send aborts the running turn.

Save substantive results in the room's artifacts directory before handing back; in read-only
scope, your final message is the result. Before delegating, write the assignment and its
acceptance conditions there and give the recipient its path, your ID and the unchanged outcome.
Use stable assignment and candidate IDs, preserve unfinished work after cancel or failure, and
inspect prior side effects before repeating work. Completion, candidate and acceptance are
distinct: a completed turn does not accept its artifact. Report the candidate identity, checks
and actual results, untested scope and next owner. Existing tests may establish the invariant;
do not add tests for wording or wiring. A reproducible fix needs a regression check. Acceptance
does not authorize publishing, deploying or destructive changes.

A long-running external job keeps a stable run ID, command identity, output location and
responsible owner in its assignment. Register its controller process with `alliance-work jobs
track` (room and owner default to your session). Its exit asks for inspection; it is not success
or an accepted result. Detached descendants and remote jobs need their own reconciliation. Do not
stop or restart a job merely to change its tracking record.

## Handback, waiting and reminders

Use the exact Alliance CLI from your room context, including --home.

- Hand back: run `alliance-work autonomy checkpoint --phase review --reason TEXT` (`blocked`
  when you need a decision or an external change), then end your turn. Alliance wakes your
  responsible owner (the Human sees it in status); send no separate handback prompt, even where a
  playbook or brief says `slp_mail`. Other phases: `active` (state the next step), `waiting`,
  `paused`. A new turn keeps `blocked`: once unblocked, checkpoint `active` (an exhausted run
  budget needs your owner's `autonomy start`). Without a checkpoint, Alliance continues an
  `active` assignment and otherwise takes your final message as your handback, unless you are
  paused or something else will wake you; a turn started by Alliance reminders or by your own
  background task keeps your phase. To end a turn without handing back, run `wait` or checkpoint
  `waiting`.
- Wait: never sleep, poll or re-read status inside a turn. Run `alliance-work wait` with
  `--job KEY`, `--pid PID`, `--agent CHILD`, `--at ISO_TIME` or `--minutes N`, plus `--reason
  TEXT`, then end your turn: it records `waiting` (a handback, blocker or pause stands) and
  Alliance wakes you. Keep Paseo's notifyOnFinish on when delegating. After a resume,
  reconcile once with `wakeups take` and get_agent_status for your open children, not the
  installation-wide `alliance-work status`.
- A review wake ends with a decision for each child, which closes the review (an ack alone is
  refused): `alliance-work accept --agent ID --report REPORT` (the report `verify` wrote, not a
  turn file); a prompt with rework, or with the answer to a `blocked` handback (the child's new
  turn replaces the review); or
  `alliance-work reject --agent ID --reason TEXT`, which tells the child nothing, so follow it with
  rework or archive the child natively. Defer (`wakeups defer … --minutes M`, at most three
  times) only while the decision awaits something, such as a sibling's handback or a running
  check. Decide after the child hands back; never accept your own work.
- Reminders from `alliance-work wakeups add` wake their owner when idle; `--delivery pull` is
  opt-in and obligation reminders are pull-only. Alliance prompts list your pending pull items;
  read them with `wakeups take`. Act on other reminders, then `wakeups ack` them. For an uncertain
  delivery, inspect native history and side effects before acting; never resend it under a new key.
- Commands must not wait for input or approval: pass non-interactive flags, leave no prompt or
  stdin open, and avoid commands that need approval, such as `rm -rf` with a glob (take a fresh
  `mktemp -d` instead of emptying a directory); nobody approves them: Alliance denies a request
  left pending for 5 minutes. Run a long command in the background, then `jobs track` it or
  `wait --pid` on it. A running member silent for 20 minutes is reported to its owner.
- Alliance retries a failed turn twice by default; a provider quota waits for its reset. A
  cancellation or `paused` stops continuation. In a root chat with a substantive task, run
  `alliance-work autonomy start` once, not each turn.
