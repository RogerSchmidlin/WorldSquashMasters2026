const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = __dirname;
const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const basicName = v => clean(v)
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[’‘]/g, "'")
  .toLowerCase()
  .replace(/\[[^\]]*\]/g, ' ')
  .replace(/[^a-z0-9']+/g, ' ')
  .trim();
const nameKey = v => basicName(v).split(/\s+/).filter(Boolean).sort().join(' ');

console.log('=== FINAL RESULTS BUILD START ===');
console.log('Source: final-results-source.json');
console.log('Placings are NOT inferred from matches-data.js or data.js.');

function evalWindowFile(fileName) {
  const fp = path.join(DIR, fileName);
  if (!fs.existsSync(fp)) return {};
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(fp, 'utf8'), ctx, { filename: fileName });
  return ctx.window;
}

const sourcePath = path.join(DIR,'final-results-source.json');
if (!fs.existsSync(sourcePath)) throw new Error('Missing final-results-source.json. results-data.js was left unchanged.');
const source = JSON.parse(fs.readFileSync(sourcePath,'utf8'));
const sourceRows = Array.isArray(source.rows) ? source.rows : [];

const expectedKeys = [
  'Men|35','Men|40','Men|45','Men|50','Men|55','Men|60','Men|65','Men|70','Men|75','Men|80','Men|85',
  'Women|35','Women|40','Women|45','Women|50','Women|55','Women|60','Women|65','Women|70','Women|75','Women|80'
];

function keyOf(r){ return `${clean(r.gender)}|${Number(r.ageGroup)||0}`; }
const cells=new Map(), errors=[];
for(const r of sourceRows){
  const key=keyOf(r), place=Number(r.place), name=clean(r.playerName);
  if(!expectedKeys.includes(key)) { errors.push(`unexpected category ${key}`); continue; }
  if(!Number.isInteger(place)||place<1||place>4){errors.push(`${key}: invalid place ${r.place}`);continue;}
  if(!name || /^(?:bye|tbd)$/i.test(name)){errors.push(`${key}: place ${place} is not a real player`);continue;}
  const ck=`${key}|${place}`;
  if(cells.has(ck)) errors.push(`${ck}: duplicate placement`); else cells.set(ck,r);
}
for(const key of expectedKeys){
  const names=[];
  for(let p=1;p<=4;p++){
    const r=cells.get(`${key}|${p}`);
    if(!r) errors.push(`${key}: missing place ${p}`); else names.push(nameKey(r.playerName));
  }
  if(names.length===4 && new Set(names).size!==4) errors.push(`${key}: top four are not four distinct players`);
}
if(sourceRows.length!==84) errors.push(`source row count is ${sourceRows.length}, expected 84`);
if(errors.length) throw new Error(`Invalid final-results-source.json: ${errors.join('; ')}. results-data.js was left unchanged.`);

const legacy = evalWindowFile('data.js').TOURNAMENT_DATA || {};
const splitPlayers = evalWindowFile('players-data.js').TOURNAMENT_PLAYERS || [];
const players = Array.isArray(splitPlayers) && splitPlayers.length ? splitPlayers : (Array.isArray(legacy.players) ? legacy.players : []);
const byName=new Map();
for(const p of players){
  const k=nameKey(p?.name||''); if(!k) continue;
  if(!byName.has(k)) byName.set(k,[]); byName.get(k).push(p);
}
function playerFor(name,gender,age){
  const list=byName.get(nameKey(name))||[];
  if(list.length===1) return list[0];
  const exact=list.filter(p=>clean(p.gender)===gender && Number(p.ageGroup)===age);
  return exact.length===1 ? exact[0] : null;
}

const output=[];
for(const key of expectedKeys){
  const [gender,ageRaw]=key.split('|'); const age=Number(ageRaw); const names=[];
  for(let place=1;place<=4;place++){
    const src=cells.get(`${key}|${place}`);
    const p=playerFor(src.playerName,gender,age)||{};
    const name=p.name||src.playerName; names.push(name);
    output.push({
      event:`${gender==='Women'?"Women's":"Men's"} +${age}`,
      gender, ageGroup:age, place:String(place), placeRank:place, playerName:name,
      officialPlayerId:p.officialPlayerId||src.officialPlayerId||'',
      officialProfileUrl:p.officialProfileUrl||src.officialProfileUrl||'',
      country:p.country||src.country||'', iso3:p.iso3||src.iso3||'', flagCode:p.flagCode||src.flagCode||'',
      countryCode:p.drawCountryCode||p.countryCode||src.countryCode||src.iso3||'',
      seed:clean(p.seed??src.seed??''),
      squashLevelsWorldRank:p.squashLevelsWorldRank??src.squashLevelsWorldRank??null,
      squashLevelsLevel:p.squashLevelsLevel??src.squashLevelsLevel??null,
      squashLevelsLevelProvisional:!!(p.squashLevelsLevelProvisional??src.squashLevelsLevelProvisional),
      club:clean(p.squashLevelsClubLocation||src.club||''),
      source:'Final tournament results source', sourceUrl:'', resultMethod:'final-results-source-v28'
    });
  }
  console.log(`  RESULT ${key}: ${names.join(' > ')}`);
}

if(output.length!==84 || output.some(r=>/^(?:bye|tbd)$/i.test(clean(r.playerName)))) throw new Error('Internal validation failed: output must contain exactly 84 real-player placements.');

const pack={
  refreshedAt:'2026-09-06T23:59:00+08:00', generatedAt:'2026-09-06T23:59:00+08:00',
  source:'Final tournament results source enriched from local player data', sourceUrl:'',
  algorithm:'final-authoritative-source-v28', rows:output
};
const target=path.join(DIR,'results-data.js');
const out=`window.TOURNAMENT_RESULTS = ${JSON.stringify(pack)};\n`;
const previous=fs.existsSync(target)?fs.readFileSync(target,'utf8'):'';
if(previous!==out) fs.writeFileSync(target,out);

console.log('\n=== FINAL RESULTS BUILD ===');
console.log(`Final groups: ${expectedKeys.length}`);
console.log(`Final placement rows: ${output.length}`);
console.log('Bye/TBD placements: 0');
console.log(`Local player metadata records: ${players.length}`);
console.log(previous===out?'results-data.js is already up to date.':'Wrote only results-data.js.');
console.log('No matches parsed. No browser launched. No scraping. No network request made.');
