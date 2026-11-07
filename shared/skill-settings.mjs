import { z } from "zod";

export const SkillPath = z.string().regex(/^\.agents\/skills\/[a-z0-9][a-z0-9-]{0,63}$/);
export const SkillSelection = z
  .array(SkillPath)
  .max(100)
  .refine((paths) => new Set(paths).size === paths.length, "Duplicate project skill");
export const DisabledBundled = z
  .array(z.string().regex(/^(?:slp|alliance)-[a-z0-9-]+$/))
  .max(100)
  .refine((names) => new Set(names).size === names.length, "Duplicate bundled skill");
export const SkillManifest = z
  .object({ version: z.literal(1), skills: SkillSelection, disabledBundled: DisabledBundled.optional() })
  .strict();
export const SkillEntry = z.object({
  path: z.string(),
  name: z.string(),
  description: z.string(),
  directory: z.string(),
  error: z.string().nullable(),
  digest: z.string().nullable(),
});
export const SkillSettings = z.object({
  root: z.string(),
  revision: z.string(),
  selected: SkillSelection,
  available: z.array(SkillEntry),
  disabledBundled: DisabledBundled,
  bundled: z.array(
    z.object({ name: z.string(), description: z.string(), source: z.string(), roles: z.array(z.string()) }),
  ),
});
