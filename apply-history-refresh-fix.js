/*
  World Squash Masters 2026 - historical fixture backfill patch

  Why this exists:
  refresh-data.js preserved rows that were already historical, but it refused to
  ADD authoritative TournamentSoftware rows after their date had passed. That
  made matches visible during the day disappear from the static history after
  midnight if they had not already been persisted.

  Run once from the repository root:
      node apply-history-refresh-fix.js

  Then rebuild tournament matches once:
      npm run refresh -- :matches
*/
const fs=require('fs');
const path=require('path');
const {spawnSync}=require('child_process');

const target=path.join(__dirname,'refresh-data.js');
const backup=path.join(__dirname,'refresh-data.before-history-backfill.js');
const marker='WSM_HISTORY_BACKFILL_V1';

function fail(message){
  console.error(`\nHistory backfill patch NOT applied: ${message}`);
  process.exit(1);
}
function replaceOnce(text,from,to,label){
  const first=text.indexOf(from);
  if(first<0)fail(`Could not find expected ${label} code. refresh-data.js was left unchanged.`);
  const second=text.indexOf(from,first+from.length);
  if(second>=0)fail(`Found ${label} code more than once. Refusing an ambiguous patch.`);
  return text.slice(0,first)+to+text.slice(first+from.length);
}

if(!fs.existsSync(target))fail('refresh-data.js is not in this folder. Put this patch file in the repository root.');
const original=fs.readFileSync(target,'utf8');
if(original.includes(marker)){
  console.log('Historical fixture backfill patch is already installed. No changes made.');
  process.exit(0);
}

const fnStart=original.indexOf('function buildDrawAuthoritativeTournamentSchedule(');
const fnEnd=original.indexOf('function overlayAuthoritativeTournamentResults',fnStart);
if(fnStart<0||fnEnd<0||fnEnd<=fnStart){
  fail('Could not safely locate buildDrawAuthoritativeTournamentSchedule().');
}

let before=original.slice(0,fnStart);
let block=original.slice(fnStart,fnEnd);
let after=original.slice(fnEnd);

// Mark the patched function so the operation is safely idempotent.
block=replaceOnce(
  block,
  "function buildDrawAuthoritativeTournamentSchedule(existingRows,drawRows,matchesRows,{preserveHistory=true}={}){\n",
  "function buildDrawAuthoritativeTournamentSchedule(existingRows,drawRows,matchesRows,{preserveHistory=true}={}){\n  // WSM_HISTORY_BACKFILL_V1: authoritative past fixtures may be added after day rollover.\n",
  'function header'
);

// 1) TournamentSoftware Matches rows are valid history evidence after the day has passed.
block=replaceOnce(
  block,
  "    if(!d||d<today)continue;\n    if(!realPlayer(m0.player1)||!realPlayer(m0.player2))continue;",
  "    if(!d)continue;\n    if(!realPlayer(m0.player1)||!realPlayer(m0.player2))continue;",
  'past Match-row rejection'
);

// 2) Venue/court is mandatory for current/future scheduling, but must not erase history.
block=replaceOnce(
  block,
  "    if(!validLocation(m0)&&!exactDrawHasLocation)continue;",
  "    if(d>=today&&!validLocation(m0)&&!exactDrawHasLocation)continue;",
  'historical location rejection'
);

// 3) Existing historical rows remain preserved, but newly discovered authoritative
//    historical rows must also flow into the final exact-fixture merge.
block=replaceOnce(
  block,
  "    if(preserveHistory&&d<today)continue;\n\n    const m={...auth0};",
  "    // Existing history was copied above, but authoritative rows from older dates\n    // must still be allowed through so missing history can be backfilled.\n\n    const m={...auth0};",
  'authoritative history skip'
);

// Keep comments truthful for future maintenance. These replacements are optional.
block=block.replace(
  '  // Only use concrete current/future Match rows with a proven location (or an\n  // exact draw observation that can prove the location). Do not let a pairing',
  '  // Use concrete TournamentSoftware Match rows as fixture evidence. Current/future\n  // rows still require a proven location; historical rows do not. Do not let a pairing'
);
block=block.replace(
  '  // Preserve immutable history only.\n',
  '  // Preserve existing immutable history first; authoritative history is merged below.\n'
);

const patched=before+block+after;

// Verify that the intended old blockers are gone from this function only.
const patchedBlock=patched.slice(fnStart,patched.indexOf('function overlayAuthoritativeTournamentResults',fnStart));
if(patchedBlock.includes('if(preserveHistory&&d<today)continue;'))fail('Historical authority skip still exists after patching.');
if(patchedBlock.includes('if(!d||d<today)continue;'))fail('Historical Match-row skip still exists after patching.');
if(!patchedBlock.includes('if(d>=today&&!validLocation(m0)&&!exactDrawHasLocation)continue;'))fail('Current/future location safety rule was not installed.');

const temp=target+'.history-backfill-check.tmp.js';
try{
  fs.writeFileSync(temp,patched,'utf8');
  const check=spawnSync(process.execPath,['--check',temp],{encoding:'utf8'});
  if(check.status!==0){
    fail(`Patched JavaScript did not pass syntax validation:\n${check.stderr||check.stdout}`);
  }
}finally{
  try{if(fs.existsSync(temp))fs.unlinkSync(temp);}catch{}
}

if(!fs.existsSync(backup))fs.writeFileSync(backup,original,'utf8');
fs.writeFileSync(target,patched,'utf8');

console.log('\nHistorical fixture backfill patch installed successfully.');
console.log(`Backup: ${path.basename(backup)}`);
console.log('Next run: npm run refresh -- :matches');
console.log('That matches-only run rebuilds TournamentSoftware match history and does not require a SquashLevels refresh.');
