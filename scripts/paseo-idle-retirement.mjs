/** Runs inside the native lifecycle owner. No prompts, archive, cancellation or SQL writes. */
export async function retireIdleRuntime(agentId, expectedUpdatedAt) {
  const live = this.getAgent(agentId);
  if (!live || live.updatedAt.toISOString() !== expectedUpdatedAt) return false;
  const runtimes = this.getRuntimeCleanupCandidates();
  const root = runtimes.find((item) => item.agentId === agentId);
  if (!root?.sessionId || !root.provider.startsWith("alliance-claude-")) return false;
  const family = new Map([[root.agentId, root]]);
  for (const parent of family.values())
    for (const child of runtimes)
      if (child.parentAgentId === parent.agentId) family.set(child.agentId, child);
  const eligible = () => {
    const current = this.getRuntimeCleanupCandidates();
    return (
      [...family.values()].every((item) => item.isEligible()) &&
      current
        .filter((item) => family.has(item.agentId))
        .every((item) => family.get(item.agentId).identity === item.identity) &&
      !current.some(
        (item) => item.parentAgentId && family.has(item.parentAgentId) && !family.has(item.agentId),
      )
    );
  };
  if (!eligible()) return false;
  for (const item of family.values()) {
    // Unknown provider background ownership is a veto, never a permission to stop.
    if (!item.canStopRuntime) return false;
    let timer;
    try {
      const allowed = await Promise.race([
        item.canStopRuntime(),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), 10000);
        }),
      ]);
      if (allowed !== true || !eligible()) return false;
    } finally {
      clearTimeout(timer);
    }
  }
  // Native closeIfEligible blocks prompt admission, acquires the lifecycle lane, drains events,
  // revalidates captured runtime identities and preserves the native persistence handle/history.
  return root.closeIfEligible(eligible);
}
