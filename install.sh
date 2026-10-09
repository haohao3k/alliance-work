#!/bin/sh
set -eu

# Run from a checkout, or download this asset with authenticated gh for a release install.
ALLIANCE_SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
command -v node >/dev/null 2>&1 || { echo 'Node 24+ is required.' >&2; exit 1; }
node -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)' || { echo 'Node 24+ is required.' >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo 'npm is required.' >&2; exit 1; }

if [ -f "$ALLIANCE_SCRIPT_DIR/scripts/cli.mjs" ]; then
  ALLIANCE_CANDIDATE=$ALLIANCE_SCRIPT_DIR
else
  command -v gh >/dev/null 2>&1 || { echo 'Install GitHub CLI and run gh auth login; the repository is private.' >&2; exit 1; }
  ALLIANCE_DEST="$HOME/.alliance-work"
  ALLIANCE_READ_HOME=0
  for ALLIANCE_ARG in "$@"; do
    if [ "$ALLIANCE_READ_HOME" = 1 ]; then ALLIANCE_DEST=$ALLIANCE_ARG; ALLIANCE_READ_HOME=0; fi
    if [ "$ALLIANCE_ARG" = --home ]; then ALLIANCE_READ_HOME=1; fi
  done
  ALLIANCE_DEST=$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$ALLIANCE_DEST")
  ALLIANCE_TAG=$(gh release view --repo haohao3k/alliance-work --json tagName --jq .tagName)
  node -e 'if(!/^v\d+\.\d+\.\d+$/.test(process.argv[1]))process.exit(1)' "$ALLIANCE_TAG" || { echo 'Expected a stable release tag.' >&2; exit 1; }
  mkdir -p "$ALLIANCE_DEST/releases"
  ALLIANCE_STAGE=$(mktemp -d "$ALLIANCE_DEST/releases/install.XXXXXX")
  trap 'rm -rf "$ALLIANCE_STAGE"' EXIT HUP INT TERM
  ALLIANCE_ARCHIVE="alliance-work-$ALLIANCE_TAG.tar.gz"
  gh release download "$ALLIANCE_TAG" --repo haohao3k/alliance-work --dir "$ALLIANCE_STAGE" --pattern "$ALLIANCE_ARCHIVE" --pattern checksums.txt
  node --input-type=module - "$ALLIANCE_STAGE" "$ALLIANCE_ARCHIVE" <<'NODE'
import fs from 'node:fs'; import {createHash} from 'node:crypto';
const [dir,name]=process.argv.slice(2);
const sum=createHash('sha256').update(fs.readFileSync(`${dir}/${name}`)).digest('hex');
const matches=fs.readFileSync(`${dir}/checksums.txt`,'utf8').trim().split('\n').map(l=>l.trim().split(/\s+/)).filter(p=>p[1]===name);
if(matches.length!==1 || matches[0][0]!==sum)throw new Error('Release checksum failed; installation unchanged.');
NODE
  tar -tzf "$ALLIANCE_STAGE/$ALLIANCE_ARCHIVE" > "$ALLIANCE_STAGE/entries.txt"
  tar -tvzf "$ALLIANCE_STAGE/$ALLIANCE_ARCHIVE" > "$ALLIANCE_STAGE/types.txt"
  node --input-type=module - "$ALLIANCE_STAGE" <<'NODE'
import fs from 'node:fs';const dir=process.argv[2];
if(fs.readFileSync(`${dir}/entries.txt`,'utf8').trim().split('\n').some(p=>!p.startsWith('alliance-work/')||p.split('/').includes('..')))throw new Error('Unexpected archive path.');
if(fs.readFileSync(`${dir}/types.txt`,'utf8').trim().split('\n').some(l=>!['d','-'].includes(l[0])))throw new Error('Unexpected archive link.');
NODE
  tar -xzf "$ALLIANCE_STAGE/$ALLIANCE_ARCHIVE" -C "$ALLIANCE_STAGE"
  ALLIANCE_CANDIDATE="$ALLIANCE_DEST/releases/$ALLIANCE_TAG-$(date +%s)"
  mv "$ALLIANCE_STAGE/alliance-work" "$ALLIANCE_CANDIDATE"
fi

npm --prefix "$ALLIANCE_CANDIDATE" ci --no-audit --no-fund
npm --prefix "$ALLIANCE_CANDIDATE" run check
node "$ALLIANCE_CANDIDATE/scripts/cli.mjs" install "$@"
