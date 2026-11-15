import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { ContextPolicy, ContextSettings } from "./context-settings.mjs";

export const contextRead = defineRpc({
  name: "context.read",
  input: z.object({ roomId: z.string().min(1) }),
  output: ContextSettings,
});
export const contextSave = defineRpc({
  name: "context.save",
  input: z.object({
    roomId: z.string().min(1),
    policy: ContextPolicy,
    revision: ContextSettings.shape.revision,
    actorId: z.string().min(1).nullable(),
  }),
  output: ContextSettings,
});
