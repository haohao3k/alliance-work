# Native AGY driver provenance

These files originate from `@getpaseo/server@0.12.0`, published from Paseo commit
`cafe4b01c8522ff39560241c5deb01427dc8dc5b`. The original source directory is
`plugins/antigravity-provider/server`; the npm package contains its TypeScript sources under
`dist/server/builtin-plugins/antigravity-provider/server`.

The [license at that exact commit](https://github.com/getpaseo/paseo/blob/cafe4b01c8522ff39560241c5deb01427dc8dc5b/LICENSE)
is Apache-2.0, with copyright attributed to Mohamed Boudra. Its bytes exactly match the copy in
[LICENSE](LICENSE). Apache-2.0 permits redistribution subject to its conditions, including
retaining the license and attribution and marking modified files. There is no root NOTICE file
at that commit. The npm package omits license metadata and a license file, and its README says
MIT; this copy records the license from the immutable source commit instead.

`upstream/process.ts.txt` and `upstream/session.ts.txt` are unmodified source snapshots. Their
bytes match both the published npm package and the immutable repository source. They are retained
as verification inputs under the same license, and are never imported or read by the runtime.
The two modified runtime files carry change notices. Their behavioral adaptations and separate
original/adapted hashes are recorded in [provenance.json](provenance.json).

`npm run verify:vendor` checks every original hash and both adapted runtime hashes. It also checks
the unchanged Seatwork vendor separately; the public edition needs no private skill overrides or
override catalog to run this verification.
