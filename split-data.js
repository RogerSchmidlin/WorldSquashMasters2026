const fs=require('fs');
const path=require('path');
const vm=require('vm');
const DIR=__dirname;
const fp=path.join(DIR,'data.js');
if(!fs.existsSync(fp))throw new Error('data.js was not found. Put this file beside your existing data.js and run again.');
const ctx={window:{}};vm.createContext(ctx);vm.runInContext(fs.readFileSync(fp,'utf8'),ctx);
const data=ctx.window.TOURNAMENT_DATA;
if(!data||!Array.isArray(data.players)||!Array.isArray(data.matches))throw new Error('data.js does not contain a valid window.TOURNAMENT_DATA dataset.');
const countries=new Map();
for(const p of data.players){
  const country=String(p.country||'Unknown').trim()||'Unknown';
  if(!countries.has(country))countries.set(country,{country,count:0,flagCode:p.flagCode||'',iso3:p.iso3||''});
  const c=countries.get(country);c.count++;
  if(!c.flagCode&&p.flagCode)c.flagCode=p.flagCode;
  if(!c.iso3&&p.iso3)c.iso3=p.iso3;
}
const summary={
  tournament:data.tournament||{},
  refreshedAt:data.refreshedAt||null,
  squashLevelsRefreshedAt:data.squashLevelsRefreshedAt||null,
  playerCount:data.players.length,
  matchCount:data.matches.length,
  countries:[...countries.values()].sort((a,b)=>b.count-a.count||a.country.localeCompare(b.country)),
  ageGroups:[...new Set(data.players.map(p=>p.ageGroup).filter(x=>x!==null&&x!==undefined&&String(x)!==''))].sort((a,b)=>Number(a)-Number(b))
};
const trackedFile=path.join(DIR,'vic-park-players.js');
let trackedNames=[];
if(fs.existsSync(trackedFile)){
  try{const tctx={window:{}};vm.createContext(tctx);vm.runInContext(fs.readFileSync(trackedFile,'utf8'),tctx);trackedNames=Array.isArray(tctx.window.VIC_PARK_PLAYERS)?tctx.window.VIC_PARK_PLAYERS:[];}catch{}
}
const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
const norm=s=>clean(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[’‘]/g,"'").toLowerCase();
const nameKey=s=>{let v=clean(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[’‘]/g,"'");if(v.includes(',')){const a=v.split(',').map(x=>x.trim()).filter(Boolean);if(a.length===2)v=a[1]+' '+a[0];}return v.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/).filter(Boolean).sort().join(' ')};
const sameName=(a,b)=>!!a&&!!b&&(norm(a)===norm(b)||nameKey(a)===nameKey(b));
const trackedPlayers=data.players.filter(p=>trackedNames.some(n=>sameName(p.name,n)));
const trackedIds=new Set(trackedPlayers.map(p=>String(p.officialPlayerId||'')).filter(Boolean));
const vicMatches=data.matches.filter(m=>trackedNames.some(n=>sameName(m.player1,n)||sameName(m.player2,n))||(m.player1Id&&trackedIds.has(String(m.player1Id)))||(m.player2Id&&trackedIds.has(String(m.player2Id))));
const participantNames=new Set(),participantIds=new Set();
for(const m of vicMatches){if(m.player1)participantNames.add(nameKey(m.player1));if(m.player2)participantNames.add(nameKey(m.player2));if(m.player1Id)participantIds.add(String(m.player1Id));if(m.player2Id)participantIds.add(String(m.player2Id));}
const vicPlayers=data.players.filter(p=>participantIds.has(String(p.officialPlayerId||''))||participantNames.has(nameKey(p.name))||trackedNames.some(n=>sameName(p.name,n)));
const vicParkData={players:vicPlayers,matches:vicMatches};
fs.writeFileSync(path.join(DIR,'summary-data.js'),`window.TOURNAMENT_SUMMARY = ${JSON.stringify(summary)};\n`);
fs.writeFileSync(path.join(DIR,'players-data.js'),`window.TOURNAMENT_PLAYERS = ${JSON.stringify(data.players)};\n`);
fs.writeFileSync(path.join(DIR,'matches-data.js'),`window.TOURNAMENT_MATCHES = ${JSON.stringify(data.matches)};\n`);
fs.writeFileSync(path.join(DIR,'vicpark-data.js'),`window.VIC_PARK_DATA = ${JSON.stringify(vicParkData)};\n`);
fs.writeFileSync(path.join(DIR,'vicpark-data.js'),`window.VIC_PARK_DATA = ${JSON.stringify(vicParkData)};\n`);
console.log(`Split complete: ${data.players.length} players, ${data.matches.length} matches, ${summary.countries.length} countries.`);
console.log(`Generated summary-data.js, players-data.js, matches-data.js and vicpark-data.js (${vicPlayers.length} relevant players, ${vicMatches.length} Vic Park matches).`);
