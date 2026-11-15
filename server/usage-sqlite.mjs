import { readFile, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const MAX_BYTES = 256 * 1024 * 1024;
function fail(code) {
  const error = new Error(
    code === "USAGE_SQLITE_NODE_UNSUPPORTED"
      ? `${code}: Node ${process.version} lacks SQLite deserialize (requires >=24.16)`
      : code,
  );
  error.code = code;
  throw error;
}
export const sqliteSnapshotBasis =
  "In-memory DB+committed-WAL snapshot; no SQLite connection to source, no SHM writes, no disk copy. Requires Node SQLite deserialize (24.16+); changing/corrupt/oversized snapshots are unavailable.";
async function optionalBytes(path) {
  try {
    if ((await stat(path)).size > MAX_BYTES) fail("USAGE_SQLITE_TOO_LARGE");
    return await readFile(path);
  } catch (error) {
    if (error.code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }
}
async function sample(path) {
  const reads = await Promise.allSettled([
    optionalBytes(path),
    optionalBytes(`${path}-wal`),
    optionalBytes(`${path}-journal`),
  ]);
  for (const r of reads) if (r.status === "rejected") throw r.reason;
  return reads.map((r) => r.value);
}
function checksum(bytes, little, initial = [0, 0]) {
  let [s0, s1] = initial;
  for (let i = 0; i < bytes.length; i += 8) {
    const x0 = little ? bytes.readUInt32LE(i) : bytes.readUInt32BE(i);
    const x1 = little ? bytes.readUInt32LE(i + 4) : bytes.readUInt32BE(i + 4);
    s0 = (s0 + x0 + s1) >>> 0;
    s1 = (s1 + x1 + s0) >>> 0;
  }
  return [s0, s1];
}

// SQLite WAL format/checksum: https://www.sqlite.org/fileformat2.html#walformat
// Opening even SQLite readOnly:true changes source SHM readmarks. Snapshot plain file bytes twice
// instead, fold checksum-verified committed WAL frames into memory, then query only the memory DB.
// A concurrent checkpoint/write, a hot rollback journal or unsupported Node yields unavailable
// metrics; it never falls back to opening the live database or copying conversation bytes to disk.
export async function readUsageDatabase(path) {
  if (typeof DatabaseSync.prototype.deserialize !== "function") fail("USAGE_SQLITE_NODE_UNSUPPORTED");
  let stable;
  let previous = await sample(path);
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = await sample(path);
    if (next.every((bytes, i) => bytes.equals(previous[i]))) {
      stable = next;
      break;
    }
    previous = next;
  }
  if (!stable) fail("USAGE_SQLITE_CHANGING");
  const [base, wal, journal] = stable;
  if (journal.subarray(0, 8).some((byte) => byte !== 0)) fail("USAGE_SQLITE_JOURNAL");
  if (base.length < 100 || base.subarray(0, 16).toString("binary") !== "SQLite format 3\0")
    fail("USAGE_SQLITE_INVALID");
  const pageSize = base.readUInt16BE(16) === 1 ? 65536 : base.readUInt16BE(16);
  if (pageSize < 512 || pageSize > 65536 || pageSize & (pageSize - 1)) fail("USAGE_SQLITE_INVALID");
  let image = Buffer.from(base);
  if (wal.length) {
    if (wal.length < 32) fail("USAGE_SQLITE_TRUNCATED_WAL");
    const magic = wal.readUInt32BE(0);
    if (
      ![0x377f0682, 0x377f0683].includes(magic) ||
      wal.readUInt32BE(4) !== 3007000 ||
      wal.readUInt32BE(8) !== pageSize
    )
      fail("USAGE_SQLITE_INVALID_WAL");
    const little = magic === 0x377f0682;
    let sums = checksum(wal.subarray(0, 24), little);
    if (sums[0] !== wal.readUInt32BE(24) || sums[1] !== wal.readUInt32BE(28))
      fail("USAGE_SQLITE_CORRUPT_WAL");
    if ((wal.length - 32) % (24 + pageSize)) fail("USAGE_SQLITE_TRUNCATED_WAL");
    const frames = [];
    let commit = 0;
    let pages = 0;
    for (let offset = 32; offset + 24 + pageSize <= wal.length; offset += 24 + pageSize) {
      if (!wal.subarray(offset + 8, offset + 16).equals(wal.subarray(16, 24))) break; // SQLite reset leaves checkpointed old-epoch frames after the current prefix.
      sums = checksum(wal.subarray(offset, offset + 8), little, sums);
      sums = checksum(wal.subarray(offset + 24, offset + 24 + pageSize), little, sums);
      if (sums[0] !== wal.readUInt32BE(offset + 16) || sums[1] !== wal.readUInt32BE(offset + 20))
        fail("USAGE_SQLITE_CORRUPT_WAL");
      const page = wal.readUInt32BE(offset);
      if (!page) fail("USAGE_SQLITE_INVALID_WAL");
      frames.push({ page, offset: offset + 24 });
      if (wal.readUInt32BE(offset + 4)) {
        pages = wal.readUInt32BE(offset + 4);
        commit = frames.length;
      }
    }
    if (commit) {
      if (pages * pageSize > MAX_BYTES) fail("USAGE_SQLITE_TOO_LARGE");
      image = Buffer.alloc(pages * pageSize);
      base.copy(image, 0, 0, image.length);
      for (const frame of frames.slice(0, commit))
        if (frame.page <= pages)
          wal.copy(image, (frame.page - 1) * pageSize, frame.offset, frame.offset + pageSize);
      image.writeUInt32BE(pages, 28);
    }
  }
  // Deserialized SQLite databases cannot use WAL; the memory image already includes its commits.
  image[18] = image[19] = 1;
  const db = new DatabaseSync(":memory:");
  try {
    db.deserialize(image);
    db.exec("PRAGMA query_only=ON");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
