import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { DisabledBundled, SkillSelection, SkillSettings } from "./skill-settings.mjs";

const source = z.string().min(1).max(2048);
const remoteSkill = z.object({
  path: z.string(),
  name: z.string(),
  description: z.string(),
  body: z.string(),
  digest: z.string(),
  bytes: z.number(),
});
export const skillsRead = defineRpc({
  name: "skills.read",
  input: z.object({ cwd: z.string() }),
  output: SkillSettings,
});
export const skillsSave = defineRpc({
  name: "skills.save",
  input: z.object({
    cwd: z.string(),
    selected: SkillSelection,
    revision: z.string(),
    disabledBundled: DisabledBundled.optional(),
  }),
  output: SkillSettings,
});
export const skillsPreview = defineRpc({
  name: "skills.preview",
  input: z.object({ source }),
  output: z.object({
    source,
    repository: z.string(),
    commit: z.string(),
    skills: z.array(remoteSkill),
    errors: z.array(z.object({ path: z.string(), error: z.string() })),
  }),
});
export const skillsInstall = defineRpc({
  name: "skills.install",
  input: z.object({
    cwd: z.string(),
    source,
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    requested: z
      .array(z.object({ path: z.string(), digest: z.string() }))
      .min(1)
      .max(100),
    revision: z.string(),
  }),
  output: SkillSettings,
});
