import { contextTokenLimit } from "./context-policy.mjs";

// Pi's native compaction uses the selected model's contextWindow minus its
// reserve. Keep smaller models intact; this also covers extension providers.
export default function contextLimit(pi) {
  const cap = (_event, ctx) => {
    for (const model of [...ctx.modelRegistry.getAll(), ctx.model]) {
      if (model && model.contextWindow > contextTokenLimit) model.contextWindow = contextTokenLimit;
    }
  };
  pi.on("session_start", cap);
  pi.on("model_select", cap);
  pi.on("before_agent_start", cap);
  pi.on("turn_start", cap);
}
