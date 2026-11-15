import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { projectRoot } from "../scripts/profiles.mjs";
import { archiveJob, settleJob } from "../server/job-lifecycle";
import { processIdentity } from "../server/jobs.mjs";
import { RoomStore } from "../server/store";
import { temporary } from "./temp";

test("settle help examples bind an exited job and can record their advertised outcomes", async () => {
  const help = spawnSync(
    process.execPath,
    [join(projectRoot, "scripts/cli.mjs"), "jobs", "settle", "--help"],
    {
      encoding: "utf8",
      env: { ...process.env, ALLIANCE_WORK_HOME: "/nonexistent" },
    },
  );
  assert.equal(help.status, 0, help.stderr);
  const examples = [...help.stdout.matchAll(/<<'JSON'\n([\s\S]*?)\nJSON/g)].map((match) =>
    JSON.parse(match[1]),
  );
  assert.equal(examples.length, 2, "dedicated help offers unverified and verified JSON examples");
  const commands = [
    ...help.stdout.matchAll(
      /^alliance-work jobs settle --key (\S+) --revision (\d+) --outcome (\S+) --reason "([^"]+)"/gm,
    ),
  ];
  assert.equal(commands.length, examples.length);
  const dir = await temporary("job-help-");
  const store = new RoomStore(dir);
  try {
    const pid = spawnSync(process.execPath, ["-e", ""]).pid;
    for (const [i, proof] of examples.entries()) {
      const job = {
        key: commands[i][1],
        pid,
        processIdentity: "recorded-exited-process",
        roomId: "room",
        ownerId: "owner",
        title: "example",
        recordedAt: new Date().toISOString(),
        revision: Number(commands[i][2]),
      };
      store.saveJob(job);
      // The operator copies these identity fields from jobs list and hashes their own artifact.
      proof.pid = job.pid;
      proof.processIdentity = job.processIdentity;
      const evidence = join(dir, `proof-${i}.json`);
      if (proof.artifacts) {
        const artifact = join(dir, "result.txt");
        await writeFile(artifact, "result\n");
        proof.artifacts[0] = {
          path: artifact,
          sha256: createHash("sha256").update("result\n").digest("hex"),
        };
      }
      await writeFile(evidence, JSON.stringify(proof));
      await settleJob(store, {
        key: job.key,
        revision: job.revision,
        actorId: null,
        outcome: commands[i][3] as "unverified" | "succeeded",
        reason: commands[i][4],
        evidence,
      });
      assert.equal(store.job(job.key)?.settlement?.outcome, proof.outcome);
    }
    assert.deepEqual(
      examples.map((proof) => proof.outcome),
      ["unverified", "succeeded"],
    );
  } finally {
    store.close();
  }
});

test("settle names only mismatched binding fields, never their supplied or recorded values", async () => {
  const dir = await temporary("job-mismatch-");
  const store = new RoomStore(dir);
  try {
    const job = {
      key: "private-run",
      pid: process.pid,
      processIdentity: "private-process",
      roomId: "room",
      ownerId: "owner",
      title: "run",
      recordedAt: new Date().toISOString(),
      revision: 1,
    };
    store.saveJob(job);
    const evidence = join(dir, "proof.json");
    const input = {
      key: job.key,
      revision: 1,
      actorId: null,
      outcome: "unverified" as const,
      reason: "private-reason",
      evidence,
    };
    const valid = {
      key: job.key,
      pid: job.pid,
      processIdentity: job.processIdentity,
      outcome: input.outcome,
      reason: input.reason,
    };
    const fields = Object.keys(valid);
    for (const field of fields) {
      await writeFile(evidence, JSON.stringify({ ...valid, [field]: "private-wrong-value" }));
      await assert.rejects(settleJob(store, input), (error: Error) => {
        assert.equal(error.message.split("mismatched fields: ")[1], field);
        assert.doesNotMatch(error.message, /private-|unverified/);
        return true;
      });
    }
    for (const malformed of [null, [], 42, "private-note", {}]) {
      await writeFile(evidence, JSON.stringify(malformed));
      await assert.rejects(settleJob(store, input), (error: Error) => {
        assert.deepEqual(
          error.message.split("mismatched fields: ")[1]?.split(", ").sort(),
          fields.slice().sort(),
        );
        return true;
      });
    }
    assert.equal(store.job(job.key)?.revision, 1);
    assert.equal(store.job(job.key)?.settlement, undefined);
  } finally {
    store.close();
  }
});

test("job settlement preserves uncertainty, rejects live processes, stale revisions and changed evidence", async () => {
  const dir = await temporary("job-result-");
  const store = new RoomStore(dir);
  try {
    const job = {
      key: "run",
      roomId: "room",
      ownerId: "owner",
      title: "run",
      pid: process.pid,
      processIdentity: (await processIdentity(process.pid)) as string,
      recordedAt: new Date().toISOString(),
      revision: 1,
    };
    store.saveJob(job);
    const evidence = join(dir, "proof.json");
    const input = {
      key: job.key,
      revision: 1,
      actorId: null,
      outcome: "unverified" as const,
      reason: "Historical result unavailable",
      evidence,
    };
    await writeFile(evidence, JSON.stringify({ ...job, ...input }));
    await assert.rejects(settleJob(store, input), /Running or unknown/);
    await assert.rejects(
      archiveJob(store, { key: job.key, revision: 1, actorId: null, archive: true }),
      /Record a result/,
    );
    const exitedPid = spawnSync(process.execPath, ["-e", ""]).pid;
    store.saveJob({ ...job, pid: exitedPid, processIdentity: "previous-process", revision: 2 }, 1);
    await writeFile(
      evidence,
      JSON.stringify({ ...job, ...input, pid: exitedPid, processIdentity: "previous-process" }),
    );
    await assert.rejects(settleJob(store, input), /changed/);
    await assert.rejects(settleJob(store, { ...input, revision: 2, actorId: "stranger" }), /owner chain/);
    await settleJob(store, { ...input, revision: 2 });
    assert.equal(store.job(job.key)?.settlement?.outcome, "unverified");
    await archiveJob(store, { key: job.key, revision: 3, actorId: null, archive: true });
    assert.ok(store.job(job.key)?.archivedAt);
    await archiveJob(store, { key: job.key, revision: 4, actorId: null, archive: false });
    assert.equal(store.job(job.key)?.archivedAt, undefined);
    await writeFile(evidence, "{}");
    await assert.rejects(
      archiveJob(store, { key: job.key, revision: 5, actorId: null, archive: true }),
      /evidence changed/,
    );
  } finally {
    store.close();
  }
});
