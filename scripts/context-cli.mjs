import { roles } from "./profiles.mjs";

/** Read-modify-save keeps role overrides and the server's current revision together. */
export async function contextCommand(args, flags, { actorId, invoke }) {
  const [action] = args;
  if (args.length !== 1 || !["show", "set", "reset"].includes(action))
    throw new Error("Usage: context show|set|reset --room ID [--role ROLE] [--claude-window 300000|232000]");
  if (!flags["--room"]) throw new Error("Missing --room");
  const role = flags["--role"];
  const window = flags["--claude-window"];
  if (role !== undefined && !roles.includes(role)) throw new Error(`--role takes ${roles.join("|")}`);
  if (action === "show" && (role !== undefined || window !== undefined))
    throw new Error("context show takes --room only");
  if (action === "reset" && window !== undefined)
    throw new Error("context reset takes --room and optional --role");
  if (action === "set" && !["300000", "232000"].includes(window))
    throw new Error("context set requires --claude-window 300000|232000");
  if (action !== "show" && actorId !== null)
    throw new Error("Context policy changes belong to the Human; run outside an agent session");
  const roomId = flags["--room"];
  const current = await invoke("context.read", { roomId });
  if (action === "show") return current;
  const policy = { ...current.policy, roles: { ...current.policy.roles } };
  if (action === "set") {
    if (role) policy.roles[role] = Number(window);
    else policy.claudeWindow = Number(window);
  } else if (role) delete policy.roles[role];
  else {
    policy.claudeWindow = 300000;
    policy.roles = {};
  }
  return invoke("context.save", { roomId, policy, revision: current.revision, actorId });
}
