# Alliance verification map

| ID | Entry and observable outcome | Check |
| --- | --- | --- |
| project-skills | Register `.agents/skills/NAME` with `alliance-work skills add`; open a fresh Alliance session. Selected skill is discoverable on Codex, Claude and Pi; an unselected sentinel is absent. | `npm run test:native` |
| evidence-binding | Run `alliance-work verify --scenario NAME -- COMMAND`; submit its report through `accept` or `members.disposition`. Matching candidate is accepted; invented evidence, changed source/ignored input/artifact and failed checks are refused. | `npm run check`; native RPC path in `npm run test:maintenance` |
| native-assignment | Open an Alliance profile in a new workspace; inspect its member assignment. A durable pointer identifies the owner/session/checkout without inventing unavailable initial text. | `npm run test:maintenance` |
| lead-choice | Create Lead on a supported model/effort outside the worker preference. It launches with that explicit selection. | `npm run test:maintenance` |
| release-recovery | Activate a candidate, then a broken candidate, in an isolated native instance. Selected source becomes active; failed activation restores the prior plugin, credentials and room artifacts. | `npm run test:maintenance` |

These cover CLI/native boundaries. They do not cover all browser UI entry points, cross-host
network paths or model handbacks. Mark those as unverified unless exercised explicitly.
