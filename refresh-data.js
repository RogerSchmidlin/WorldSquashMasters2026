/*
  World Squash Masters 2026 TournamentSoftware refresher - reliable separated-data edition
  ------------------------------------------------------------
  Strategy:
  1. Load the official Players page and collect the official player profile links.
  2. Visit every player profile and collect that player's scheduled / played matches.
  3. Dedupe the same match seen from both players into one master match list.
  4. Publish when player-profile coverage is plausible; do not require 500 confirmed pairings because later-round TBD slots are not player-profile matches.

  This avoids relying on the global Matches page pagination, which TournamentSoftware
  currently exposes as only a small slice to automation in some browser sessions.
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { chromium } = require('playwright');

const DIR = __dirname;
const CONFIG_FILE = path.join(DIR,'config.json');
function loadLocalConfig(){
  try{return fs.existsSync(CONFIG_FILE)?JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8')):{};}catch(e){console.log(`Warning: could not read config.json: ${e.message}`);return {};}
}
const LOCAL_CONFIG=loadLocalConfig();
const SQUASHLEVELS_EMAIL=process.env.SQUASHLEVELS_EMAIL||LOCAL_CONFIG?.squashLevels?.email||'';
const SQUASHLEVELS_PASSWORD=process.env.SQUASHLEVELS_PASSWORD||LOCAL_CONFIG?.squashLevels?.password||'';
const SQUASHLEVELS_LOGIN_URL=LOCAL_CONFIG?.squashLevels?.loginUrl||'https://app.squashlevels.com/login';
const ID = '1d88743a-54e2-4073-bd30-a4f443a442f0';
const ORIGIN = 'https://wsf.tournamentsoftware.com';
const PLAYERS_URL = `${ORIGIN}/tournament/${ID}/Players`;
const DRAWS_URL = `${ORIGIN}/sport/draws.aspx?id=${ID}`;
const MATCHES_URL = `${ORIGIN}/tournament/${ID}/Matches`;
const SQUASH_SCORES_API_URL = 'https://squashscores.com/api/overview/public/?categoryId=19';
const MIN_MATCHES = 350; // confirmed player-v-player matches; later-round TBD slots are not on player profiles
const MIN_RAW_OBSERVATIONS = 850;
const CONCURRENCY = Math.max(1, Number(process.env.CRAWL_WORKERS || 6));
const SQUASHLEVELS_METRIC_WORKERS = Math.max(1, Number(process.env.SQUASHLEVELS_WORKERS || 4));
const NAV_TIMEOUT = 60000;
const PROFILE_WAIT = Number(process.env.PROFILE_WAIT_MS || 350);
const FULL_REBUILD = process.argv.includes(':full');
const NORMAL_PROFILE_CRAWL = FULL_REBUILD || process.argv.includes(':profiles') || process.env.CRAWL_PROFILES==='1';
const MATCHES_ONLY = process.argv.includes(':matches');
const DRAW_DEBUG = process.argv.includes(':drawdebug');
const SQUASHLEVELS_ONLY = process.argv.includes(':squashlevels');
const SQUASHLEVELS_LOGIN_SETUP = process.argv.includes(':squashlevels-login');
const SQUASHLEVELS_PLAYER_ONLY = (()=>{
  if(!SQUASHLEVELS_ONLY)return '';
  const modeArgs=new Set([':full',':matches',':drawdebug',':squashlevels',':squashlevels-login']);
  const extra=process.argv.slice(2).filter(x=>!modeArgs.has(x));
  return String(extra.join(' ')||'').replace(/\s+/g,' ').trim();
})();
const SQUASHLEVELS_STORAGE_FILE = path.join(DIR,'squashlevels-storage-state.json');
const SQUASHLEVELS_SESSION_FILE = path.join(DIR,'squashlevels-session-storage.json');
const SQUASHLEVELS_STORAGE_B64_FILE = path.join(DIR,'squashlevels-storage-state.b64.txt');
const SQUASHLEVELS_SESSION_B64_FILE = path.join(DIR,'squashlevels-session-storage.b64.txt');
if([FULL_REBUILD,MATCHES_ONLY,DRAW_DEBUG,SQUASHLEVELS_ONLY,SQUASHLEVELS_LOGIN_SETUP].filter(Boolean).length>1){
  throw new Error('Use only one of :full, :matches, :drawdebug, :squashlevels or :squashlevels-login.');
}

const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
function formatDuration(ms){
  const total=Math.max(0,Math.round(Number(ms)||0));
  const s=Math.floor(total/1000), m=Math.floor(s/60), h=Math.floor(m/60);
  const ss=s%60, mm=m%60;
  if(h)return `${h}h ${mm}m ${ss}s`;
  if(m)return `${m}m ${ss}s`;
  return `${Math.max(0,s)}s`;
}
function phaseTimer(label){
  const started=Date.now();
  return ()=>{const elapsed=Date.now()-started;console.log(`TIMING ${label}: ${formatDuration(elapsed)}`);return elapsed;};
}
async function waitForSquashLevelsProfileReady(page,maxMs=700){
  const initial=Math.min(120,maxMs);
  if(initial>0)await page.waitForTimeout(initial);
  const remaining=Math.max(0,maxMs-initial);
  if(!remaining)return;
  try{
    await page.waitForFunction(()=>{
      const t=String(document.body?.innerText||'');
      return /Possible\s+Duplicates|World\s+ranking|\bLEVEL\b|Last\s+match/i.test(t);
    },{timeout:remaining});
  }catch{}
}
async function installSessionStorageClone(sourcePage,targetPage){
  if(!sourcePage||!targetPage||sourcePage===targetPage)return;
  let entries=[];
  try{entries=await sourcePage.evaluate(()=>Object.entries(sessionStorage));}catch{}
  if(!entries.length)return;
  await targetPage.addInitScript(items=>{
    try{for(const [k,v] of items)sessionStorage.setItem(k,v);}catch{}
  },entries);
}

const norm = s => clean(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[’‘]/g,"'").toLowerCase();
const nameKey = s => {
  let v=clean(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .replace(/[’‘]/g,"'")
    // TournamentSoftware appends seeds such as [1], [5/8], [17/32].
    // They are display metadata, not part of player identity.
    .replace(/\[[^\]]*\]/g,' ')
    .replace(/\((?:[A-Z]{2,3}|\d+)\)/g,' ');

  if(v.includes(',')){
    const a=v.split(',').map(x=>x.trim()).filter(Boolean);
    if(a.length===2)v=a[1]+' '+a[0];
  }

  return v.toLowerCase()
    .replace(/\b(?:aus|eng|sco|wal|sui|nzl|usa|can|fra|ger|deu|irl|rsa|ind|jpn|mas|sgp|hkg)\b/g,' ')
    .replace(/[^a-z0-9]+/g,' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
};
const sameName=(a,b)=>!!a&&!!b&&(norm(a)===norm(b)||nameKey(a)===nameKey(b));
function splitPlayerSeed(value){
  const raw=clean(value||'');
  const m=raw.match(/\s*\[([^\]]+)\]\s*$/);
  return {
    name:clean(raw.replace(/\s*\[[^\]]+\]\s*$/,'')),
    seed:m?clean(m[1]):''
  };
}
function normalizePlayerIdentityRecord(p){
  if(!p)return p;
  const x=splitPlayerSeed(p.name);
  return {...p,name:x.name||clean(p.name||''),seed:clean(p.seed||x.seed||'')};
}

function repairDuplicateSquashLevelsIdentity(players){
  const out=(players||[]).map(p=>({...p}));
  const groups=new Map();

  for(const p of out){
    const k=nameKey(p.name);
    if(!groups.has(k))groups.set(k,[]);
    groups.get(k).push(p);
  }

  const slFields=[
    'squashLevelsPlayerId','squashLevelsUrl','squashLevelsIdentityVerified',
    'squashLevelsIdentityVerifiedAt','squashLevelsMatchedCountry',
    'squashLevelsMatchedAge','squashLevelsSearchCheckedAt',
    'squashLevelsProfileCheckedAt','squashLevelsWorldRank',
    'squashLevelsLevel','squashLevelsLevelProvisional'
  ];

  const tournamentAge=p=>{
    const m=String(p?.ageGroup??'').match(/\b(35|40|45|50|55|60|65|70|75|80|85)\b/);
    return m?Number(m[1]):null;
  };

  const matchedAge=p=>{
    const n=Number(p?.squashLevelsMatchedAge);
    return Number.isFinite(n)&&n>0?n:null;
  };

  let cleared=0;

  for(const p of out){
    const ta=tournamentAge(p);
    const sa=matchedAge(p);
    const expectedCountries=squashLevelsExpectedCountryCodes(p);
    const sc=clean(p?.squashLevelsMatchedCountry||'').toUpperCase();
    const duplicate=(groups.get(nameKey(p.name))||[]).length>1;

    const hadMapping=!!(
      p.squashLevelsUrl||
      p.squashLevelsPlayerId||
      p.squashLevelsLevel||
      p.squashLevelsWorldRank
    );
    if(!hadMapping)continue;

    const explicitAgeMismatch=ta!==null&&sa!==null&&ta!==sa;
    const explicitCountryMismatch=!!(
      sc&&expectedCountries.length&&!expectedCountries.includes(sc)
    );

    // For duplicate TournamentSoftware names, retained identity requires positive
    // age evidence. For every player, any explicit age/country contradiction is
    // enough to invalidate the cached SquashLevels profile.
    const duplicateMissingAge=duplicate&&ta!==null&&sa===null;

    if(explicitAgeMismatch||explicitCountryMismatch||duplicateMissingAge){
      console.warn(
        `Removed invalid SquashLevels mapping: ${p.name} ` +
        `TS age=${ta??'?'}+ country=${expectedCountries.join('/')||'?'}; ` +
        `SL age=${sa??'unknown'} country=${sc||'unknown'}.`
      );
      for(const k of slFields)delete p[k];
      p.squashLevelsIdentityVerified=false;
      p.squashLevelsSearchCheckedAt=null;
      cleared++;
    }
  }

  if(cleared){
    console.log(`SquashLevels identity guard cleared ${cleared} invalid mapping(s).`);
  }

  return out;
}

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function hrefKey(href){
  try{
    const u=new URL(href,ORIGIN);
    const tournamentId=String(ID).toLowerCase();
    const parts=u.pathname.split('/').map(x=>decodeURIComponent(x)).filter(Boolean);
    const lower=parts.map(x=>x.toLowerCase());

    // Prefer an explicit player/participant/person identifier from the query string.
    // Never use the tournament UUID itself as a player ID.
    const preferred=['playerid','player','participantid','participant','personid','person','profileid','profile'];
    for(const wanted of preferred){
      for(const [k,v0] of u.searchParams.entries()){
        const v=clean(v0);
        if(k.toLowerCase()===wanted&&v&&v.toLowerCase()!==tournamentId)return `q:${wanted}:${v.toLowerCase()}`;
      }
    }
    for(const [k,v0] of u.searchParams.entries()){
      const v=clean(v0);
      if(v&&v.toLowerCase()!==tournamentId&&/^[0-9a-z_-]{3,}$/i.test(v))return `q:${k.toLowerCase()}:${v.toLowerCase()}`;
    }

    // Modern TournamentSoftware URLs commonly put the player-specific token after
    // /player/, /participant/, /person/ or /profile/. Use that token if present.
    for(let i=0;i<lower.length-1;i++){
      if(/^(?:player|participant|person|profile|player-profile|participant-profile)$/.test(lower[i])){
        const v=parts[i+1];
        if(v&&v.toLowerCase()!==tournamentId)return `p:${v.toLowerCase()}`;
      }
    }

    // Last-resort path identity: remove the tournament UUID and static route words.
    // This remains stable and unique even when TournamentSoftware doesn't expose a
    // simple numeric/GUID player id in the URL.
    const staticParts=new Set(['tournament','players','player','participant','person','profile','player-profile','participant-profile']);
    const meaningful=parts.filter(x=>x.toLowerCase()!==tournamentId&&!staticParts.has(x.toLowerCase()));
    if(meaningful.length)return `path:${meaningful.join('/').toLowerCase()}`;

    // Include non-tournament query parameters in the absolute fallback so two distinct
    // profile URLs can never collapse merely because they share the tournament path.
    const qp=[...u.searchParams.entries()]
      .filter(([,v])=>String(v).toLowerCase()!==tournamentId)
      .sort((a,b)=>a[0].localeCompare(b[0]))
      .map(([k,v])=>`${k.toLowerCase()}=${String(v).toLowerCase()}`)
      .join('&');
    return `url:${u.pathname.toLowerCase()}${qp?'?'+qp:''}`;
  }catch{return `raw:${clean(href).toLowerCase()}`}
}

function evalWindowFile(fileName){
  const fp=path.join(DIR,fileName);
  if(!fs.existsSync(fp))return {};
  const ctx={window:{}}; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(fp,'utf8'),ctx);
  return ctx.window;
}

function loadExisting(){
  const legacy=evalWindowFile('data.js').TOURNAMENT_DATA||null;

  const summary=evalWindowFile('summary-data.js').TOURNAMENT_SUMMARY||{};
  const splitPlayers=evalWindowFile('players-data.js').TOURNAMENT_PLAYERS||[];
  const splitMatches=evalWindowFile('matches-data.js').TOURNAMENT_MATCHES||[];
  const split=splitPlayers.length?{...summary,players:splitPlayers,matches:splitMatches}:null;

  const candidates=[
    legacy&&{
      label:'data.js',
      data:legacy,
      players:Array.isArray(legacy.players)?legacy.players.length:0,
      matches:Array.isArray(legacy.matches)?legacy.matches.length:0
    },
    split&&{
      label:'split data files',
      data:split,
      players:splitPlayers.length,
      matches:splitMatches.length
    }
  ].filter(Boolean);

  if(!candidates.length){
    throw new Error(
      'No tournament dataset found. Expected data.js or the split summary/players/matches data files.'
    );
  }

  console.log(
    `Existing dataset candidates: ${candidates.map(x=>
      `${x.label}=${x.players} players/${x.matches} matches`
    ).join(' | ')}`
  );

  // Prefer the dataset with the richest match history. Player count is only
  // the tie-breaker. data.js is legacy compatibility data and must not
  // automatically override a newer/richer matches-data.js snapshot.
  candidates.sort((a,b)=>
    b.matches-a.matches ||
    b.players-a.players ||
    (b.label==='split data files'?1:-1)
  );

  const selected=candidates[0];
  console.log(
    `Existing dataset selected: ${selected.label} ` +
    `(${selected.players} players/${selected.matches} matches).`
  );

  return selected.data;
}

function buildSummaryData(data){
  const byCountry=new Map();
  for(const p of (data.players||[])){
    const key=clean(p.country)||'Unknown';
    if(!byCountry.has(key))byCountry.set(key,{country:key,count:0,flagCode:p.flagCode||'',iso3:p.iso3||''});
    const x=byCountry.get(key);x.count++;
    if(!x.flagCode&&p.flagCode)x.flagCode=p.flagCode;
    if(!x.iso3&&p.iso3)x.iso3=p.iso3;
  }
  return {
    tournament:data.tournament||{},
    refreshedAt:data.refreshedAt||null,
    squashLevelsRefreshedAt:data.squashLevelsRefreshedAt||null,
    playerCount:(data.players||[]).length,
    matchCount:(data.matches||[]).length,
    countries:[...byCountry.values()].sort((a,b)=>b.count-a.count||a.country.localeCompare(b.country)),
    ageGroups:[...new Set((data.players||[]).map(p=>p.ageGroup).filter(x=>x!==null&&x!==undefined&&String(x)!==''))].sort((a,b)=>Number(a)-Number(b))
  };
}

function buildVicParkData(data){
  const trackedNames=loadTrackedNames();
  const allPlayers=data.players||[];
  const trackedPlayers=allPlayers.filter(p=>trackedNames.some(n=>sameName(p.name,n)));
  const trackedIds=new Set(trackedPlayers.map(p=>String(p.officialPlayerId||'')).filter(Boolean));
  const matches=(data.matches||[]).filter(m=>{
    if(trackedNames.some(n=>sameName(m.player1,n)||sameName(m.player2,n)))return true;
    return (m.player1Id&&trackedIds.has(String(m.player1Id)))||(m.player2Id&&trackedIds.has(String(m.player2Id)));
  });
  const participantNames=new Set(),participantIds=new Set();
  for(const m of matches){
    if(m.player1)participantNames.add(nameKey(m.player1));
    if(m.player2)participantNames.add(nameKey(m.player2));
    if(m.player1Id)participantIds.add(String(m.player1Id));
    if(m.player2Id)participantIds.add(String(m.player2Id));
  }
  const players=allPlayers.filter(p=>participantIds.has(String(p.officialPlayerId||''))||participantNames.has(nameKey(p.name))||trackedNames.some(n=>sameName(p.name,n)));
  return {players,matches};
}

function writeDataFiles(data){
  const summary=buildSummaryData(data);
  const vicPark=buildVicParkData(data);
  // Keep data.js for backwards compatibility and local tooling, but the website no longer
  // downloads it on first load. The split files are what the browser uses.
  fs.writeFileSync(path.join(DIR,'data.js'),`window.TOURNAMENT_DATA = ${JSON.stringify(data,null,2)};\n`);
  fs.writeFileSync(path.join(DIR,'summary-data.js'),`window.TOURNAMENT_SUMMARY = ${JSON.stringify(summary)};\n`);
  fs.writeFileSync(path.join(DIR,'players-data.js'),`window.TOURNAMENT_PLAYERS = ${JSON.stringify(data.players||[])};\n`);
  fs.writeFileSync(path.join(DIR,'matches-data.js'),`window.TOURNAMENT_MATCHES = ${JSON.stringify(data.matches||[])};\n`);
  fs.writeFileSync(path.join(DIR,'vicpark-data.js'),`window.VIC_PARK_DATA = ${JSON.stringify(vicPark)};\n`);
}

function loadTrackedNames(){
  const fp=path.join(DIR,'vic-park-players.js');
  if(!fs.existsSync(fp)) return [];
  try{
    const ctx={window:{}}; vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(fp,'utf8'),ctx);
    return Array.isArray(ctx.window.VIC_PARK_PLAYERS)?ctx.window.VIC_PARK_PLAYERS.map(clean).filter(Boolean):[];
  }catch(e){ console.warn('Could not read vic-park-players.js:',e.message); return []; }
}

function loadCachedPlayerLinks(canonicalPlayers){
  if(FULL_REBUILD) return [];
  const fp=path.join(DIR,'player-links.json');
  if(!fs.existsSync(fp)) return [];
  try{
    const rows=JSON.parse(fs.readFileSync(fp,'utf8'));
    if(!Array.isArray(rows)) return [];
    const names=new Set(canonicalPlayers.map(p=>nameKey(p.name)));
    const good=rows.filter(x=>x&&x.name&&x.href&&names.has(nameKey(x.name))&&/^https?:\/\//i.test(x.href)).map(x=>({...x,officialPlayerId:hrefKey(x.href)}));
    return good.length>=850?good:[];
  }catch{return []}
}

const TOURNAMENT_START_DATE='2026-08-30';
const TOURNAMENT_END_DATE='2026-09-06';
function isTournamentDate(iso){
  return /^\d{4}-\d{2}-\d{2}$/.test(String(iso||'')) &&
    iso>=TOURNAMENT_START_DATE && iso<=TOURNAMENT_END_DATE;
}
function parseDate(s){
  s=clean(s);
  const found=[];

  const add=(year,month,day)=>{
    const y=Number(year),m=Number(month),d=Number(day);
    if(y!==2026||m<1||m>12||d<1||d>31)return;
    const iso=`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    if(isTournamentDate(iso)&&!found.includes(iso))found.push(iso);
  };

  // Scan ALL numeric dates instead of returning the first date-like value.
  // Profile pages can contain unrelated dates (membership/history/etc.) before
  // the actual scheduled match date.
  for(const m of s.matchAll(/\b(2026)[-\/.](\d{1,2})[-\/.](\d{1,2})\b/g)){
    // ISO-ish yyyy/mm/dd.
    add(m[1],m[2],m[3]);
  }

  for(const m of s.matchAll(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](2026)\b/g)){
    // TournamentSoftware can emit numeric dates in US month/day/year form.
    // Try BOTH interpretations and let isTournamentDate() keep only the one
    // that falls inside 30 Aug–6 Sep 2026.
    //
    // Examples:
    //   8/30/2026 -> MDY -> 2026-08-30
    //   9/1/2026  -> MDY -> 2026-09-01
    //   30/8/2026 -> DMY -> 2026-08-30
    add(m[3],m[2],m[1]); // DD/MM/YYYY
    add(m[3],m[1],m[2]); // MM/DD/YYYY
  }

  const monthNo=v=>/^sep/i.test(v)?9:8;
  for(const m of s.matchAll(/\b(\d{1,2})\s+(Aug(?:ust)?|Sep(?:tember)?)\s*(?:2026)?\b/gi))add(2026,monthNo(m[2]),m[1]);
  for(const m of s.matchAll(/\b(Aug(?:ust)?|Sep(?:tember)?)\s+(\d{1,2})(?:,?\s*2026)?\b/gi))add(2026,monthNo(m[1]),m[2]);

  // TournamentSoftware also renders date headings as "Sun 30", "Mon 31",
  // "Tue 1", etc. The championship window makes these unambiguous:
  // 30/31 = August, 1..6 = September.
  const weekdayIndex={sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6};
  for(const m of s.matchAll(/\b(Sun(?:day)?|Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?)\s*,?\s*(\d{1,2})\b/gi)){
    const day=Number(m[2]);
    const month=day>=30?8:(day>=1&&day<=6?9:0);
    if(!month)continue;

    // Extra safety: make sure weekday + date is actually one of the
    // championship dates before accepting it.
    const iso=`2026-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const dt=new Date(`${iso}T12:00:00Z`);
    const expected=weekdayIndex[String(m[1]).slice(0,3).toLowerCase()];
    if(isTournamentDate(iso)&&dt.getUTCDay()===expected&&!found.includes(iso))found.push(iso);
  }

  return found[0]||'';
}
function parseTime(s){const m=clean(s).match(/\b(\d{1,2}):([0-5]\d)\s*(am|pm)?\b/i);return m?clean(m[0]):''}

function parseMatchScore(text){
  const s=clean(text).replace(/[–—]/g,'-');

  // Standard score form.
  const pair=/\d{1,2}\s*-\s*\d{1,2}/g;
  const run=s.match(/\b\d{1,2}\s*-\s*\d{1,2}(?:(?:\s*,\s*|\s*;\s*|\s+)\d{1,2}\s*-\s*\d{1,2}){2,4}\b/);
  if(run){
    return [...run[0].matchAll(pair)]
      .map(x=>x[0].replace(/\s+/g,''))
      .join(', ');
  }

  const validGame=(a,b)=>{
    if(!Number.isInteger(a)||!Number.isInteger(b)||a<0||b<0||a>30||b>30||a===b)return false;
    const hi=Math.max(a,b),lo=Math.min(a,b);
    return hi>=11 && (hi===11 ? lo<=9 : hi-lo===2);
  };

  // TournamentSoftware LIST VIEW renders each game score in separate cells:
  // "Richard Chin [1] W Kyle Walsh 11 5 11 5 11 3"
  // H2H may already have been stripped by the outer block parser, so accept
  // a numeric run at the end of the block OR immediately before H2H.
  const spaced=s.match(/((?:\d{1,2}\s+){5,9}\d{1,2})(?:\s+H2H)?\s*$/i);
  if(spaced){
    const nums=(spaced[1].match(/\d{1,2}/g)||[]).map(Number);

    if(nums.length>=6&&nums.length<=10&&nums.length%2===0){
      const games=[];
      let ok=true;

      for(let i=0;i<nums.length;i+=2){
        if(!validGame(nums[i],nums[i+1])){ok=false;break}
        games.push(`${nums[i]}-${nums[i+1]}`);
      }

      if(ok&&games.length>=3&&games.length<=5)return games.join(', ');
    }
  }

  // Walkover/result states do not have game scores.
  if(/\b(?:walkover|w\/o)\b/i.test(s))return 'Walkover';
  if(/\b(?:retired|ret\.?)\b/i.test(s))return 'Retired';

  return '';
}


function parseOfficialVenueCourt(text){
  const s=clean(text);

  const patterns=[
    {
      venue:'Squashworld Mirrabooka',
      rx:/\bSquashworld\s+Mirrabooka\s*[-–—·]\s*(SC\s*\d+|Court\s*\d+|AGC(?:\s*\d+)?)\b/i
    },
    {
      venue:'Belmont Saints Squash Centre',
      rx:/\bBelmont\s+Saints\s+Squash\s+Centre\s*[-–—·]\s*(SC\s*\d+|Court\s*\d+|AGC(?:\s*\d+)?)\b/i
    },
    {
      venue:'Karrinyup Shopping Centre',
      rx:/\bKarrinyup\s+Shopping\s+Centre\s*[-–—·]\s*(SC\s*\d+|Court\s*\d+|AGC(?:\s*\d+)?)\b/i
    }
  ];

  for(const p of patterns){
    const m=s.match(p.rx);
    if(m){
      return {
        venue:p.venue,
        court:clean(m[1]).replace(/\s+/g,' ')
      };
    }
  }

  // Venue can still be useful even when the court is not present.
  if(/\bKarrinyup(?:\s+Shopping\s+Centre)?\b/i.test(s))
    return {venue:'Karrinyup Shopping Centre',court:''};
  if(/\b(?:Squashworld\s+)?Mirrabooka\b/i.test(s))
    return {venue:'Squashworld Mirrabooka',court:''};
  if(/\bBelmont(?:\s+Saints)?(?:\s+Squash\s+Centre)?\b/i.test(s))
    return {venue:'Belmont Saints Squash Centre',court:''};

  return {venue:'',court:''};
}

function deriveFields(text, fallbackEvent=''){
  text=clean(text);
  const event=(text.match(/(?:Men(?:'s)?|Women(?:'s)?)\s*(?:Over\s*)?(?:35|40|45|50|55|60|65|70|75|80|85)\+?/i)||[])[0]||fallbackEvent;
  const round=(text.match(/\b(?:Final|Semi[- ]?final|Quarter[- ]?final|Round\s+of\s+\d+|Round\s+\d+|Plate(?:\s+Final)?|Playoff|Position\s+\d+(?:-|–)\d+)\b/i)||[])[0]||'';
  const vc=parseOfficialVenueCourt(text);
  const venue=vc.venue;
  const court=vc.court;
  const score=parseMatchScore(text);
  const completed=Boolean(score)||/\b(?:walkover|w\/o|retired|ret\.?|withdrawn|defaulted)\b/i.test(text);
  return {date:parseDate(text),time:parseTime(text),event:clean(event),round:clean(round),venue,court:clean(court),result:score,status:completed?'completed':'scheduled'};
}

async function launchBrowser(headlessOverride=null){
  const requested=process.env.BROWSER_CHANNEL;
  const channels=requested?[requested]:['chrome','msedge',null];
  let last;
  for(const channel of channels){
    try{
      const explicitHeadless = String(process.env.HEADLESS || '').trim();
      const githubActions = String(process.env.GITHUB_ACTIONS || '').toLowerCase() === 'true';
      const linuxWithoutDisplay = process.platform === 'linux' && !String(process.env.DISPLAY || '').trim();
      // GitHub-hosted runners and other Linux CI environments normally have no X server.
      // Force headless whenever Linux has no DISPLAY, even if an older workflow says HEADLESS=0.
      const configuredHeadless = explicitHeadless === '1' ? true : explicitHeadless === '0' ? false : false;
      const effectiveHeadless = (githubActions || linuxWithoutDisplay)
        ? true
        : (headlessOverride===null ? configuredHeadless : !!headlessOverride);
      console.log(`Browser launch: headless=${effectiveHeadless} platform=${process.platform} GITHUB_ACTIONS=${process.env.GITHUB_ACTIONS || ''} DISPLAY=${process.env.DISPLAY || ''}`);
      const opts={headless:effectiveHeadless}; if(channel)opts.channel=channel;
      const b=await chromium.launch(opts);
      console.log(`Browser: ${channel||'Playwright Chromium'}`); return b;
    }catch(e){last=e;console.log(`Could not launch ${channel||'Playwright Chromium'}: ${e.message.split('\n')[0]}`)}
  }
  throw last;
}

async function safeGoto(page,url,tries=4){
  let last;
  for(let i=1;i<=tries;i++){
    try{
      await page.goto(url,{waitUntil:'domcontentloaded',timeout:NAV_TIMEOUT});
      await sleep(600); return;
    }catch(e){last=e;console.log(`  navigation retry ${i}/${tries}: ${e.message.split('\n')[0]}`);await sleep(1200*i)}
  }
  throw last;
}

async function gotoTournamentSoftware(page,url,tries=4){
  let last;

  const pageState=async()=>{
    try{
      const current=String(page.url()||'');
      const body=await Promise.race([
        page.locator('body').innerText().catch(()=>''),
        new Promise(r=>setTimeout(()=>r(''),2500))
      ]);
      return {current,body:clean(body)};
    }catch{
      return {current:String(page.url()||''),body:''};
    }
  };

  const waitForRenderedBody=async(maxMs=12000)=>{
    const started=Date.now();
    let lastState={current:String(page.url()||''),body:''};
    while(Date.now()-started<maxMs){
      lastState=await pageState();
      if(/tournamentsoftware\.com/i.test(lastState.current)&&lastState.body.length>100){
        return lastState;
      }
      await sleep(500);
    }
    return lastState;
  };

  for(let i=1;i<=tries;i++){
    try{
      console.log(`  TournamentSoftware navigation ${i}/${tries}: ${url}`);
      await page.goto(url,{waitUntil:'commit',timeout:15000});

      const rendered=await waitForRenderedBody(12000);
      if(/tournamentsoftware\.com/i.test(rendered.current)&&rendered.body.length>100){
        console.log(`  TournamentSoftware page ready: ${rendered.current} (${rendered.body.length} rendered characters).`);
        return;
      }

      throw new Error(`navigation committed but TournamentSoftware body was not usable (url=${rendered.current||'(blank)'}, chars=${rendered.body.length})`);
    }catch(e){
      last=e;
      const msg=String(e?.message||e).split('\n')[0];
      console.log(`  TournamentSoftware navigation retry ${i}/${tries}: ${msg}`);

      if(/ERR_ABORTED/i.test(msg)){
        const rendered=await waitForRenderedBody(12000);
        if(/tournamentsoftware\.com/i.test(rendered.current)&&rendered.body.length>100){
          console.log(`  ERR_ABORTED but TournamentSoftware content rendered successfully (${rendered.body.length} characters); continuing.`);
          return;
        }
      }

      if(i<tries){
        try{await page.goto('about:blank',{waitUntil:'commit',timeout:5000});}catch{}
        await sleep(700*i);
      }
    }
  }

  throw last||new Error(`Could not open TournamentSoftware page: ${url}`);
}

async function dismissPopups(page){
  for(const rx of [/accept/i,/agree/i,/allow all/i,/got it/i]){try{const b=page.getByRole('button',{name:rx}).first();if(await b.count()&&await b.isVisible())await b.click({timeout:800})}catch{}}
}

async function collectOfficialPlayerLinks(page, canonicalPlayers){
  await safeGoto(page,PLAYERS_URL); await dismissPopups(page); await sleep(1500);
  // Force lazy player directory to expose every link.
  for(let i=0;i<30;i++){try{const old=await page.evaluate(()=>document.documentElement.scrollHeight);await page.evaluate(()=>window.scrollTo(0,document.documentElement?.scrollHeight||document.body?.scrollHeight||0));await sleep(250);const now=await page.evaluate(()=>document.documentElement.scrollHeight);if(now===old&&i>4)break}catch{break}}
  const raw=await page.evaluate(()=>[...document.querySelectorAll('a[href]')].map(a=>({text:(a.innerText||'').replace(/\s+/g,' ').trim(),href:a.href})).filter(x=>x.text&&/player|participant|person|profile/i.test(x.href)));
  const canonicalByKey=new Map(canonicalPlayers.map(p=>[nameKey(p.name),p]));
  const canonicalById=new Map(canonicalPlayers.filter(p=>p.officialPlayerId).map(p=>[String(p.officialPlayerId),p]));
  const byHref=new Map();
  let renamed=0, added=0;
  for(const x of raw){
    let href=x.href.split('#')[0]; if(!href.startsWith('http'))continue;
    const officialPlayerId=hrefKey(href);
    // On a full rebuild, ID is authoritative. This lets a player survive an official name change.
    let p=canonicalById.get(String(officialPlayerId))||canonicalByKey.get(nameKey(x.text));
    if(!p&&FULL_REBUILD){
      // New official player. Keep a conservative minimal record; age/gender are filled from
      // that player's own schedule/event text as it is crawled below.
      const parsedName=splitPlayerSeed(x.text); const nm=parsedName.name;
      if(nm.length<3||nm.length>90||!/[A-Za-z]/.test(nm))continue;
      p={name:nm,gender:'',ageGroup:'',country:'',iso3:'',flagCode:'',officialPlayerId,officialProfileUrl:href};
      canonicalPlayers.push(p);canonicalByKey.set(nameKey(nm),p);canonicalById.set(String(officialPlayerId),p);added++;
    }
    if(!p)continue;
    if(FULL_REBUILD&&p.name!==clean(x.text)&&canonicalById.get(String(officialPlayerId))===p){
      console.log(`  Official name change: ${p.name} -> ${clean(x.text)}`);
      p.name=parsedName.name;p.seed=parsedName.seed||p.seed||'';renamed++;
    }
    p.officialPlayerId=officialPlayerId;p.officialProfileUrl=href;
    if(!byHref.has(href))byHref.set(href,{name:p.name,href,officialPlayerId,country:p.country,gender:p.gender,ageGroup:p.ageGroup});
  }
  if(FULL_REBUILD)console.log(`Full rebuild directory reconciliation: ${renamed} renamed player(s), ${added} newly discovered player(s).`);
  return [...byHref.values()];
}


async function scrapeOfficialMatchesSchedule(context,canonicalPlayers,previousMatches=[]){
  const byNameGroups=new Map();
  for(const p of canonicalPlayers){
    const k=nameKey(p.name);
    if(!byNameGroups.has(k))byNameGroups.set(k,[]);
    byNameGroups.get(k).push(p);
  }

  const knownNameRows=canonicalPlayers
    .map(p=>{
      const visible=clean(String(p.name||'').replace(/\s*\[[^\]]+\]\s*$/,''));
      return {
        name:p.name,
        visible,
        lower:visible.toLowerCase()
      };
    })
    .filter(x=>x.visible.length>=4)
    .sort((a,b)=>b.visible.length-a.visible.length);

  const resolveName=(name,eventText='')=>{
    const rows=byNameGroups.get(nameKey(name))||[];
    if(rows.length===1)return rows[0];

    if(rows.length>1){
      const age=(String(eventText).match(/\b(35|40|45|50|55|60|65|70|75|80|85)\+?\b/)||[])[1]||'';
      const gender=/women/i.test(eventText)?'Women':(/\bmen/i.test(eventText)?'Men':'');
      let pool=rows;

      if(age){
        const x=pool.filter(p=>String(p.ageGroup??'')===String(age));
        if(x.length)pool=x;
      }
      if(gender){
        const x=pool.filter(p=>String(p.gender||'')===gender);
        if(x.length)pool=x;
      }
      if(pool.length===1)return pool[0];
    }

    return null;
  };


  const previousRows=Array.isArray(previousMatches)?previousMatches:[];

  const officialIdentity=p=>String(p?.officialPlayerId||'');
  const samePlayer=(mSideName,mSideId,p)=>{
    if(!p)return false;
    const pid=officialIdentity(p);
    if(pid&&String(mSideId||'')===pid)return true;
    return nameKey(mSideName)===nameKey(p.name);
  };

  function recoverPreviousOpponent(date,time,knownPlayer,eventText=''){
    if(!knownPlayer)return null;

    const candidates=[];
    for(const m of previousRows){
      if(canonicalTournamentDate(m.date)!==canonicalTournamentDate(date))continue;
      if(clean(m.time||'').toLowerCase()!==clean(time||'').toLowerCase())continue;

      let opponentName='',opponentId='';
      if(samePlayer(m.player1,m.player1Id,knownPlayer)){
        opponentName=m.player2||'';
        opponentId=m.player2Id||'';
      }else if(samePlayer(m.player2,m.player2Id,knownPlayer)){
        opponentName=m.player1||'';
        opponentId=m.player1Id||'';
      }else{
        continue;
      }

      if(!opponentName||/^bye$/i.test(clean(opponentName)))continue;

      // If both sides have event metadata, use it as an additional safeguard.
      const wantedEvent=clean((String(eventText).match(/(?:Men(?:'s)?|Women(?:'s)?)\s*(?:Over\s*)?(?:35|40|45|50|55|60|65|70|75|80|85)\+?/i)||[])[0]||'');
      const oldEvent=clean(m.event||'');
      if(wantedEvent&&oldEvent&&nameKey(wantedEvent)!==nameKey(oldEvent))continue;

      candidates.push({
        opponentName,
        opponentId,
        venue:m.venue||'',
        court:m.court||'',
        event:m.event||'',
        round:m.round||'',
        result:m.result||'',
        status:m.status||''
      });
    }

    // Collapse duplicates from a previously polluted dataset. Recovery is safe
    // only when all surviving rows agree on the same opponent identity.
    const unique=new Map();
    for(const c of candidates){
      const key=String(c.opponentId||'')||nameKey(c.opponentName);
      if(!key)continue;
      if(!unique.has(key))unique.set(key,c);
    }

    if(unique.size!==1)return null;
    return [...unique.values()][0];
  }

  const page=await context.newPage();
  const observations=[];
  const seen=new Set();

  let rawTextBlocks=0;
  let twoPlayerBlocks=0;
  let h2hMarkersSeen=0;
  const unresolvedSamples=[];
  let recoveredByeBlocks=0;
  let recoveredPreviousBlocks=0;
  let recoveredPairedFragments=0;
  let recoveredRawSecondName=0;
  let recoveredFutureTbdFixtures=0;
  const pendingOnePlayerFragments=[];


  function eventKeyFromText(text){
    const m=String(text||'').match(/(?:Men(?:'s)?|Women(?:'s)?)\s*(?:Over\s*)?(?:35|40|45|50|55|60|65|70|75|80|85)\+?/i);
    return clean(m?.[0]||'').toLowerCase();
  }

  function stripSeedSuffix(name){
    return clean(String(name||'').replace(/\s*\[[^\]]+\]\s*$/,''));
  }

  // Fallback for a row where one canonical player is recognised but another
  // visible player name is not present in the current player snapshot.
  // We only accept a candidate when it looks like a human name and is not a
  // tournament/status word.
  function rawNameCandidates(text){
    let s=clean(text)
      .replace(/(?:Men(?:'s)?|Women(?:'s)?)\s*(?:Over\s*)?(?:35|40|45|50|55|60|65|70|75|80|85)\+?/ig,' ')
      .replace(/\b(?:Consolation|Plate|Final|Semi[- ]?final|Quarter[- ]?final|Round\s+of\s+\d+|Round\s+\d+|Bye|Walkover|W|H2H)\b/ig,' ')
      .replace(/\[[^\]]+\]/g,' ')
      .replace(/\b\d{1,2}\b/g,' ')
      .replace(/\s+/g,' ')
      .trim();

    if(!s)return [];

    // Build candidate 2-4 word proper names from title-cased runs.
    const tokens=s.split(/\s+/);
    const out=[];
    for(let i=0;i<tokens.length;i++){
      for(let len=4;len>=2;len--){
        if(i+len>tokens.length)continue;
        const slice=tokens.slice(i,i+len);
        if(!slice.every(t=>/^[A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿ'’.-]*$/.test(t)))continue;
        const cand=clean(slice.join(' '));
        if(cand.length>=5)out.push(cand);
      }
    }
    return [...new Set(out)];
  }

  function namesInBlock(matchText){
    const lower=String(matchText||'').toLowerCase();
    const found=[];

    for(const item of knownNameRows){
      let from=0;
      while(from<lower.length){
        const idx=lower.indexOf(item.lower,from);
        if(idx<0)break;

        const before=idx>0?lower[idx-1]:' ';
        const afterPos=idx+item.lower.length;
        const after=afterPos<lower.length?lower[afterPos]:' ';

        if(!/[a-z0-9]/.test(before)&&!/[a-z0-9]/.test(after)){
          found.push({name:item.name,index:idx,length:item.lower.length});
          break;
        }
        from=idx+1;
      }
    }

    found.sort((a,b)=>a.index-b.index||b.length-a.length);

    const chosen=[];
    for(const f of found){
      const contained=chosen.some(x=>
        f.index>=x.index &&
        f.index+f.length<=x.index+x.length
      );
      if(!contained)chosen.push(f);
    }

    return chosen.map(x=>x.name);
  }


  function uniquelyResolveVisiblePlayerName(candidateText,knownPlayer=null){
    const candidate=clean(candidateText)
      .replace(/\[[^\]]+\]/g,' ')
      .replace(/\s+/g,' ')
      .trim();

    if(!candidate)return null;

    const exact=(canonicalPlayers||[]).filter(p=>nameKey(p.name)===nameKey(candidate));
    if(exact.length===1){
      if(knownPlayer&&String(exact[0].officialPlayerId||'')===String(knownPlayer.officialPlayerId||''))return null;
      return exact[0];
    }

    // Conservative suffix/prefix comparison for TournamentSoftware spelling
    // differences. Require exactly one canonical player.
    const candTokens=nameKey(candidate).split(' ').filter(Boolean);
    if(candTokens.length<2)return null;

    const fuzzy=(canonicalPlayers||[]).filter(p=>{
      if(knownPlayer&&String(p.officialPlayerId||'')===String(knownPlayer.officialPlayerId||''))return false;
      const pt=nameKey(p.name).split(' ').filter(Boolean);
      if(pt.length<2)return false;
      return candTokens.every(t=>pt.includes(t)) || pt.every(t=>candTokens.includes(t));
    });

    return fuzzy.length===1?fuzzy[0]:null;
  }

  function visibleSecondPlayerFromText(matchText,knownPlayer){
    if(!knownPlayer)return null;

    let text=clean(matchText)
      .replace(/(?:Men(?:'s)?|Women(?:'s)?)\s*(?:Over\s*)?\+?\s*(?:35|40|45|50|55|60|65|70|75|80|85)\+?/ig,' ')
      .replace(/\b(?:Consolation|Plate|Final|Semi[- ]?final|Quarter[- ]?final|Round\s+of\s+\d+|Round\s+\d+|Bye|Walkover|H2H)\b/ig,' ')
      .replace(/\bW\b/g,' ')
      .replace(/\b\d{1,2}\b/g,' ')
      .replace(/\[[^\]]+\]/g,' ')
      .replace(/\s+/g,' ')
      .trim();

    // Remove the already-known player's displayed name.
    const knownWords=clean(knownPlayer.name).split(/\s+/).filter(Boolean);
    for(const word of knownWords){
      text=text.replace(new RegExp(`\\b${word.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&')}\\b`,'ig'),' ');
    }
    text=clean(text);

    const words=text.split(/\s+/).filter(Boolean);
    const candidates=[];

    // Prefer longer name runs, but only accept one uniquely resolvable player.
    for(let len=Math.min(5,words.length);len>=2;len--){
      for(let i=0;i+len<=words.length;i++){
        const c=clean(words.slice(i,i+len).join(' '));
        if(!/^[A-Za-zÀ-ÖØ-öø-ÿ'’.\- ]+$/.test(c))continue;
        const p=uniquelyResolveVisiblePlayerName(c,knownPlayer);
        if(p)candidates.push(p);
      }
    }

    const unique=new Map();
    for(const p of candidates){
      const key=String(p.officialPlayerId||'')||nameKey(p.name);
      if(key&&!unique.has(key))unique.set(key,p);
    }

    return unique.size===1?[...unique.values()][0]:null;
  }

  async function bodyText(){
    for(const frame of page.frames()){
      try{
        const txt=await frame.locator('body').innerText();
        if(/\bMatch schedule\b/i.test(txt)&&/\bH2H\b/i.test(txt))return txt;
      }catch{}
    }
    try{return await page.locator('body').innerText()}catch{return ''}
  }


  function inferTournamentWinner(whole,p1,p2){
    const text=clean(whole||'');
    if(!text||!p1||!p2)return null;

    const visible=n=>clean(String(n||'').replace(/\s*\[[^\]]+\]\s*$/,''));
    const n1=visible(p1.name),n2=visible(p2.name);
    const lower=text.toLowerCase();
    const i1=lower.indexOf(n1.toLowerCase());
    const i2=lower.indexOf(n2.toLowerCase());
    if(i1<0||i2<0||i1===i2)return null;

    const first=i1<i2
      ? {p:p1,start:i1,end:i1+n1.length}
      : {p:p2,start:i2,end:i2+n2.length};
    const second=i1<i2
      ? {p:p2,start:i2,end:i2+n2.length}
      : {p:p1,start:i1,end:i1+n1.length};

    const wMatches=[...text.matchAll(/\bW\b/g)];
    if(!wMatches.length)return null;

    for(const w of wMatches){
      const wi=w.index??-1;
      if(wi<0)continue;

      // TournamentSoftware renders:
      //   Player1 W Player2 ...  -> Player1 won
      //   Player1 Player2 W ...  -> Player2 won
      if(wi>=first.end&&wi<second.start)return first.p;
      if(wi>=second.end)return second.p;
    }

    return null;
  }

  function addObservationFromPlayers(f,p1,p2,whole,forcedVenue='',extra={}){
    if(!p1||!p2)return false;

    if(String(p1.officialPlayerId||'') &&
       String(p1.officialPlayerId||'')===String(p2.officialPlayerId||''))return false;

    if(forcedVenue)f.venue=forcedVenue;

    const inferredWinner=inferTournamentWinner(whole,p1,p2);
    if(inferredWinner){
      f.winner=inferredWinner.name;
      f.winnerId=inferredWinner.officialPlayerId||'';
      if(!f.status||f.status==='scheduled')f.status='completed';
    }

    const key=[
      f.date,
      clean(f.time).toLowerCase(),
      ...[
        String(p1.officialPlayerId||nameKey(p1.name)),
        String(p2.officialPlayerId||nameKey(p2.name))
      ].sort()
    ].join('|');

    if(seen.has(key)){
      const existing=observations.find(x=>[
        x.date,
        clean(x.time).toLowerCase(),
        ...[
          String(x.player1Id||nameKey(x.player1)),
          String(x.player2Id||nameKey(x.player2))
        ].sort()
      ].join('|')===key);

      if(existing){
        if(!existing.venue&&f.venue)existing.venue=f.venue;
        if(!existing.result&&f.result){
          existing.result=f.result;
          existing.status='completed';
        }
        if(!existing.court&&f.court)existing.court=f.court;
        if(!existing.winner&&f.winner){
          existing.winner=f.winner;
          existing.winnerId=f.winnerId||'';
          existing.status='completed';
        }
      }
      return false;
    }

    seen.add(key);
    observations.push({
      ...f,
      player1:p1.name,
      player1Id:p1.officialPlayerId||'',
      player2:p2.name,
      player2Id:p2.officialPlayerId||'',
      result:f.result||'',
      winner:f.winner||'',
      winnerId:f.winnerId||'',
      status:(f.result||f.winner)?'completed':(f.status||'scheduled'),
      source:'TournamentSoftware Matches Text',
      sourceUrl:MATCHES_URL,
      rawText:'',
      ...extra
    });
    return true;
  }

  function tryPairPendingFragment(fragment,forcedVenue=''){
    // Pair only with the immediately previous compatible fragment. This avoids
    // cross-pairing multiple simultaneous matches in the same event/time group.
    for(let i=pendingOnePlayerFragments.length-1;i>=0;i--){
      const prev=pendingOnePlayerFragments[i];
      if(prev.used)continue;

      if(prev.date!==fragment.date)break;
      if(prev.time!==fragment.time)continue;
      if(prev.eventKey!==fragment.eventKey)continue;

      // Don't pair the same player with itself.
      if(nameKey(prev.player.name)===nameKey(fragment.player.name))continue;

      prev.used=true;
      fragment.used=true;

      const f={
        ...prev.fields,
        event:prev.fields.event||fragment.fields.event,
        round:prev.fields.round||fragment.fields.round,
        venue:prev.fields.venue||fragment.fields.venue,
        court:prev.fields.court||fragment.fields.court,
        result:prev.fields.result||fragment.fields.result,
        status:(prev.fields.result||fragment.fields.result)?'completed':
          (prev.fields.status||fragment.fields.status||'scheduled')
      };

      const whole=clean(`${prev.whole} ${fragment.whole}`);
      if(addObservationFromPlayers(f,prev.player,fragment.player,whole,forcedVenue,{
        recoveredFrom:'adjacent-one-player-fragments'
      })){
        recoveredPairedFragments++;
        return true;
      }
    }

    pendingOnePlayerFragments.push(fragment);
    return false;
  }

  async function parseCurrentState(forcedVenue=''){
    const pendingStart=pendingOnePlayerFragments.length;
    const body=String(await bodyText())
      .replace(/\u00a0/g,' ')
      .replace(/\r/g,'');

    const h2hCount=(body.match(/\bH2H\b/gi)||[]).length;
    h2hMarkersSeen+=h2hCount;
    if(!h2hCount)return 0;

    const dateMatch=body.match(
      /(?:Match schedule\s+|Matches\s*-\s*)?(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday),?\s+(\d{1,2})\s+(August|September)\s+2026/i
    );
    const dateText=dateMatch?dateMatch[0]:'';

    const parts=body.split(/\bH2H\b/i);
    let currentTime='';
    let added=0;

    for(const rawPart of parts){
      const part=clean(rawPart);
      if(!part)continue;

      const timeMatches=[...part.matchAll(/\b(\d{1,2}:[0-5]\d)\b/g)];
      if(timeMatches.length){
        currentTime=timeMatches[timeMatches.length-1][1];
      }
      if(!currentTime)continue;

      let matchText=part;
      if(timeMatches.length){
        const last=timeMatches[timeMatches.length-1];
        matchText=clean(part.slice((last.index||0)+last[0].length));
      }
      if(!matchText)continue;

      rawTextBlocks++;
      const names=namesInBlock(matchText);

      const whole=clean(`${dateText} ${currentTime} ${matchText}`);
      const f=deriveFields(whole,'');
      if(!f.date||!f.time||!isTournamentDate(f.date))continue;

      let p1=null,p2=null;
      let recoveredPrevious=null;
      const isByeBlock=/\bBye\b/i.test(matchText);

      if(names.length===2){
        p1=resolveName(names[0],whole);
        p2=resolveName(names[1],whole);
        if(!p1||!p2)continue;
        twoPlayerBlocks++;
      }else if(names.length===1&&isByeBlock){
        // TournamentSoftware renders a bye with only the real player's name.
        // Preserve which side the Bye appeared on.
        const real=resolveName(names[0],whole);
        if(!real)continue;
        recoveredByeBlocks++;

        const namePos=matchText.toLowerCase().indexOf(String(names[0]).toLowerCase());
        const byePos=matchText.toLowerCase().indexOf('bye');

        if(byePos>=0&&namePos>=0&&byePos<namePos){
          p1={name:'Bye',officialPlayerId:''};
          p2=real;
        }else{
          p1=real;
          p2={name:'Bye',officialPlayerId:''};
        }
      }else if(names.length===1){
        // Some future fixtures are rendered as two consecutive H2H fragments,
        // one player per fragment. First try the exact previous published
        // fixture; if that is unavailable, pair only adjacent fragments with
        // identical date/time/event.
        const real=resolveName(names[0],whole);

        // Never reuse an old opponent for a FUTURE bracket fixture. The next
        // opponent may still depend on an earlier round, and stale published
        // data can otherwise create a false concrete pairing.
        const today=perthTodayIsoRefresh();
        recoveredPrevious=
          f.date<=today
            ? recoverPreviousOpponent(f.date,f.time,real,whole)
            : null;

        if(real&&recoveredPrevious){
          recoveredPreviousBlocks++;
          p1=real;
          p2={
            name:recoveredPrevious.opponentName,
            officialPlayerId:recoveredPrevious.opponentId||''
          };
          if(!f.venue&&recoveredPrevious.venue)f.venue=recoveredPrevious.venue;
          if(!f.court&&recoveredPrevious.court)f.court=recoveredPrevious.court;
          if(!f.event&&recoveredPrevious.event)f.event=recoveredPrevious.event;
          if(!f.round&&recoveredPrevious.round)f.round=recoveredPrevious.round;
          if(!f.result&&recoveredPrevious.result){
            f.result=recoveredPrevious.result;
            f.status=recoveredPrevious.status||'completed';
          }
        }else if(real&&visibleSecondPlayerFromText(matchText,real)){
          const visibleOpponent=visibleSecondPlayerFromText(matchText,real);
          recoveredRawSecondName++;
          p1=real;
          p2=visibleOpponent;
        }else if(real){
          const fragment={
            date:f.date,
            time:f.time,
            eventKey:eventKeyFromText(whole),
            player:real,
            fields:{...f},
            whole,
            used:false
          };
          if(tryPairPendingFragment(fragment,forcedVenue)){
            continue;
          }

          // Keep it pending for the immediately following compatible fragment.
          continue;
        }else{
          if(unresolvedSamples.length<30){
            unresolvedSamples.push({
              date:dateText,
              time:currentTime,
              names,
              text:matchText.slice(0,260)
            });
          }
          continue;
        }
      }else{
        // Ignore page/footer text after the final H2H marker.
        if(!/World Squash Federation|Privacy|Cookies|HELP CENTRE/i.test(matchText)){
          if(unresolvedSamples.length<30){
            unresolvedSamples.push({
              date:dateText,
              time:currentTime,
              names,
              text:matchText.slice(0,260)
            });
          }
        }
        continue;
      }

      if(!p1||!p2)continue;

      if(addObservationFromPlayers(f,p1,p2,whole,forcedVenue)){
        added++;
      }
    }

    // TournamentSoftware legitimately renders some future bracket fixtures with
    // only the player already known in the next round. After giving every
    // fragment in this rendered state a chance to pair, preserve any remaining
    // valid one-player scheduled fixture as "vs TBD" instead of dropping it.
    for(let i=pendingStart;i<pendingOnePlayerFragments.length;i++){
      const fragment=pendingOnePlayerFragments[i];
      if(!fragment||fragment.used)continue;
      if(!fragment.date||!fragment.time||!fragment.player)continue;
      if(!isTournamentDate(fragment.date))continue;

      const f={...fragment.fields};
      if(forcedVenue)f.venue=forcedVenue;

      // Do not turn an unplaced bracket advancement/Bye into a dated match.
      // A one-player Matches-page TBD is accepted only when a real official
      // venue AND court are present.
      if(f.venue&&f.court){
        const tbd={name:'TBD',officialPlayerId:''};

        if(addObservationFromPlayers(
          f,
          fragment.player,
          tbd,
          fragment.whole,
          forcedVenue,
          {recoveredFrom:'future-one-player-tbd-verified'}
        )){
          recoveredFutureTbdFixtures++;
          added++;
        }
      }

      fragment.used=true;
    }


    return added;
  }

  async function exactTextCandidates(text){
    const wanted=clean(text).toUpperCase();
    const found=[];

    for(let fi=0;fi<page.frames().length;fi++){
      const frame=page.frames()[fi];

      try{
        const rows=await frame.evaluate((wantedText)=>{
          const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
          const wanted=clean(wantedText).toUpperCase();
          const out=[];

          for(const el of document.querySelectorAll('body *')){
            const own=clean(el.innerText||el.textContent||'');
            if(own.toUpperCase()!==wanted)continue;

            const r=el.getBoundingClientRect();
            if(!r||r.width<1||r.height<1)continue;

            // Prefer the smallest exact-text element, then walk to the nearest
            // actually clickable ancestor.
            let clickEl=el;
            let cur=el;
            for(let d=0;d<6&&cur;d++,cur=cur.parentElement){
              const tag=String(cur.tagName||'').toLowerCase();
              const role=String(cur.getAttribute?.('role')||'').toLowerCase();
              const cls=String(cur.className||'');
              const style=getComputedStyle(cur);
              const clickable=
                tag==='button'||tag==='a'||tag==='label'||
                role==='tab'||role==='option'||role==='menuitem'||role==='button'||
                typeof cur.onclick==='function'||
                style.cursor==='pointer'||
                /tab|option|select|filter|menu|click|date|day|venue/i.test(cls);

              if(clickable){clickEl=cur;break}
            }

            const cr=clickEl.getBoundingClientRect();
            out.push({
              text:own,
              tag:String(clickEl.tagName||''),
              role:String(clickEl.getAttribute?.('role')||''),
              cls:String(clickEl.className||''),
              area:Math.max(1,cr.width*cr.height)
            });
          }

          return out.sort((a,b)=>a.area-b.area).slice(0,12);
        },text);

        for(const row of rows)found.push({...row,frameIndex:fi});
      }catch{}
    }

    return found;
  }

  async function clickExactText(text){
    const wanted=clean(text).toUpperCase();

    for(let fi=0;fi<page.frames().length;fi++){
      const frame=page.frames()[fi];

      try{
        const clicked=await frame.evaluate((wantedText)=>{
          const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
          const wanted=clean(wantedText).toUpperCase();
          const matches=[];

          for(const el of document.querySelectorAll('body *')){
            const own=clean(el.innerText||el.textContent||'');
            if(own.toUpperCase()!==wanted)continue;

            const r=el.getBoundingClientRect();
            if(!r||r.width<1||r.height<1)continue;

            let clickEl=el;
            let cur=el;

            for(let d=0;d<7&&cur;d++,cur=cur.parentElement){
              const tag=String(cur.tagName||'').toLowerCase();
              const role=String(cur.getAttribute?.('role')||'').toLowerCase();
              const cls=String(cur.className||'');
              const style=getComputedStyle(cur);
              const clickable=
                tag==='button'||tag==='a'||tag==='label'||
                role==='tab'||role==='option'||role==='menuitem'||role==='button'||
                typeof cur.onclick==='function'||
                style.cursor==='pointer'||
                /tab|option|select|filter|menu|click|date|day|venue/i.test(cls);

              if(clickable){clickEl=cur;break}
            }

            const cr=clickEl.getBoundingClientRect();
            matches.push({el,clickEl,area:Math.max(1,cr.width*cr.height)});
          }

          if(!matches.length)return false;

          matches.sort((a,b)=>a.area-b.area);
          const target=matches[0].clickEl;

          try{target.scrollIntoView({block:'center',inline:'nearest'})}catch{}
          try{target.click();return true}catch{}
          try{
            target.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));
            return true;
          }catch{}

          return false;
        },text);

        if(clicked){
          await sleep(600);
          return true;
        }
      }catch{}
    }

    return false;
  }

  async function tabLabels(){
    // TournamentSoftware date tabs are custom elements. Read them from the
    // rendered body text instead of assuming a particular tag/role.
    const txt=clean(await bodyText());
    const rx=/\b(SUN|MON|TUE|WED|THU|FRI|SAT)\s+(30|31|1|2|3|4|5|6)\s+(AUG|SEP)\b/gi;
    const out=[],seenTabs=new Set();

    for(const m of txt.matchAll(rx)){
      const label=`${m[1].toUpperCase()} ${m[2]} ${m[3].toUpperCase()}`;
      if(seenTabs.has(label))continue;
      seenTabs.add(label);
      out.push(label);
    }

    return out;
  }

  async function currentH2HCount(){
    const txt=clean(await bodyText());
    return (txt.match(/\bH2H\b/gi)||[]).length;
  }

  async function currentScheduleDate(){
    const txt=clean(await bodyText());
    const m=txt.match(/Match schedule\s+(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday),?\s+(\d{1,2})\s+(August|September)\s+2026/i);
    if(!m)return '';
    const month=/sep/i.test(m[3])?'09':'08';
    return `2026-${month}-${String(Number(m[2])).padStart(2,'0')}`;
  }

  async function clickDateTab(text){
    const before=await currentScheduleDate();
    const clicked=await clickExactText(text);

    if(!clicked)return false;

    // Wait for the "Match schedule ..." heading to change, or for a short
    // render delay when the requested day happens to already be selected.
    for(let i=0;i<12;i++){
      await sleep(150);
      const after=await currentScheduleDate();
      if(after&&after!==before)return true;
    }

    return true;
  }

  async function selectVenue(venue){
    // First try a native <select>, if TournamentSoftware happens to expose one.
    for(const frame of page.frames()){
      const selects=frame.locator('select');
      let count=0;
      try{count=await selects.count()}catch{}

      for(let i=0;i<count;i++){
        const sel=selects.nth(i);
        const options=await sel.locator('option').allInnerTexts().catch(()=>[]);
        const idx=options.findIndex(x=>clean(x).toLowerCase()===clean(venue).toLowerCase());
        if(idx<0)continue;

        try{
          const optionValue=await sel.locator('option').nth(idx).getAttribute('value');
          if(optionValue!==null)await sel.selectOption(optionValue);
          else await sel.selectOption({label:options[idx]});
          await sleep(500);
          return true;
        }catch{}
      }
    }

    // Custom TournamentSoftware control. Click the current venue/filter text,
    // then click the requested venue wherever it is rendered.
    for(const triggerText of ['All venues','Venue']){
      if(await clickExactText(triggerText)){
        await sleep(180);
        break;
      }
    }

    let clicked=await clickExactText(venue);
    if(clicked){
      await sleep(600);
      return true;
    }

    // Playwright fallback for TournamentSoftware's custom dropdown/portal.
    // Prefer the last visible exact-text occurrence because the first one can
    // be a hidden/static copy in the filter control.
    for(const frame of page.frames()){
      try{
        const loc=frame.getByText(venue,{exact:true});
        const count=await loc.count();
        for(let i=count-1;i>=0;i--){
          const candidate=loc.nth(i);
          if(!(await candidate.isVisible().catch(()=>false)))continue;
          try{
            await candidate.click({force:true,timeout:1500});
            await sleep(650);
            return true;
          }catch{}
        }
      }catch{}
    }

    return false;
  }

  try{
    const datesExpected=[
      'SUN 30 AUG','MON 31 AUG','TUE 1 SEP','WED 2 SEP',
      'THU 3 SEP','FRI 4 SEP','SAT 5 SEP','SUN 6 SEP'
    ];

    const expectedIsoForLabel=label=>{
      const m=String(label||'').match(/\b(30|31|1|2|3|4|5|6)\s+(AUG|SEP)\b/i);
      if(!m)return '';
      const month=/SEP/i.test(m[2])?'09':'08';
      return `2026-${month}-${String(Number(m[1])).padStart(2,'0')}`;
    };

    const currentVenueText=async()=>{
      const txt=clean(await bodyText());

      // Look for the selected venue close to the Venue control. TournamentSoftware
      // currently renders "Venue <selection>" in the page text.
      const m=txt.match(/\bVenue\s+(All venues|Squashworld Mirrabooka|Belmont Saints Squash Centre|Karrinyup Shopping Centre)\b/i);
      return m?clean(m[1]):'';
    };

    const waitForDate=async(expectedIso)=>{
      for(let i=0;i<14;i++){
        const current=await currentScheduleDate();
        if(current===expectedIso)return true;
        await sleep(150);
      }
      return false;
    };

    const waitForVenue=async(expectedVenue)=>{
      for(let i=0;i<14;i++){
        const current=await currentVenueText();
        if(clean(current).toLowerCase()===clean(expectedVenue).toLowerCase())return true;
        await sleep(150);
      }
      return false;
    };

    const parseVerifiedDateState=async(dateLabel,venue='')=>{
      const expectedIso=expectedIsoForLabel(dateLabel);
      const actualIso=await currentScheduleDate();

      if(actualIso!==expectedIso){
        console.warn(`    REFUSED parse: requested ${dateLabel} (${expectedIso}) but page heading is ${actualIso||'(unknown)'}.`);
        return 0;
      }

      if(venue){
        const activeVenue=await currentVenueText();
        if(clean(activeVenue).toLowerCase()!==clean(venue).toLowerCase()){
          console.warn(`    REFUSED venue assignment: requested "${venue}" but page reports "${activeVenue||'(unknown)'}".`);
          return 0;
        }
      }

      return parseCurrentState(venue);
    };

    // Discover once for diagnostics, but crawl every date from a fresh page load
    // so a custom venue dropdown or stale UI state cannot break later date tabs.
    await gotoTournamentSoftware(page,MATCHES_URL,4);
    await dismissPopups(page);
    await sleep(800);

    const discovered=await tabLabels();
    console.log(`Official TournamentSoftware Matches date tabs discovered: ${discovered.length}${discovered.length?` (${discovered.join(', ')})`:''}`);

    const venues=[
      'Squashworld Mirrabooka',
      'Belmont Saints Squash Centre',
      'Karrinyup Shopping Centre'
    ];

    for(const dateLabel of datesExpected){
      // Reset TournamentSoftware completely for every date.
      await gotoTournamentSoftware(page,MATCHES_URL,4);
      await dismissPopups(page);
      await sleep(700);

      const expectedIso=expectedIsoForLabel(dateLabel);
      let actualIso=await currentScheduleDate();

      if(actualIso!==expectedIso){
        const clicked=await clickDateTab(dateLabel);

        if(!clicked || !(await waitForDate(expectedIso))){
          actualIso=await currentScheduleDate();
          console.warn(`  Could not activate date tab ${dateLabel}; page remained ${actualIso||'(unknown)'}.`);
          continue;
        }
      }

      console.log(`  TournamentSoftware Matches date verified: ${dateLabel} -> ${expectedIso}`);

      // First parse the verified All venues state. This is the authoritative
      // schedule count for the date.
      const allAdded=await parseVerifiedDateState(dateLabel,'');
      console.log(`    All venues: ${allAdded} new fixture(s)`);

      // Then revisit the date from a clean page for each venue. Venue metadata
      // is attached only after TournamentSoftware itself confirms the filter.
      for(const venue of venues){
        await gotoTournamentSoftware(page,MATCHES_URL,4);
        await dismissPopups(page);
        await sleep(650);

        if((await currentScheduleDate())!==expectedIso){
          const clicked=await clickDateTab(dateLabel);
          if(!clicked || !(await waitForDate(expectedIso))){
            console.warn(`    Could not restore ${dateLabel} before venue ${venue}.`);
            continue;
          }
        }

        const beforeVenueCount=await currentH2HCount();
        const selected=await selectVenue(venue);
        await sleep(700);

        const afterVenueCount=await currentH2HCount();
        const active=await currentVenueText();

        // TournamentSoftware's rendered body keeps the text "Venue All venues"
        // even when its custom venue control is filtered, so that label alone
        // cannot verify the selection. A real venue filter must materially
        // change the displayed H2H match set (or explicitly report the venue).
        const textVerified=
          clean(active).toLowerCase()===clean(venue).toLowerCase();

        const countVerified=
          selected &&
          afterVenueCount>0 &&
          beforeVenueCount>0 &&
          afterVenueCount<beforeVenueCount;

        if(!textVerified&&!countVerified){
          console.warn(`    Venue filter not verified for ${venue}; H2H ${beforeVenueCount} -> ${afterVenueCount}, active="${active||'(unknown)'}". No venue metadata applied.`);
          continue;
        }

        // Date must still be correct after the custom filter interaction.
        if((await currentScheduleDate())!==expectedIso){
          console.warn(`    Venue filter ${venue} changed away from ${dateLabel}; no venue metadata applied.`);
          continue;
        }

        // We have independently verified the venue filter, so force the venue
        // while parsing this filtered match set. Do not re-use the unreliable
        // body-text "Venue All venues" check in parseVerifiedDateState().
        const added=await parseCurrentState(venue);
        console.log(`    ${venue}: ${added} new/enriched fixture(s) (verified H2H ${beforeVenueCount} -> ${afterVenueCount})`);
      }
    }

    if(!observations.length){
      const txt=await bodyText();
      console.warn('Matches-page text diagnostic:',clean(txt).slice(0,1800));
    }
  }finally{
    await page.close();
  }

  const matches=officialScheduleMerge(observations);

  // Reject obvious navigation failures where two different dates are actually
  // the same rendered schedule copied under another date.
  const signatureByDate=new Map();
  for(const m of matches){
    const d=canonicalTournamentDate(m.date);
    if(!d)continue;
    if(!signatureByDate.has(d))signatureByDate.set(d,[]);
    signatureByDate.get(d).push([
      clean(m.time).toLowerCase(),
      ...[
        String(m.player1Id||nameKey(m.player1)),
        String(m.player2Id||nameKey(m.player2))
      ].sort()
    ].join('|'));
  }

  const signatureEntries=[...signatureByDate.entries()]
    .map(([d,rows])=>[d,[...new Set(rows)].sort().join('||'),rows.length]);

  for(let i=0;i<signatureEntries.length;i++){
    for(let j=i+1;j<signatureEntries.length;j++){
      const [d1,s1,n1]=signatureEntries[i];
      const [d2,s2,n2]=signatureEntries[j];
      if(n1>=100&&n2>=100&&s1===s2){
        throw new Error(`TournamentSoftware navigation validation failed: ${d1} and ${d2} produced identical ${n1}-match schedules.`);
      }
    }
  }

  const byDate={};
  for(const m of matches){
    const d=canonicalTournamentDate(m.date)||m.date||'unknown';
    byDate[d]=(byDate[d]||0)+1;
  }

  const byVenue={};
  for(const m of matches){
    const v=clean(m.venue)||'Venue TBD';
    byVenue[v]=(byVenue[v]||0)+1;
  }

  console.log(`Official TournamentSoftware Matches H2H markers seen: ${h2hMarkersSeen}`);
  console.log(`Official TournamentSoftware Matches two-player text blocks: ${twoPlayerBlocks}/${rawTextBlocks}`);
  console.log(`Official TournamentSoftware Matches schedule: ${matches.length} unique fixtures from ${observations.length} observations.`);
  console.log(`Official TournamentSoftware Matches by date: ${JSON.stringify(byDate)}`);
  console.log(`Official TournamentSoftware Matches by venue: ${JSON.stringify(byVenue)}`);
  const venueKnown=matches.filter(m=>/^(Karrinyup Shopping Centre|Squashworld Mirrabooka|Belmont Saints Squash Centre)$/i.test(clean(m.venue||''))).length;
  console.log(`Official TournamentSoftware Matches venue metadata coverage: ${venueKnown}/${matches.length}.`);
  console.log(`Official TournamentSoftware Matches scored/completed fixtures: ${matches.filter(m=>m.result||String(m.status||'').toLowerCase()==='completed').length} (${matches.filter(m=>m.result).length} with results).`);
  console.log(`Official TournamentSoftware Matches recovered Bye blocks: ${recoveredByeBlocks}`);
  console.log(`Official TournamentSoftware Matches recovered one-player blocks from exact prior fixture: ${recoveredPreviousBlocks}`);
  console.log(`Official TournamentSoftware Matches recovered visibly named second players: ${recoveredRawSecondName}`);
  console.log(`Official TournamentSoftware Matches recovered adjacent one-player fragment pairs: ${recoveredPairedFragments}`);
  console.log(`Official TournamentSoftware Matches recovered future one-player fixtures as TBD: ${recoveredFutureTbdFixtures}`);
  console.log(`Official TournamentSoftware Matches unresolved H2H blocks: ${Math.max(0,rawTextBlocks-twoPlayerBlocks-recoveredByeBlocks-recoveredPreviousBlocks-(recoveredPairedFragments*2))}`);
  if(unresolvedSamples.length){
    console.log(`Official TournamentSoftware Matches unresolved samples: ${JSON.stringify(unresolvedSamples,null,2)}`);
  }

  return {
    matches,
    observations:observations.length,
    rawTextBlocks,
    twoPlayerBlocks,
    h2hMarkersSeen,
    byDate,
    byVenue
  };
}

async function collectOfficialDrawLinks(page){
  const isAgeDrawHref=href=>{
    try{
      const u=new URL(href,DRAWS_URL);
      if(!/tournamentsoftware\.com$/i.test(u.hostname))return false;
      if(!/\/sport\/draw\.aspx$/i.test(u.pathname))return false;
      return !!u.searchParams.get('draw');
    }catch{return false}
  };

  const extractFromAllFrames=async()=>{
    const all=[];
    for(const frame of page.frames()){
      try{
        const rows=await frame.evaluate(()=>[...document.querySelectorAll('a[href]')].map(a=>({
          text:String(a.innerText||a.textContent||a.getAttribute('title')||a.getAttribute('aria-label')||'')
            .replace(/\s+/g,' ').trim(),
          href:a.href||''
        })));
        all.push(...rows);
      }catch{}
    }
    return all;
  };

  const waitForDrawLinks=async(label)=>{
    const deadline=Date.now()+15000;
    let lastCount=0;

    while(Date.now()<deadline){
      await dismissPopups(page).catch(()=>{});

      // Force lazy/virtualized sections to materialize.
      try{
        await page.evaluate(()=>{
          window.scrollTo(0,document.documentElement?.scrollHeight||document.body?.scrollHeight||0);
        });
      }catch{}

      const raw=await extractFromAllFrames();
      const found=raw.filter(x=>isAgeDrawHref(x.href));
      lastCount=found.length;

      if(found.length>=20){
        console.log(`  ${label}: draw links became available (${found.length} raw matches across ${page.frames().length} frame(s)).`);
        return raw;
      }

      await sleep(500);
    }

    console.warn(`  ${label}: only ${lastCount} age-group draw link(s) visible after waiting.`);
    return extractFromAllFrames();
  };

  await gotoTournamentSoftware(page,DRAWS_URL,4);
  await dismissPopups(page);
  await sleep(700);

  let raw=await waitForDrawLinks('initial load');

  // TournamentSoftware occasionally paints the shell/title first and the draw
  // content only after a later navigation. Retry the actual page once.
  if(!raw.some(x=>isAgeDrawHref(x.href))){
    console.warn('  Draw shell loaded without draw links; reloading once and waiting for dynamic content...');
    await page.reload({waitUntil:'domcontentloaded',timeout:60000});
    await sleep(700);
    raw=await waitForDrawLinks('reload');
  }

  const out=new Map();

  for(const x of raw){
    if(!isAgeDrawHref(x.href))continue;

    try{
      const u=new URL(x.href,DRAWS_URL);
      u.hash='';
      const href=u.href;

      if(!out.has(href)){
        out.set(href,{href,text:clean(x.text)});
      }
    }catch{}
  }

  const links=[...out.values()]
    .sort((a,b)=>{
      const da=Number(new URL(a.href).searchParams.get('draw')||0);
      const db=Number(new URL(b.href).searchParams.get('draw')||0);
      return da-db;
    });

  console.log(`Official TournamentSoftware first-level draw links: ${links.length}`);

  if(links.length){
    console.log(`  First draw: ${links[0].href}`);
    console.log(`  Last draw:  ${links[links.length-1].href}`);
  }

  return links;
}

function officialScheduleMerge(rows){
  const out=new Map();
  const key=m=>{
    const ids=[String(m.player1Id||''),String(m.player2Id||'')].filter(Boolean).sort();
    const people=ids.length===2?ids:[nameKey(m.player1),nameKey(m.player2)].sort();
    return `${canonicalTournamentDate(m.date)}|${clean(m.time).toLowerCase()}|${people.join('~')}`;
  };

  const sourceRank=source=>{
    const s=clean(source);
    if(s==='TournamentSoftware Match')return 100;
    if(s==='TournamentSoftware Draw Tree')return 95;
    if(s==='TournamentSoftware Draw Structural')return 90;
    if(s==='TournamentSoftware Draw Inline')return 80;
    if(s==='TournamentSoftware Draw Visual')return 40;
    return 10;
  };

  const richness=m=>
    [m.result,m.round,m.venue,m.court,m.event,m.rawText]
      .reduce((n,v)=>n+clean(v).length,0)+
    sourceRank(m.source);

  for(const m0 of rows||[]){
    if(!m0?.date||!m0?.time||!m0?.player1||!m0?.player2)continue;

    const m={...m0};
    const k=key(m);
    const old=out.get(k);

    if(!old){
      m.evidenceSources=[...new Set([...(m.evidenceSources||[]),clean(m.source)].filter(Boolean))];
      out.set(k,m);
      continue;
    }

    const sources=[...new Set([
      ...(old.evidenceSources||[]),
      ...(m.evidenceSources||[]),
      clean(old.source),
      clean(m.source)
    ].filter(Boolean))];

    const keep=richness(m)>richness(old)?{...old,...m}:{...m,...old};

    // Strongest source describes fixture existence; evidenceSources keeps all
    // corroborating discovery methods.
    const candidates=[old,m].sort((a,b)=>sourceRank(b.source)-sourceRank(a.source));
    keep.source=candidates[0]?.source||keep.source;
    keep.evidenceSources=sources;

    if(!keep.result&&(old.result||m.result))keep.result=old.result||m.result;
    if(String(old.status||'').toLowerCase()==='completed'||String(m.status||'').toLowerCase()==='completed'){
      keep.status='completed';
    }

    // Never lose valid location metadata when another observation of the same
    // exact fixture contained it.
    const strongest=candidates[0]||{};
    if(strongest.venue)keep.venue=strongest.venue;
    else if(!keep.venue)keep.venue=old.venue||m.venue||'';

    if(strongest.court)keep.court=sanitizeCourtValue(strongest.court);
    else if(!keep.court)keep.court=old.court||m.court||'';

    out.set(k,keep);
  }

  return [...out.values()].sort((a,b)=>
    `${a.date} ${clean(a.time)}`.localeCompare(`${b.date} ${clean(b.time)}`)
  );
}

const DRAW_COUNTRY_META={
  AUS:{country:'Australia',iso3:'AUS',flagCode:'au'},
  AUT:{country:'Austria',iso3:'AUT',flagCode:'at'},
  BEL:{country:'Belgium',iso3:'BEL',flagCode:'be'},
  CAN:{country:'Canada',iso3:'CAN',flagCode:'ca'},
  CHE:{country:'Switzerland',iso3:'CHE',flagCode:'ch'},
  SUI:{country:'Switzerland',iso3:'CHE',flagCode:'ch'},
  CHL:{country:'Chile',iso3:'CHL',flagCode:'cl'},
  COL:{country:'Colombia',iso3:'COL',flagCode:'co'},
  CZE:{country:'Czech Republic',iso3:'CZE',flagCode:'cz'},
  DEU:{country:'Germany',iso3:'DEU',flagCode:'de'},
  GER:{country:'Germany',iso3:'DEU',flagCode:'de'},
  DNK:{country:'Denmark',iso3:'DNK',flagCode:'dk'},
  DEN:{country:'Denmark',iso3:'DNK',flagCode:'dk'},
  EGY:{country:'Egypt',iso3:'EGY',flagCode:'eg'},
  ENG:{country:'England',iso3:'GBR',flagCode:'gb-eng'},
  ESP:{country:'Spain',iso3:'ESP',flagCode:'es'},
  FIN:{country:'Finland',iso3:'FIN',flagCode:'fi'},
  FRA:{country:'France',iso3:'FRA',flagCode:'fr'},
  GBR:{country:'United Kingdom',iso3:'GBR',flagCode:'gb'},
  GRC:{country:'Greece',iso3:'GRC',flagCode:'gr'},
  GRE:{country:'Greece',iso3:'GRC',flagCode:'gr'},
  HKG:{country:'Hong Kong',iso3:'HKG',flagCode:'hk'},
  HRV:{country:'Croatia',iso3:'HRV',flagCode:'hr'},
  CRO:{country:'Croatia',iso3:'HRV',flagCode:'hr'},
  HUN:{country:'Hungary',iso3:'HUN',flagCode:'hu'},
  IND:{country:'India',iso3:'IND',flagCode:'in'},
  IRL:{country:'Ireland',iso3:'IRL',flagCode:'ie'},
  ISR:{country:'Israel',iso3:'ISR',flagCode:'il'},
  ITA:{country:'Italy',iso3:'ITA',flagCode:'it'},
  JPN:{country:'Japan',iso3:'JPN',flagCode:'jp'},
  KOR:{country:'South Korea',iso3:'KOR',flagCode:'kr'},
  MAS:{country:'Malaysia',iso3:'MYS',flagCode:'my'},
  MYS:{country:'Malaysia',iso3:'MYS',flagCode:'my'},
  MEX:{country:'Mexico',iso3:'MEX',flagCode:'mx'},
  NED:{country:'Netherlands',iso3:'NLD',flagCode:'nl'},
  NLD:{country:'Netherlands',iso3:'NLD',flagCode:'nl'},
  NOR:{country:'Norway',iso3:'NOR',flagCode:'no'},
  NZL:{country:'New Zealand',iso3:'NZL',flagCode:'nz'},
  PAK:{country:'Pakistan',iso3:'PAK',flagCode:'pk'},
  POL:{country:'Poland',iso3:'POL',flagCode:'pl'},
  POR:{country:'Portugal',iso3:'PRT',flagCode:'pt'},
  PRT:{country:'Portugal',iso3:'PRT',flagCode:'pt'},
  RSA:{country:'South Africa',iso3:'ZAF',flagCode:'za'},
  ZAF:{country:'South Africa',iso3:'ZAF',flagCode:'za'},
  SCO:{country:'Scotland',iso3:'GBR',flagCode:'gb-sct'},
  SGP:{country:'Singapore',iso3:'SGP',flagCode:'sg'},
  SIN:{country:'Singapore',iso3:'SGP',flagCode:'sg'},
  SWE:{country:'Sweden',iso3:'SWE',flagCode:'se'},
  THA:{country:'Thailand',iso3:'THA',flagCode:'th'},
  UAE:{country:'United Arab Emirates',iso3:'ARE',flagCode:'ae'},
  ARE:{country:'United Arab Emirates',iso3:'ARE',flagCode:'ae'},
  USA:{country:'United States',iso3:'USA',flagCode:'us'},
  WAL:{country:'Wales',iso3:'GBR',flagCode:'gb-wls'}
};

function drawCountryMeta(code,name='',flagCode=''){
  const c=clean(code).toUpperCase();
  const known=DRAW_COUNTRY_META[c];
  if(known)return {...known,drawCountryCode:c};

  // If TournamentSoftware provides a country name and/or two-letter flag code
  // that is not in our static display map, retain the official values instead
  // of silently borrowing data from an old player snapshot.
  return {
    country:clean(name)||c||'',
    iso3:/^[A-Z]{3}$/.test(c)?c:'',
    flagCode:clean(flagCode).toLowerCase(),
    drawCountryCode:c
  };
}

function mergePreviousSquashLevelsFields(drawPlayers,previousPlayers){
  const byId=new Map((previousPlayers||[])
    .filter(p=>p.officialPlayerId)
    .map(p=>[String(p.officialPlayerId),p]));

  const keys=[
    'squashLevelsPlayerId','squashLevelsUrl','squashLevelsIdentityVerified',
    'squashLevelsIdentityVerifiedAt','squashLevelsMatchedCountry',
    'squashLevelsMatchedAge','squashLevelsSearchCheckedAt',
    'squashLevelsProfileCheckedAt','squashLevelsWorldRank',
    'squashLevelsLevel','squashLevelsLevelProvisional'
  ];

  return (drawPlayers||[]).map(p=>{
    const old=byId.get(String(p.officialPlayerId||''));
    if(!old)return {...p};
    const next={...p};
    for(const k of keys){
      if(old[k]!==undefined)next[k]=old[k];
    }
    return next;
  });
}

async function scrapeOfficialDrawSchedule(context,options={}){
  const seed=await context.newPage();

  let drawLinks=[];
  try{
    drawLinks=await collectOfficialDrawLinks(seed);
  }catch(e){
    await seed.close();
    throw new Error(`Official draws page could not be read: ${e.message}`);
  }
  await seed.close();

  console.log(`Official TournamentSoftware draw links: ${drawLinks.length}`);
  if(!drawLinks.length){
    throw new Error('Official TournamentSoftware draws page returned no age-group draw links.');
  }

  const DRAW_WORKERS=Math.max(1,Math.min(8,Number(process.env.DRAW_WORKERS||4)));
  const queue=drawLinks.map((x,i)=>({...x,index:i}));
  const workerResults=[];
  let failed=0;

  console.log(`Crawling ${drawLinks.length} draw pages with ${DRAW_WORKERS} browser workers...`);

  async function crawlDrawOnce(draw,page){
    await safeGoto(page,draw.href,3);
    await dismissPopups(page);
    await sleep(250);

    // TournamentSoftware often paints the page shell before the whole bracket
    // has arrived. Wait for the unique player-link count to stabilise.
    let previousPlayerCount=-1;
    let stableSamples=0;
    const stableDeadline=Date.now()+10000;

    while(Date.now()<stableDeadline){
      try{
        await page.evaluate(()=>window.scrollTo(
          0,
          document.documentElement?.scrollHeight||document.body?.scrollHeight||0
        ));
      }catch{}

      await sleep(250);

      let currentPlayerCount=0;
      try{
        currentPlayerCount=await page.evaluate(()=>[
          ...new Set(
            [...document.querySelectorAll('a[href]')]
              .filter(a=>/player|participant|person|profile/i.test(a.href||''))
              .map(a=>(a.href||'').split('#')[0])
              .filter(Boolean)
          )
        ].length);
      }catch{}

      if(currentPlayerCount>0 && currentPlayerCount===previousPlayerCount)stableSamples++;
      else stableSamples=0;

      previousPlayerCount=currentPlayerCount;

      if(stableSamples>=2)break;
    }

    for(let i=0;i<5;i++){
      try{
        const before=await page.evaluate(()=>document.documentElement?.scrollHeight||document.body?.scrollHeight||0);
        await page.evaluate(()=>window.scrollTo(0,document.documentElement?.scrollHeight||document.body?.scrollHeight||0));
        await sleep(80);
        const after=await page.evaluate(()=>document.documentElement?.scrollHeight||document.body?.scrollHeight||0);
        if(after===before&&i>1)break;
      }catch{break}
    }

    return page.evaluate(()=>{
      const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
      const playerHref=/player|participant|person|profile/i;
      const dateRe=/(?:\b2026[-\/.]\d{1,2}[-\/.]\d{1,2}\b|\b\d{1,2}[\/.-]\d{1,2}[\/.-]2026\b|\b\d{1,2}\s+(?:Aug(?:ust)?|Sep(?:tember)?)\b|\b(?:Aug(?:ust)?|Sep(?:tember)?)\s+\d{1,2}\b|\b(?:Sun(?:day)?|Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?)\s*,?\s*(?:30|31|[1-6])\b)/i;
      const timeRe=/\b\d{1,2}:[0-5]\d\s*(?:am|pm)?\b/i;

      const pageHead=clean(
        [...document.querySelectorAll('h1,h2,h3,h4')]
          .slice(0,20)
          .map(x=>clean(x.innerText||x.textContent||''))
          .filter(Boolean)
          .join(' | ')
      );

      function countryFromPlayerLink(a){
        let countryCode='',countryName='',flagCode='';
        const nodes=[];
        let cur=a;
        for(let d=0;d<6&&cur;d++,cur=cur.parentElement)nodes.push(cur);

        for(const node of nodes){
          for(const attr of ['data-country','data-country-code','data-nation','data-nation-code','data-iso3']){
            const v=node.getAttribute?.(attr);
            if(v){
              const t=clean(v);
              if(/^[A-Za-z]{3}$/.test(t)&&!countryCode)countryCode=t.toUpperCase();
              else if(!countryName)countryName=t;
            }
          }

          for(const img of [...(node.querySelectorAll?.('img')||[])]){
            const src=String(img.getAttribute('src')||img.src||'');
            const alt=clean(img.getAttribute('alt')||'');
            const title=clean(img.getAttribute('title')||'');

            let m=src.match(/(?:flag|flags|country|countries)[^A-Za-z0-9]+([A-Za-z]{2,3})(?:[^A-Za-z]|$)/i);
            if(!m)m=src.match(/\/([A-Za-z]{2})(?:\.[A-Za-z]+)?(?:\?|$)/);
            if(m){
              if(m[1].length===2&&!flagCode)flagCode=m[1].toLowerCase();
              if(m[1].length===3&&!countryCode)countryCode=m[1].toUpperCase();
            }

            for(const t of [alt,title]){
              const code=t.match(/\b([A-Z]{3})\b/);
              if(code&&!countryCode)countryCode=code[1];
              const named=t.match(/(?:flag of|country[:\s-]+)\s*([A-Za-z .'-]+)/i);
              if(named&&!countryName)countryName=clean(named[1]);
            }
          }

          const txt=clean(node.innerText||node.textContent||'');
          const code=txt.match(/(?:^|[\s,(])([A-Z]{3})(?=$|[\s,)])/);
          if(code&&!countryCode)countryCode=code[1];
        }

        return {countryCode,countryName,flagCode};
      }

      function playerInfo(a){
        return {
          name:clean(a.innerText||a.textContent||a.getAttribute('title')||a.getAttribute('aria-label')||''),
          href:a.href||'',
          ...countryFromPlayerLink(a)
        };
      }

      const playerAnchors=[...document.querySelectorAll('a[href]')]
        .filter(a=>playerHref.test(a.href||''));

      const players=[];
      const playerSeen=new Set();

      for(const a of playerAnchors){
        const p=playerInfo(a);
        if(!p.name||!p.href)continue;
        const key=p.href.split('#')[0];
        if(playerSeen.has(key))continue;
        playerSeen.add(key);
        players.push(p);
      }

      function contextualText(el){
        const bits=[];
        let cur=el;

        for(let d=0;d<7&&cur;d++,cur=cur.parentElement){
          const txt=clean(cur.innerText||cur.textContent||'');
          if(txt&&txt.length<1600&&(dateRe.test(txt)||timeRe.test(txt)||/round|group|pool|final|semi|quarter|plate|court|venue/i.test(txt))){
            bits.push(txt);
          }

          const head=cur.querySelector?.(
            ':scope > h1,:scope > h2,:scope > h3,:scope > h4,'+
            ':scope > [class*="round"],:scope > [class*="date"],'+
            ':scope > [class*="day"],:scope > [class*="group"],:scope > [class*="pool"]'
          );

          if(head){
            const t=clean(head.innerText||head.textContent||'');
            if(t)bits.push(t);
          }
        }

        let prev=el?.previousElementSibling,n=0;
        while(prev&&n++<10){
          const t=clean(prev.innerText||prev.textContent||'');
          if(t&&t.length<300&&(dateRe.test(t)||timeRe.test(t)||/round|group|pool|final|semi|quarter|plate|court|venue/i.test(t))){
            bits.push(t);
          }
          prev=prev.previousElementSibling;
        }

        return clean(bits.join(' | '));
      }

      const fixtureMap=new Map();

      function addFixture(container,source){
        if(!container)return;

        const links=[...container.querySelectorAll('a[href]')]
          .filter(a=>playerHref.test(a.href||''));

        const unique=[];
        const seen=new Set();

        for(const a of links){
          const p=playerInfo(a);
          if(!p.name||!p.href)continue;
          const key=p.href.split('#')[0];
          if(seen.has(key))continue;
          seen.add(key);
          unique.push(p);
        }

        if(unique.length!==2)return;

        const text=clean(container.innerText||container.textContent||'');
        const ctx=contextualText(container);
        const whole=clean(`${pageHead} ${ctx} ${text}`);

        if(!dateRe.test(whole)||!timeRe.test(whole))return;

        const scoreRows=[];
        for(const a of links){
          let row=a;
          for(let d=0;d<6&&row;d++,row=row.parentElement){
            const rowLinks=[...row.querySelectorAll('a[href]')].filter(x=>playerHref.test(x.href||''));
            if(rowLinks.length!==1)continue;

            const raw=clean(row.innerText||row.textContent||'');
            const nums=(raw.match(/(?:^|\s)(\d{1,2})(?=\s|$)/g)||[])
              .map(x=>Number(x.trim()))
              .filter(v=>v>=0&&v<=30);

            if(nums.length>=3&&nums.length<=6){
              scoreRows.push({
                href:a.href||'',
                name:clean(a.innerText||a.textContent||''),
                scores:nums.slice(-6)
              });
              break;
            }
          }
        }

        const key=unique.map(x=>x.href.split('#')[0]).sort().join('|')+'|'+whole.slice(0,1800);
        if(!fixtureMap.has(key)){
          fixtureMap.set(key,{players:unique,text,context:ctx,pageHead,scoreRows,source});
        }
      }

      const selectors=[
        'tbody tr','[role="row"]','[class*="match"]','[class*="fixture"]',
        '[class*="game"]','[class*="bracket"] [class*="item"]',
        '[class*="draw"] [class*="item"]','article','li'
      ];

      for(const sel of selectors){
        for(const el of document.querySelectorAll(sel))addFixture(el,sel);
      }

      // Bracket-aware pass: start at each player and ascend to the smallest
      // ancestor containing exactly two distinct players and fixture metadata.
      for(const a of playerAnchors){
        let cur=a.parentElement;
        for(let depth=0;depth<9&&cur;depth++,cur=cur.parentElement){
          const rawLinks=[...cur.querySelectorAll('a[href]')].filter(x=>playerHref.test(x.href||''));
          const ids=[...new Set(rawLinks.map(x=>(x.href||'').split('#')[0]).filter(Boolean))];

          if(ids.length===2){
            const whole=clean(`${contextualText(cur)} ${cur.innerText||cur.textContent||''}`);
            if(dateRe.test(whole)&&timeRe.test(whole)){
              addFixture(cur,'anchor-ascent');
              break;
            }
          }

          if(ids.length>2)break;
        }
      }

      // Sibling bracket cells: useful where each player is rendered in its own
      // cell and the fixture metadata lives on their common parent.
      for(const a of playerAnchors){
        const base=a.closest('td,li,div,span');
        if(!base||!base.parentElement)continue;

        const parent=base.parentElement;
        const parentLinks=[...parent.querySelectorAll('a[href]')].filter(x=>playerHref.test(x.href||''));
        const parentIds=[...new Set(parentLinks.map(x=>(x.href||'').split('#')[0]).filter(Boolean))];

        if(parentIds.length===2)addFixture(parent,'sibling-pair');
      }


      // DETERMINISTIC TOURNAMENTSOFTWARE TREE PARSER.
      //
      // Legacy TournamentSoftware brackets encode the tree directly in span IDs:
      //   6015 + 6016 -> 5008
      //   5007 + 5008 -> 4004
      //   ...
      //
      // The first digit is the tree level and the remaining digits are the slot.
      // Opponents are the odd/even sibling slots at the SAME level.
      // The winner/output slot is exactly (level-1, ceil(slot/2)).
      //
      // Example seen in the Men's +40 Plate DOM:
      //   Philip Taylor = slot 6015
      //   Julian Buczek = slot 6016
      //   their connector/output = 5008
      //
      // No pixel positions, nearest-neighbour logic or scoring are used.
      const treeMatches=[];

      function legacyPlayerFromCell(td){
        if(!td)return null;
        const links=[...td.querySelectorAll('a[href]')]
          .filter(a=>playerHref.test(a.href||''));

        for(const a of links){
          const p=playerInfo(a);
          if(p.name&&p.href)return p;
        }

        return null;
      }

      function textOfCell(td){
        return clean(td?.innerText||td?.textContent||'');
      }

      function tableHeaderForColumn(table,index){
        const rows=[...table.querySelectorAll('thead tr')];
        if(!rows.length)return '';
        const cells=[...rows[rows.length-1].children];
        return clean(cells[index]?.innerText||cells[index]?.textContent||'');
      }

      function extractLegacyTableTree(table){
        const tbody=table.tBodies?.[0];
        if(!tbody)return;

        const rows=[...tbody.rows];
        if(!rows.length)return;

        const caption=clean(table.caption?.innerText||table.caption?.textContent||'');
        const slotMap=new Map();

        for(let ri=0;ri<rows.length;ri++){
          const tr=rows[ri];

          for(const td of [...tr.cells]){
            for(const span of [...td.querySelectorAll('span[id]')]){
              const rawId=String(span.id||'');
              if(!/^\d{4}$/.test(rawId))continue;

              const num=Number(rawId);
              const level=Math.floor(num/1000);
              const slot=num%1000;

              if(level<1||slot<1)continue;

              const player=legacyPlayerFromCell(td);
              const isBye=!player&&/\bBye\b/i.test(textOfCell(td));

              // A slot carrying only venue/court metadata is an output/connector,
              // not a player occurrence.
              const rec={
                rawId,
                num,
                level,
                slot,
                rowIndex:ri,
                cellIndex:td.cellIndex,
                td,
                tr,
                span,
                player,
                isBye
              };

              // Within one table, TournamentSoftware's slot IDs are unique.
              // Prefer a participant-bearing occurrence if malformed duplicate IDs
              // ever appear.
              const old=slotMap.get(num);
              if(!old || ((!old.player&&!old.isBye)&&(player||isBye))){
                slotMap.set(num,rec);
              }
            }
          }
        }

        // Walk every odd/even input pair encoded by TournamentSoftware.
        // A slot without a player is allowed here because it can represent a
        // genuinely scheduled future match whose opponent has not been decided.
        const allSlots=[...slotMap.values()];

        for(const a of allSlots){
          // Process one side only: odd slot is paired with the following even slot.
          if(a.slot%2===0)continue;

          const bNum=a.level*1000+(a.slot+1);
          const b=slotMap.get(bNum);
          if(!b||b.level!==a.level)continue;

          // Both input slots must be in the same round/column.
          if(a.cellIndex!==b.cellIndex)continue;

          // Bye means no match is played. Two unresolved slots also prove nothing.
          if(a.isBye||b.isBye)continue;
          const concreteCount=(a.player?1:0)+(b.player?1:0);
          if(concreteCount===0)continue;

          const targetColumn=a.cellIndex+1;
          const lo=Math.min(a.rowIndex,b.rowIndex);
          const hi=Math.max(a.rowIndex,b.rowIndex);

          // Verify the exact TournamentSoftware tree connector.
          // For level N slots 2k-1 and 2k the output is level N-1 slot k.
          let outputId='';
          let outputRec=null;

          if(a.level>1){
            const outputNum=(a.level-1)*1000+Math.ceil(a.slot/2);
            outputId=String(outputNum);
            outputRec=slotMap.get(outputNum)||null;

            if(!outputRec)continue;
            if(outputRec.cellIndex!==targetColumn)continue;
            if(outputRec.rowIndex<lo||outputRec.rowIndex>hi)continue;
          }

          // Date/time/venue/court for this exact tree edge live in the next-round
          // column between the two input rows. Read ONLY that structural block.
          const metaParts=[];

          for(let ri=lo;ri<=hi;ri++){
            const cell=rows[ri]?.cells?.[targetColumn];
            if(!cell)continue;
            const t=textOfCell(cell);
            if(t)metaParts.push(t);
          }

          const round=tableHeaderForColumn(table,a.cellIndex);
          const meta=clean(metaParts.join(' | '));
          const context=clean(`${caption} | ${round} | ${meta}`);

          // Concrete pair: normal deterministic fixture.
          if(concreteCount===2){
            treeMatches.push({
              players:[a.player,b.player],
              text:meta,
              context,
              pageHead,
              source:'legacy-slot-tree',
              tableCaption:caption,
              round,
              inputSlot1:a.rawId,
              inputSlot2:b.rawId,
              outputSlot:outputId,
              tbd:false
            });
            continue;
          }

          // Exactly one concrete player + one unresolved sibling is a real
          // scheduled TBD match only when TournamentSoftware itself prints the
          // full schedule metadata for this exact tree edge. No nearby/fuzzy text.
          const hasDate=dateRe.test(meta);
          const hasTime=timeRe.test(meta);
          const hasVenue=/\b(?:Squashworld\s+Mirrabooka|Belmont\s+Saints\s+Squash\s+Centre|Karrinyup\s+Shopping\s+Centre)\b/i.test(meta);
          const hasCourt=/\b(?:AGC(?:\s*\d+)?|SC\s*\d+|Court\s*\d+)\b/i.test(meta);
          if(!hasDate||!hasTime||!hasVenue||!hasCourt)continue;

          treeMatches.push({
            players:[a.player||b.player],
            text:meta,
            context,
            pageHead,
            source:'legacy-slot-tree-tbd',
            tableCaption:caption,
            round,
            inputSlot1:a.rawId,
            inputSlot2:b.rawId,
            outputSlot:outputId,
            unresolvedSlot:a.player?b.rawId:a.rawId,
            tbd:true
          });
        }
      }

      const legacyTables=[...new Set([
        ...document.querySelectorAll('div.draw table'),
        ...document.querySelectorAll('table')
      ])];

      for(const table of legacyTables){
        const hasLegacySlots=table.querySelector('span[id].entry,span[id].match');
        if(hasLegacySlots)extractLegacyTableTree(table);
      }

      // Modern TournamentSoftware renderer: the exact pair is explicitly grouped
      // in a .match__row-wrapper. Keep this deterministic too.
      for(const wrapper of document.querySelectorAll('.match__row-wrapper')){
        const links=[...wrapper.querySelectorAll('a[href]')]
          .filter(a=>playerHref.test(a.href||''));

        const unique=[];
        const seen=new Set();

        for(const a of links){
          const href=String(a.href||'').split('#')[0];
          if(!href||seen.has(href))continue;
          seen.add(href);
          unique.push(a);
        }

        if(unique.length<1||unique.length>2)continue;

        const p1=playerInfo(unique[0]);
        const p2=unique.length===2?playerInfo(unique[1]):null;
        if(!p1.name||(p2&&!p2.name))continue;

        // `.match` is the renderer's explicit match container. If unavailable,
        // use the wrapper's direct parent only; do not ascend heuristically.
        const container=wrapper.closest('.match')||wrapper.parentElement;
        if(!container)continue;

        const context=clean(container.innerText||container.textContent||'');

        if(unique.length===1){
          const hasDate=dateRe.test(context);
          const hasTime=timeRe.test(context);
          const hasVenue=/\b(?:Squashworld\s+Mirrabooka|Belmont\s+Saints\s+Squash\s+Centre|Karrinyup\s+Shopping\s+Centre)\b/i.test(context);
          const hasCourt=/\b(?:AGC(?:\s*\d+)?|SC\s*\d+|Court\s*\d+)\b/i.test(context);
          if(!hasDate||!hasTime||!hasVenue||!hasCourt)continue;
        }

        treeMatches.push({
          players:p2?[p1,p2]:[p1],
          text:context,
          context,
          pageHead,
          source:p2?'modern-match-wrapper':'modern-match-wrapper-tbd',
          tableCaption:'',
          round:'',
          tbd:!p2
        });
      }

      // Lightweight DOM evidence for tracked-player diagnostics.
      const structuralDiagnostics=new Map();
      for(const a of playerAnchors){
        const p=playerInfo(a);
        const thisId=String(a.href||'').split('#')[0];
        if(!p.name||!thisId)continue;

        const parent=a.closest('td,.match__row');
        const marker=parent?.querySelector?.('span[id].entry,span[id].match');

        structuralDiagnostics.set(thisId,{
          name:p.name,
          href:thisId,
          slotId:marker?.id||'',
          parentTag:String(parent?.tagName||'').toLowerCase(),
          parentClass:clean(parent?.className||''),
          parentText:clean(parent?.innerText||parent?.textContent||'').slice(0,1000)
        });
      }

      const matchLinks=[];
      const matchSeen=new Set();

      for(const a of document.querySelectorAll('a[href]')){
        const href=String(a.href||'');
        if(!href)continue;

        let u;
        try{u=new URL(href,location.href)}catch{continue}

        const path=u.pathname.toLowerCase();
        const keys=[...u.searchParams.keys()].map(x=>x.toLowerCase());

        const looksLikeMatch=
          /\/sport\/match/i.test(path) ||
          /\/match(?:\.aspx)?$/i.test(path) ||
          keys.some(k=>/^(match|matchid|game|fixture|result)$/.test(k));

        if(!looksLikeMatch)continue;

        u.hash='';
        const key=u.href;
        if(matchSeen.has(key))continue;
        matchSeen.add(key);

        matchLinks.push({
          href:key,
          text:clean(a.innerText||a.textContent||a.getAttribute('title')||a.getAttribute('aria-label')||'')
        });
      }

      const positionedPlayers=[];
      for(const a of playerAnchors){
        const p=playerInfo(a);
        if(!p.name||!p.href)continue;
        const r=a.getBoundingClientRect();
        if(!r||!Number.isFinite(r.left)||!Number.isFinite(r.top))continue;
        positionedPlayers.push({
          ...p,
          left:r.left+window.scrollX,
          top:r.top+window.scrollY,
          width:r.width,
          height:r.height,
          centerX:r.left+window.scrollX+r.width/2,
          centerY:r.top+window.scrollY+r.height/2
        });
      }

      const nearbyText=[];
      const textSelectors=[
        'td','th','div','span','li','p','time','strong','small',
        '[class*="date"]','[class*="time"]','[class*="court"]',
        '[class*="venue"]','[class*="round"]','[class*="score"]',
        '[class*="result"]'
      ];

      const textSeen=new Set();
      for(const el of document.querySelectorAll(textSelectors.join(','))){
        if(el.querySelector?.('a[href]'))continue;
        const text=clean(el.innerText||el.textContent||'');
        if(!text||text.length>180)continue;
        const locationText=
          /\b(?:Squashworld\s+Mirrabooka|Belmont\s+Saints\s+Squash\s+Centre|Karrinyup\s+Shopping\s+Centre)\b/i.test(text) ||
          /\b(?:AGC(?:\s*\d+)?|SC\s*\d+|Court\s*\d+)\b/i.test(text);

        if(!(
          dateRe.test(text)||
          timeRe.test(text)||
          locationText||
          /court|venue|round|final|semi|quarter|plate|group|pool|^\d{1,2}$|^\d{1,2}\s*[-:]\s*\d{1,2}$/i.test(text)
        ))continue;

        const r=el.getBoundingClientRect();
        if(!r||r.width===0||r.height===0)continue;

        const key=`${Math.round(r.left)}|${Math.round(r.top)}|${text}`;
        if(textSeen.has(key))continue;
        textSeen.add(key);

        nearbyText.push({
          text,
          left:r.left+window.scrollX,
          top:r.top+window.scrollY,
          width:r.width,
          height:r.height,
          centerX:r.left+window.scrollX+r.width/2,
          centerY:r.top+window.scrollY+r.height/2
        });
      }

      const locationTextNodes=nearbyText.filter(x=>
        /(?:Squashworld\s+Mirrabooka|Belmont\s+Saints\s+Squash\s+Centre|Karrinyup\s+Shopping\s+Centre)/i.test(x.text||'') ||
        /(?:AGC(?:\s*\d+)?|SC\s*\d+|Court\s*\d+)/i.test(x.text||'')
      ).length;

      return {
        body:clean(document.body?.innerText||document.documentElement?.innerText||''),
        pageHead,
        players,
        fixtures:[...fixtureMap.values()],
        treeMatches,
        structuralDiagnostics:[...structuralDiagnostics.entries()],
        matchLinks,
        positionedPlayers,
        nearbyText,
        locationTextNodes
      };
    });
  }


  function expectedPlayersForDraw(draw){
    const canonical=Array.isArray(options.canonicalPlayers)?options.canonicalPlayers:[];
    if(!canonical.length)return 0;

    const text=clean(draw?.text||'');
    const ageMatch=text.match(/\b(35|40|45|50|55|60|65|70|75|80|85)\+?\b/);
    const age=ageMatch?Number(ageMatch[1]):0;

    let gender='';
    if(/women/i.test(text))gender='women';
    else if(/\bmen/i.test(text))gender='men';

    // Placement/3rd-place draws are intentionally tiny and should not inherit
    // the full age-group expectation.
    if(/3\/4\s*Place|3\/4-?Place|placement|playoff/i.test(text))return 0;
    if(!age||!gender)return 0;

    const normalGender=v=>{
      const s=clean(v||'').toLowerCase();
      if(/women|woman|female|\bf\b/.test(s))return 'women';
      if(/men|man|male|\bm\b/.test(s))return 'men';
      return '';
    };

    return canonical.filter(p=>
      Number(p.ageGroup||0)===age &&
      normalGender(p.gender)===gender
    ).length;
  }

  async function crawlDraw(draw,page){
    const isPlacement=/3\/4\s*Place|3\/4-?Place|placement|playoff/i.test(clean(draw.text||''));
    const expectedPlayers=expectedPlayersForDraw(draw);
    const attempts=[];

    const targetMin=expectedPlayers
      ? Math.max(2,Math.floor(expectedPlayers*0.90))
      : 0;

    const completeEnough=x=>{
      const players=x.players?.length||0;
      const boxes=x.positionedPlayers?.length||0;

      if(isPlacement)return players>=2;
      if(targetMin&&players<targetMin)return false;

      // A healthy bracket normally contains at least one positioned rendering
      // for every unique player, often many more due to later-round repeats.
      if(players>=6&&boxes<players)return false;

      return players>0;
    };

    // Up to four full renders. TournamentSoftware sometimes paints a partial
    // bracket even though the page itself has finished loading.
    for(let attemptNo=1;attemptNo<=4;attemptNo++){
      if(attemptNo>1){
        await page.reload({waitUntil:'domcontentloaded',timeout:60000});
        await sleep(350);
      }

      const extracted=await crawlDrawOnce(draw,page);
      extracted.attempt=attemptNo;
      attempts.push(extracted);

      if(completeEnough(extracted))break;
    }

    const richness=x=>{
      const players=x.players?.length||0;
      const boxes=x.positionedPlayers?.length||0;
      const inline=x.fixtures?.length||0;
      const links=x.matchLinks?.length||0;
      const loc=x.locationTextNodes||0;

      // Unique player coverage dominates. This prevents a visually "busy"
      // partial render from winning over a complete age-group draw.
      return players*1000000 + boxes*1000 + inline*100 + loc*10 + links;
    };

    attempts.sort((a,b)=>richness(b)-richness(a));
    const best=attempts[0];

    if(attempts.length>1 || (targetMin && (best.players?.length||0)<targetMin)){
      console.log(
        `    ${draw.text||'Draw'} render attempts: `+
        attempts.map(x=>
          `#${x.attempt}:${x.players?.length||0} players/${x.positionedPlayers?.length||0} boxes`
        ).join(', ')+
        ` -> using #${best.attempt}`+
        (expectedPlayers?` (known player minimum ${expectedPlayers}, retry floor ${targetMin})`:'')
      );
    }

    if(!isPlacement && targetMin && (best.players?.length||0)<targetMin){
      throw new Error(
        `${draw.text||'Draw'} remained incomplete after ${attempts.length} render attempt(s): `+
        `${best.players?.length||0} unique players found, known player minimum ${expectedPlayers}.`
      );
    }

    return best;
  }

  async function worker(workerNo){
    const page=await context.newPage();

    while(queue.length){
      const draw=queue.shift();
      const started=Date.now();

      try{
        const extracted=await crawlDraw(draw,page);
        workerResults.push({draw,extracted});

        const expected=expectedPlayersForDraw(draw);
        console.log(
          `  Draw ${draw.index+1}/${drawLinks.length} ${draw.text||''}: `+
          `${extracted.players.length}${expected?`/${expected} known-minimum`:''} players, `+
          `${extracted.positionedPlayers?.length||0} positioned player box(es), `+
          `${extracted.treeMatches?.length||0} deterministic tree match(es), `+
          `${extracted.fixtures.length} inline candidate(s), `+
          `${extracted.matchLinks?.length||0} official match link(s), `+
          `${extracted.locationTextNodes||0} location text node(s) `+
          `(${((Date.now()-started)/1000).toFixed(1)}s)`
        );
      }catch(e){
        failed++;
        console.warn(`  Draw ${draw.index+1}/${drawLinks.length} failed: ${e.message.split('\n')[0]}`);
      }
    }

    await page.close();
  }

  await Promise.all(Array.from({length:DRAW_WORKERS},(_,i)=>worker(i+1)));

  if(options.debugStructure){
    const tracked=loadTrackedNames();
    const debugRows=[];

    for(const wr of workerResults){
      for(const [href,diag] of wr.extracted.structuralDiagnostics||[]){
        const name=clean(diag?.name||'');
        if(!tracked.some(n=>sameName(n,name)))continue;

        debugRows.push({
          drawIndex:Number(wr.draw.index)+1,
          drawName:wr.draw.text||'',
          drawUrl:wr.draw.href||'',
          officialPlayerId:hrefKey(href),
          ...diag
        });
      }
    }

    const debugFile=path.join(DIR,'draw-structure-debug.json');
    fs.writeFileSync(debugFile,JSON.stringify({
      generatedAt:new Date().toISOString(),
      tournamentId:ID,
      note:'Exact DOM ancestry/sibling evidence from TournamentSoftware draw pages. No opponent inference is performed here.',
      rows:debugRows
    },null,2),'utf8');

    console.log(`DRAW DEBUG wrote ${debugRows.length} tracked-player DOM occurrence(s) to ${debugFile}`);
  }



  const matchLinkMap=new Map();
  for(const row of workerResults){
    for(const m of row.extracted.matchLinks||[]){
      if(!matchLinkMap.has(m.href)){
        matchLinkMap.set(m.href,{...m,draw:row.draw});
      }
    }
  }

  const officialMatchLinks=[...matchLinkMap.values()];
  const exactMatchRows=[];
  let matchPageFailures=0;

  console.log(`Official draw match/detail links discovered: ${officialMatchLinks.length}`);

  async function scrapeExactMatchPage(page,item){
    await safeGoto(page,item.href,2);
    await dismissPopups(page);
    await sleep(100);

    return page.evaluate(()=>{
      const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
      const playerHref=/player|participant|person|profile/i;

      const body=clean(document.body?.innerText||document.documentElement?.innerText||'');

      const playerLinks=[...document.querySelectorAll('a[href]')]
        .filter(a=>playerHref.test(a.href||''))
        .map(a=>({
          name:clean(a.innerText||a.textContent||a.getAttribute('title')||a.getAttribute('aria-label')||''),
          href:a.href||''
        }));

      const players=[];
      const seen=new Set();
      for(const p of playerLinks){
        if(!p.name||!p.href)continue;
        const key=p.href.split('#')[0];
        if(seen.has(key))continue;
        seen.add(key);
        players.push(p);
      }

      const scoreRows=[];
      for(const a of document.querySelectorAll('a[href]')){
        if(!playerHref.test(a.href||''))continue;
        let row=a;

        for(let depth=0;depth<7&&row;depth++,row=row.parentElement){
          const rowPlayers=[...row.querySelectorAll('a[href]')]
            .filter(x=>playerHref.test(x.href||''));

          if(rowPlayers.length!==1)continue;

          const raw=clean(row.innerText||row.textContent||'');
          const nums=(raw.match(/(?:^|\s)(\d{1,2})(?=\s|$)/g)||[])
            .map(x=>Number(x.trim()))
            .filter(v=>v>=0&&v<=30);

          if(nums.length>=3&&nums.length<=6){
            scoreRows.push({
              href:a.href||'',
              name:clean(a.innerText||a.textContent||''),
              scores:nums.slice(-6)
            });
            break;
          }
        }
      }

      let venue='',court='';
      const vm=body.match(
        /\b(Squashworld\s+Mirrabooka|Belmont\s+Saints\s+Squash\s+Centre|Karrinyup\s+Shopping\s+Centre)\b/i
      );
      const cm=body.match(/\b(AGC(?:\s*\d+)?|SC\s*\d+|Court\s*\d+)\b/i);
      if(vm)venue=vm[1];
      if(cm)court=cm[1];

      return {
        body,players,scoreRows,title:document.title||'',
        venue,court
      };
    });
  }

  if(!options.skipMatchPages && officialMatchLinks.length){
    const MATCH_WORKERS=Math.max(1,Math.min(12,Number(process.env.MATCH_WORKERS||8)));
    const matchQueue=officialMatchLinks.map((x,i)=>({...x,index:i}));

    console.log(`Crawling ${officialMatchLinks.length} official match pages with ${MATCH_WORKERS} browser workers...`);

    async function matchWorker(workerNo){
      const page=await context.newPage();

      while(matchQueue.length){
        const item=matchQueue.shift();

        try{
          const row=await scrapeExactMatchPage(page,item);
          exactMatchRows.push({item,row});
        }catch(e){
          matchPageFailures++;
          if(matchPageFailures<=10){
            console.warn(`  Match page failed: ${item.href} - ${e.message.split('\n')[0]}`);
          }
        }
      }

      await page.close();
    }

    await Promise.all(Array.from({length:MATCH_WORKERS},(_,i)=>matchWorker(i+1)));
    console.log(`Official match pages crawled: ${exactMatchRows.length}/${officialMatchLinks.length} (${matchPageFailures} failures).`);
    const matchDetailLocationCount=exactMatchRows.filter(x=>x.row?.venue&&x.row?.court).length;
    console.log(
      `Official match-detail location coverage: ${matchDetailLocationCount}/${exactMatchRows.length}.`
    );
  }

  const playerMap=new Map();
  const observations=[];

  const eventIdentityFromText=text=>{
    const s=clean(text);
    const age=(s.match(/\b(35|40|45|50|55|60|65|70|75|80|85)\+?\b/)||[])[1]||'';
    const gender=/women/i.test(s)?'Women':(/\bmen/i.test(s)?'Men':'');
    return {ageGroup:age?Number(age):'',gender};
  };

  const upsertPlayer=raw=>{
    const id=String(raw.officialPlayerId||'');
    if(!id)return null;

    const old=playerMap.get(id);
    if(!old){
      playerMap.set(id,{...raw});
      return playerMap.get(id);
    }

    for(const k of ['name','officialProfileUrl','country','iso3','flagCode','drawCountryCode','gender','ageGroup']){
      if((old[k]===undefined||old[k]===null||old[k]==='') && raw[k]!==undefined && raw[k]!==null && raw[k]!==''){
        old[k]=raw[k];
      }
    }

    return old;
  };

  for(const row of workerResults){
    const drawContext=clean(`${row.draw.text||''} ${row.extracted.pageHead||''}`);
    const eventInfo=eventIdentityFromText(drawContext);

    for(const p of row.extracted.players||[]){
      const id=String(hrefKey((p.href||'').split('#')[0])||'');
      if(!id||!p.name)continue;

      const country=drawCountryMeta(p.countryCode,p.countryName,p.flagCode);

      upsertPlayer({
        name:splitPlayerSeed(p.name).name,
        seed:splitPlayerSeed(p.name).seed,
        officialPlayerId:id,
        officialProfileUrl:(p.href||'').split('#')[0],
        ageGroup:eventInfo.ageGroup,
        gender:eventInfo.gender,
        country:country.country,
        iso3:country.iso3,
        flagCode:country.flagCode,
        drawCountryCode:country.drawCountryCode
      });
    }
  }


  // DETERMINISTIC DRAW TREE EXTRACTION.
  //
  // `treeMatches` already contains exact opponent relationships from either:
  //   - legacy TournamentSoftware numeric bracket slot IDs; or
  //   - modern `.match__row-wrapper` groups.
  //
  // This stage only parses metadata; it never chooses opponents.
  const treeObservations=[];

  for(const row of workerResults){
    const drawContext=clean(`${row.draw.text||''} ${row.extracted.pageHead||''}`);

    for(const t of row.extracted.treeMatches||[]){
      const unique=[];

      for(const p of t.players||[]){
        const id=String(hrefKey((p.href||'').split('#')[0])||'');
        if(!id||!playerMap.has(id))continue;
        if(unique.some(x=>x.id===id))continue;
        unique.push({id,player:playerMap.get(id)});
      }

      if(unique.length!==2 && !(t.tbd&&unique.length===1))continue;

      const whole=clean(`${drawContext} ${t.context||''} ${t.text||''}`);
      const f=deriveFields(whole,drawContext);

      if(!f.date||!f.time||!isTournamentDate(f.date))continue;

      // Caption/round are structural labels from the table itself.
      if(!f.round&&t.round)f.round=clean(t.round);

      const isTbd=!!t.tbd&&unique.length===1;
      if(isTbd){
        // TBD fixtures are useful only for current/future scheduling and must
        // be fully explicit in the draw itself.
        if(canonicalTournamentDate(f.date)<perthTodayIsoRefresh())continue;
        if(!f.venue||!sanitizeCourtValue(f.court))continue;
      }

      treeObservations.push({
        ...f,
        player1:unique[0].player.name,
        player1Id:unique[0].id,
        player2:isTbd?'TBD':unique[1].player.name,
        player2Id:isTbd?'':unique[1].id,
        result:isTbd?'':(f.result||''),
        status:isTbd?'scheduled':(f.result?'completed':(f.status||'scheduled')),
        rawText:whole,
        source:'TournamentSoftware Draw Tree',
        sourceUrl:row.draw.href,
        treeSource:t.source||'',
        treeCaption:t.tableCaption||'',
        treeInputSlot1:t.inputSlot1||'',
        treeInputSlot2:t.inputSlot2||'',
        treeOutputSlot:t.outputSlot||'',
        treeUnresolvedSlot:t.unresolvedSlot||'',
        deterministicTbd:isTbd
      });
    }
  }

  console.log(`Official draw deterministic tree observations: ${treeObservations.length}`);
  observations.push(...treeObservations);
  const deterministicTbdObservations=treeObservations.filter(m=>m.deterministicTbd);
  console.log(`Official draw deterministic TBD fixtures: ${deterministicTbdObservations.length}`);
  const trackedTbdAuditNames=loadTrackedNames();
  const trackedDeterministicTbd=deterministicTbdObservations.filter(m=>
    trackedTbdAuditNames.some(n=>sameName(m.player1,n)||sameName(m.player2,n))
  );
  console.log(`Tracked deterministic TBD fixtures: ${JSON.stringify(
    trackedDeterministicTbd.map(m=>({
      date:m.date,time:m.time,player1:m.player1,player2:m.player2,
      venue:m.venue||'',court:m.court||'',round:m.round||'',
      inputSlots:[m.treeInputSlot1||'',m.treeInputSlot2||''],
      outputSlot:m.treeOutputSlot||''
    }))
  )}`);


  const treeMerged=officialScheduleMerge(treeObservations);
  const treeByPlayer=new Map();

  for(const m of treeMerged){
    for(const side of [
      {id:String(m.player1Id||''),name:m.player1},
      {id:String(m.player2Id||''),name:m.player2}
    ]){
      const key=side.id||nameKey(side.name);
      if(!key)continue;
      if(!treeByPlayer.has(key))treeByPlayer.set(key,[]);
      treeByPlayer.get(key).push(m);
    }
  }

  const trackedAuditNames=loadTrackedNames();
  for(const p of [...playerMap.values()].filter(p=>trackedAuditNames.some(n=>sameName(n,p.name)))){
    const rows=treeByPlayer.get(String(p.officialPlayerId||''))||[];

    const slotEvidence=[];
    for(const wr of workerResults){
      for(const [href,d] of wr.extracted.structuralDiagnostics||[]){
        if(String(hrefKey(href)||'')!==String(p.officialPlayerId||''))continue;
        if(d?.slotId){
          slotEvidence.push({
            draw:wr.draw.text||'',
            slotId:d.slotId,
            parentText:d.parentText||''
          });
        }
      }
    }

    console.log(
      `Draw tree path ${p.name}: ${rows.length} deterministic match(es) -> `+
      JSON.stringify(rows.map(m=>({
        date:m.date,time:m.time,
        opponent:sameName(m.player1,p.name)?m.player2:m.player1,
        venue:m.venue||'',court:m.court||'',round:m.round||'',
        inputSlots:[m.treeInputSlot1||'',m.treeInputSlot2||''],
        outputSlot:m.treeOutputSlot||'',
        treeSource:m.treeSource||'',
        deterministicTbd:!!m.deterministicTbd
      })))+
      (rows.length?'':` | slotEvidence=${JSON.stringify(slotEvidence.slice(0,6))}`)
    );
  }


  // The deterministic tree is now the only draw source allowed to
  // create concrete current/future fixtures. Do not manufacture tracked-player
  // TBD fixtures by scanning flattened draw text.
  const trackedTbdMatches=[];

  // Exact TournamentSoftware match pages enrich the draw-derived schedule where available.
  for(const x of exactMatchRows){
    const drawContext=clean(`${x.item.draw?.text||''} ${x.row.title||''}`);
    const whole=clean(`${drawContext} ${x.row.body||''}`);
    const f=deriveFields(whole,drawContext);

    if(x.row.venue)f.venue=clean(x.row.venue);
    if(x.row.court)f.court=sanitizeCourtValue(x.row.court);

    if(!f.date||!f.time||!isTournamentDate(f.date))continue;

    const linked=[];
    const seenIds=new Set();

    for(const p of x.row.players||[]){
      const id=String(hrefKey((p.href||'').split('#')[0])||'');
      if(!id||seenIds.has(id))continue;

      const existing=playerMap.get(id);
      if(!existing)continue;

      seenIds.add(id);
      linked.push(existing);
    }

    if(linked.length!==2)continue;
    if(String(linked[0].officialPlayerId)===String(linked[1].officialPlayerId))continue;

    let result=f.result||'';

    if(!result&&Array.isArray(x.row.scoreRows)&&x.row.scoreRows.length>=2){
      const scoreFor=p=>{
        const scoreRow=x.row.scoreRows.find(r=>String(hrefKey(r.href)||'')===String(p.officialPlayerId)) ||
          x.row.scoreRows.find(r=>sameName(r.name,p.name));

        if(!scoreRow)return [];

        let a=(scoreRow.scores||[]).map(Number).filter(Number.isFinite);
        if(a.length===6&&a[0]>=0&&a[0]<=3)a=a.slice(1);
        return a;
      };

      let a=scoreFor(linked[0]),b=scoreFor(linked[1]);

      while(a.length&&b.length&&a.at(-1)===0&&b.at(-1)===0){
        a.pop();b.pop();
      }

      const valid=(m,n)=>{
        if(!Number.isInteger(m)||!Number.isInteger(n)||m<0||n<0||m>30||n>30||m===n)return false;
        const hi=Math.max(m,n),lo=Math.min(m,n);
        return hi>=11&&(hi===11?lo<=9:hi-lo===2);
      };

      if(a.length>=3&&a.length<=5&&a.length===b.length&&a.every((m,i)=>valid(m,b[i]))){
        result=a.map((m,i)=>`${m}-${b[i]}`).join(', ');
      }
    }

    observations.push({
      ...f,
      player1:linked[0].name,
      player1Id:linked[0].officialPlayerId,
      player2:linked[1].name,
      player2Id:linked[1].officialPlayerId,
      result,
      status:result?'completed':(f.status||'scheduled'),
      rawText:whole,
      source:'TournamentSoftware Match',
      sourceUrl:x.item.href
    });
  }

  // Inline bracket rows are fallback only.
  for(const row of workerResults){
    const drawContext=clean(`${row.draw.text||''} ${row.extracted.pageHead||''}`);

    for(const c of row.extracted.fixtures||[]){
      const whole=clean(`${drawContext} ${c.context||''} ${c.text||''}`);
      const f=deriveFields(whole,drawContext);

      if(!f.date||!f.time||!isTournamentDate(f.date))continue;

      const linked=[];
      const seenIds=new Set();

      for(const p of c.players||[]){
        const id=String(hrefKey((p.href||'').split('#')[0])||'');
        if(!id||seenIds.has(id))continue;

        const existing=playerMap.get(id);
        if(!existing)continue;

        seenIds.add(id);
        linked.push(existing);
      }

      if(linked.length!==2)continue;
      if(String(linked[0].officialPlayerId)===String(linked[1].officialPlayerId))continue;

      observations.push({
        ...f,
        player1:linked[0].name,
        player1Id:linked[0].officialPlayerId,
        player2:linked[1].name,
        player2Id:linked[1].officialPlayerId,
        result:f.result||'',
        status:f.result?'completed':(f.status||'scheduled'),
        rawText:whole,
        source:'TournamentSoftware Draw Inline',
        sourceUrl:row.draw.href
      });
    }
  }

  const matches=officialScheduleMerge(observations);
  const players=[...playerMap.values()].sort((a,b)=>a.name.localeCompare(b.name));

  const rawFixtureCandidates=workerResults.reduce(
    (n,x)=>n+(x.extracted.fixtures?.length||0),0
  );
  const rawMatchLinks=officialMatchLinks.length;

  const treeDrawStats=workerResults.map(x=>{
    const placement=/3\/4\s*Place|3\/4-?Place|placement|playoff/i.test(clean(x.draw.text||''));
    return {
      drawIndex:Number(x.draw.index)+1,
      drawName:x.draw.text||'',
      placement,
      players:x.extracted.players?.length||0,
      positionedPlayers:x.extracted.positionedPlayers?.length||0,
      deterministicTreeMatches:x.extracted.treeMatches?.length||0
    };
  });

  const mainTreeDraws=treeDrawStats.filter(x=>!x.placement&&x.players>2);
  const missingTreeDraws=mainTreeDraws.filter(x=>x.deterministicTreeMatches===0);

  console.log(`Official draw players: ${players.length} unique players from draw entries.`);
  console.log(`Official draw player metadata: ${players.filter(p=>p.country).length} country, ${players.filter(p=>p.flagCode).length} flag, ${players.filter(p=>p.ageGroup).length} age-group, ${players.filter(p=>p.gender).length} gender.`);
  console.log(`Official draw inline fixture candidates: ${rawFixtureCandidates}`);
  console.log(`Official draw deterministic tree observations: ${treeObservations.length}`);
  console.log(`Official draw match/detail links: ${rawMatchLinks}`);
  console.log(`Official draw schedule: ${matches.length} unique player-v-player fixtures from ${observations.length} validated fixture observations (${failed} draw page failures, ${matchPageFailures} match-page failures).`);

  return {
    players,
    matches,
    drawLinks:drawLinks.length,
    failed,
    matchPageFailures,
    rawFixtureCandidates,
    rawMatchLinks,
    treeObservations:treeObservations.length,
    treeDrawStats,
    mainTreeDraws:mainTreeDraws.length,
    missingTreeDraws,
    trackedTbdMatches
  };
}

function augmentOfficialScheduleWithProfileResults(schedule,observations){
  const out=(schedule||[]).map(m=>({...m}));
  const pair=m=>{
    const ids=[String(m.player1Id||''),String(m.player2Id||'')].filter(Boolean).sort();
    return ids.length===2?ids.join('~'):[nameKey(m.player1),nameKey(m.player2)].sort().join('~');
  };
  const date=m=>canonicalTournamentDate(m.date);
  const time=m=>clean(m.time).toLowerCase();

  for(const obs of observations||[]){
    if(!obs.result&&String(obs.status||'').toLowerCase()!=='completed')continue;
    const same=out.filter(m=>date(m)===date(obs)&&pair(m)===pair(obs));
    let target=null;
    const timed=same.filter(m=>time(m)===time(obs));
    if(timed.length===1)target=timed[0];
    else if(same.length===1)target=same[0];
    if(!target)continue;

    // Profile pages may enrich a draw fixture with result/status only.
    // They can never create or alter the official schedule.
    if(obs.result&&(!target.result||clean(obs.result).length>clean(target.result).length))target.result=obs.result;
    if(String(obs.status||'').toLowerCase()==='completed')target.status='completed';
  }
  return out;
}

async function openMatchesArea(page){
  // Player profile pages differ between old and modern TournamentSoftware layouts.
  // Click a Matches/Results/Schedule tab when present, but do not require one.
  for(const rx of [/^matches$/i,/^results$/i,/schedule/i,/fixtures/i]){
    for(const role of ['link','button','tab']){
      try{const loc=page.getByRole(role,{name:rx}).first();if(await loc.count()&&await loc.isVisible()){await loc.click({timeout:1200});await sleep(500);return}}catch{}
    }
  }
}

async function extractProfileCandidates(page){
  const all=[];
  for(const frame of page.frames()){
    try{
      const rows=await frame.evaluate(()=>{
        const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
        const dateRe=/(?:\b2026[-\/.]\d{1,2}[-\/.]\d{1,2}\b|\b\d{1,2}[\/.-]\d{1,2}[\/.-]2026\b|\b\d{1,2}\s+(?:Aug(?:ust)?|Sep(?:tember)?)\b|\b(?:Aug(?:ust)?|Sep(?:tember)?)\s+\d{1,2}\b|\b(?:Sun(?:day)?|Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?)\s*,?\s*(?:30|31|[1-6])\b)/i;
        const timeRe=/\b\d{1,2}:[0-5]\d\s*(?:am|pm)?\b/i;
        const playerHref=/player|participant|person|profile/i;
        const out=[],seen=new Set();
        const sels=['tbody tr','[role="row"]','article','li','[class*="match"]','[class*="fixture"]','[class*="schedule"]','[class*="result"]','[data-testid*="match"]'];
        function contextFor(el){
          let bits=[]; let cur=el;
          for(let depth=0;depth<5&&cur;depth++,cur=cur.parentElement){
            const h=cur.querySelector&&cur.querySelector(':scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > [class*="date"],:scope > [class*="day"]');
            if(h)bits.push(clean(h.innerText));
          }
          let prev=el.previousElementSibling, n=0;
          while(prev&&n++<8){const t=clean(prev.innerText);if(t.length<260&&(dateRe.test(t)||/round|men|women|court|venue/i.test(t)))bits.push(t);prev=prev.previousElementSibling}
          // Date headings are often outside the row's immediate parent. Walk backwards in document order
          // and take the nearest short element containing a tournament date.
          if(!bits.some(x=>dateRe.test(x))){
            const all=[...document.querySelectorAll('h1,h2,h3,h4,h5,h6,time,[datetime],[class*="date"],[class*="day"],th,caption')];
            for(let i=all.length-1;i>=0;i--){
              const x=all[i];
              if(!(x.compareDocumentPosition(el)&Node.DOCUMENT_POSITION_FOLLOWING)) continue;
              const t=clean(x.innerText||x.getAttribute('datetime')||'');
              if(t.length<220&&dateRe.test(t)){bits.push(t);break}
            }
          }
          return bits.join(' | ');
        }
        function add(el,source){
          if(!el)return; const text=clean(el.innerText); if(!text||text.length>2200)return;
          if(!(timeRe.test(text)||dateRe.test(text)))return;
          const links=[...el.querySelectorAll('a[href]')].map(a=>({text:clean(a.innerText||a.getAttribute('aria-label')||a.getAttribute('title')||''),href:a.href}));
          const players=links.filter(x=>playerHref.test(x.href));

          // Completed matches on the modern TournamentSoftware player page render
          // game scores as two separate numeric rows, e.g.
          //   Francisco Cortes  9 15 11 11
          //   Roger Schmidlin  11 13 6 5
          // rather than text such as "11-9 13-15 ...".
          // Capture each player link's nearest row-like ancestor and its standalone
          // numeric score cells so candidateToMatch() can pair them game-by-game.
          const scoreRows=[];
          for(const a of el.querySelectorAll('a[href]')){
            if(!playerHref.test(a.href))continue;
            let row=a;
            for(let depth=0;depth<6&&row;depth++,row=row.parentElement){
              const rowLinks=[...row.querySelectorAll('a[href]')].filter(x=>playerHref.test(x.href));
              if(rowLinks.length!==1)continue;

              const numeric=[];
              const nodes=[...row.querySelectorAll('td,th,[role="cell"],span,div')];
              for(const n of nodes){
                if(n.children.length>0 && !/^(TD|TH)$/i.test(n.tagName))continue;
                const t=clean(n.innerText||n.textContent||'');
                if(!/^\d{1,2}$/.test(t))continue;
                const v=Number(t);
                if(v<0||v>30)continue;
                numeric.push(v);
              }

              // De-duplicate nested/duplicated leaf values conservatively. Score
              // rows should expose 3-5 game values.
              const rowText=clean(row.innerText||'');
              const rawNums=(rowText.match(/(?:^|\s)(\d{1,2})(?=\s|$)/g)||[])
                .map(x=>Number(x.trim()))
                .filter(v=>v>=0&&v<=30);

              // Modern TournamentSoftware result rows normally contain:
              //   GamesWon | Game1 | Game2 | Game3 | Game4 | Game5
              // e.g. Daniel Jones: 0 6 9 11 12 11
              //      Philip Taylor: 3 11 11 7 10 5
              // Keep up to six trailing numeric values here; the pairing helper
              // below removes the GamesWon column and unused 0-0 game columns.
              let nums=[];
              if(rawNums.length>=3)nums=rawNums.slice(-Math.min(6,rawNums.length));
              else if(numeric.length>=3)nums=numeric.slice(-Math.min(6,numeric.length));

              if(nums.length>=3&&nums.length<=6){
                scoreRows.push({
                  href:a.href,
                  text:clean(a.innerText||a.getAttribute('aria-label')||a.getAttribute('title')||''),
                  scores:nums
                });
                break;
              }
            }
          }

          const ctx=contextFor(el); const key=(text+'|'+ctx+'|'+players.map(x=>x.href).join('|')).slice(0,3500); if(seen.has(key))return;seen.add(key);
          out.push({source,text,context:ctx,links,playerLinks:players,scoreRows});
        }
        for(const sel of sels)for(const el of document.querySelectorAll(sel))add(el,sel);
        return out;
      });
      all.push(...rows);
    }catch{}
  }
  return all;
}

function buildPlayerLookup(canonicalPlayers, officialLinks){
  const byNameAll=new Map();
  const byId=new Map();

  for(const p of canonicalPlayers){
    const key=nameKey(p.name);
    if(!byNameAll.has(key))byNameAll.set(key,[]);
    byNameAll.get(key).push(p);
    if(p.officialPlayerId)byId.set(String(p.officialPlayerId),p);
  }

  // Only expose byName when the name is unique. Callers must not silently pick
  // one of multiple official players with the same displayed name.
  const byName=new Map();
  for(const [key,rows] of byNameAll){
    if(rows.length===1)byName.set(key,rows[0]);
  }

  const byHref=new Map(),byHrefKey=new Map();
  for(const x of officialLinks){
    const href=x.href.split('#')[0];
    const id=String(x.officialPlayerId||hrefKey(href)||'');
    const canonical=byId.get(id);

    const info={
      name:canonical?.name||x.name,
      href,
      officialPlayerId:id,
      ageGroup:canonical?.ageGroup??x.ageGroup??'',
      gender:canonical?.gender||x.gender||'',
      country:canonical?.country||x.country||''
    };

    byHref.set(href,info);
    byHrefKey.set(hrefKey(href),info);

    if(canonical){
      canonical.officialPlayerId=id;
      canonical.officialProfileUrl=href;
    }
  }

  return {byName,byNameAll,byHref,byHrefKey,byId};
}

function eventIdentity(event){
  const e=clean(event);
  const age=(e.match(/\b(35|40|45|50|55|60|65|70|75|80|85)\+?\b/)||[])[1]||'';
  const gender=/women/i.test(e)?'Women':(/\bmen/i.test(e)?'Men':'');
  return {ageGroup:age?Number(age):'',gender};
}

function resolvePlayerByNameContext(lookup,name,event='',preferredId=''){
  if(preferredId){
    const exact=lookup.byId.get(String(preferredId));
    if(exact&&sameName(exact.name,name))return exact;
  }

  const rows=lookup.byNameAll.get(nameKey(name))||[];
  if(rows.length===1)return rows[0];
  if(!rows.length)return null;

  const identity=eventIdentity(event);
  let pool=rows;

  if(identity.ageGroup!==''){
    const ageRows=pool.filter(p=>String(p.ageGroup??'')===String(identity.ageGroup));
    if(ageRows.length)pool=ageRows;
  }
  if(identity.gender){
    const genderRows=pool.filter(p=>String(p.gender||'')===identity.gender);
    if(genderRows.length)pool=genderRows;
  }

  return pool.length===1?pool[0]:null;
}

function explicitEventMismatch(event,current){
  const e=clean(event); if(!e)return false;
  const age=(e.match(/\b(35|40|45|50|55|60|65|70|75|80|85)\+?\b/)||[])[1];
  const women=/women/i.test(e), men=/\bmen/i.test(e)&&!women;
  if(age&&current.ageGroup!==''&&current.ageGroup!=null&&String(age)!==String(current.ageGroup))return true;
  if(current.gender==='Women'&&men)return true;
  if(current.gender==='Men'&&women)return true;
  return false;
}

function structuredScoreForCandidate(c,current,opponent,lookup){
  const rows=Array.isArray(c?.scoreRows)?c.scoreRows:[];
  if(rows.length<2)return '';

  const currentId=String(current.officialPlayerId||hrefKey(current.href)||'');
  const currentKey=nameKey(current.name);
  const opponentKey=nameKey(opponent||'');

  const resolve=row=>{
    const href=(row.href||'').split('#')[0];
    const id=String(hrefKey(href)||'');
    const info=lookup.byHref.get(href)||lookup.byHrefKey.get(hrefKey(href));
    const nm=clean(info?.name||row.text||'');
    return {...row,id,name:nm,key:nameKey(nm)};
  };

  const resolved=rows.map(resolve);
  const currentRow=resolved.find(r=>(currentId&&r.id===currentId)||r.key===currentKey);
  const opponentRow=resolved.find(r=>r!==currentRow&&(r.key===opponentKey||sameName(r.name,opponent)));
  if(!currentRow||!opponentRow)return '';

  const normalizeScores=values=>{
    let scores=(Array.isArray(values)?values:[]).map(Number).filter(Number.isFinite);

    // Six values means GamesWon + five game score columns.
    // Strip GamesWon before pairing individual games.
    if(scores.length===6&&scores[0]>=0&&scores[0]<=3)scores=scores.slice(1);

    return scores;
  };

  let a=normalizeScores(currentRow.scores);
  let b=normalizeScores(opponentRow.scores);
  if(a.length!==b.length||a.length<3||a.length>5)return '';

  // TournamentSoftware renders unused later-game columns as 0 / 0.
  // Remove those from the end before validating the actual played games.
  while(a.length&&b.length&&a.at(-1)===0&&b.at(-1)===0){
    a.pop();b.pop();
  }
  if(a.length<3||a.length>5||a.length!==b.length)return '';

  const validGame=(x,y)=>{
    if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>30||y>30||x===y)return false;
    const hi=Math.max(x,y),lo=Math.min(x,y);
    return hi>=11&&(hi===11?lo<=9:hi-lo===2);
  };
  if(!a.every((x,i)=>validGame(x,b[i])))return '';

  return a.map((x,i)=>`${x}-${b[i]}`).join(', ');
}

function candidateToMatch(c,current,lookup){
  const whole=clean(`${c.context||''} ${c.text||''}`);
  const f=deriveFields(whole,`${current.gender==='Women'?"Women's":"Men's"} ${current.ageGroup}+`);
  if(!f.date||explicitEventMismatch(f.event,current))return null;
  if(f.event){const a=(f.event.match(/\b(35|40|45|50|55|60|65|70|75|80|85)\+?\b/)||[])[1];if((current.ageGroup===''||current.ageGroup==null)&&a)current.ageGroup=Number(a);if(!current.gender){if(/women/i.test(f.event))current.gender='Women';else if(/\bmen/i.test(f.event))current.gender='Men';}}

  const currentId=current.officialPlayerId||hrefKey(current.href);
  const linked=(c.playerLinks||[]).map(l=>{
    const href=(l.href||'').split('#')[0];
    const info=lookup.byHref.get(href)||lookup.byHrefKey.get(hrefKey(href));
    return {href,id:hrefKey(href),text:clean(l.text),info};
  });
  const currentLinked=linked.some(l=>l.id===currentId||(l.info&&l.info.officialPlayerId===currentId));
  const currentNamed=(' '+norm(whole).replace(/[^a-z0-9]+/g,' ')+' ').includes(' '+norm(current.name).replace(/[^a-z0-9]+/g,' ').trim()+' ');

  // The profile URL identifies the current player. TournamentSoftware does not consistently
  // repeat that player's link inside each schedule row: many valid rows link only the opponent.
  // Accept a row when:
  //   * it explicitly links/names the current player, or
  //   * it has exactly one player link (the opponent), or
  //   * it is a concrete match-row element with no player links.
  // Reject containers with multiple unrelated player links; these are usually parent/adjacent
  // containers and were the source of cross-player schedule contamination.
  const source=String(c.source||'');
  const concreteMatchRow=/tbody\s+tr|\[role=["']?row|class\*=["']?(?:match|fixture|schedule|result)|data-testid\*=["']?match/i.test(source);
  if(linked.length>0&&!currentLinked&&!currentNamed&&linked.length!==1)return null;
  if(linked.length===0&&!currentNamed&&!concreteMatchRow)return null;

  let opponent='', opponentId='';
  for(const l of linked){
    if(l.id===currentId||(l.info&&l.info.officialPlayerId===currentId))continue;
    const rawName=l.info?.name||l.text;
    if(!rawName||sameName(rawName,current.name))continue;
    const canonical=l.info?.officialPlayerId
      ? lookup.byId.get(String(l.info.officialPlayerId))
      : resolvePlayerByNameContext(lookup,rawName,f.event,l.id);
    opponent=canonical?.name||clean(rawName).replace(/\s*\([^)]*\)\s*$/,'').trim();
    opponentId=canonical?.officialPlayerId||l.info?.officialPlayerId||l.id||'';
    if(opponent)break;
  }

  if(!opponent){
    const hay=' '+norm(whole).replace(/[^a-z0-9]+/g,' ')+' ';
    for(const rows of lookup.byNameAll.values()){
      for(const p of rows){
        if(String(p.officialPlayerId||'')===String(currentId||''))continue;
        if(sameName(p.name,current.name)&&nameKey(p.name)===nameKey(current.name))continue;
        const k=norm(p.name).replace(/[^a-z0-9]+/g,' ').trim();
        if(k.length<=4||!hay.includes(' '+k+' '))continue;

        const resolved=resolvePlayerByNameContext(lookup,p.name,f.event,p.officialPlayerId);
        if(!resolved||String(resolved.officialPlayerId||'')!==String(p.officialPlayerId||''))continue;
        opponent=p.name;opponentId=p.officialPlayerId||'';break;
      }
      if(opponent)break;
    }
  }

  if(!opponent&&/\bTBD\b|to be determined|winner of|loser of|bye/i.test(whole))opponent=/bye/i.test(whole)?'Bye':'TBD';
  if(!opponent)return null;

  const structuredScore=!f.result?structuredScoreForCandidate(c,current,opponent,lookup):'';
  if(structuredScore){
    f.result=structuredScore;
    f.status='completed';
  }

  return {...f,player1:current.name,player1Id:currentId,player2:opponent,player2Id:opponentId,rawText:whole,sourcePlayer:current.name,sourcePlayerId:currentId,sourceUrl:current.href};
}
async function scrapeOneProfile(page,current,lookup,networkBucket){
  let candidates=[];
  try{
    await safeGoto(page,current.href,3); await dismissPopups(page); await openMatchesArea(page); await sleep(PROFILE_WAIT);
    // A little scrolling helps modern lazy profile lists.
    for(let i=0;i<6;i++){try{await page.evaluate(()=>window.scrollTo(0,document.documentElement?.scrollHeight||document.body?.scrollHeight||0));await sleep(120)}catch{break}}
    candidates=await extractProfileCandidates(page);
  }catch(e){return {matches:[],error:e.message,candidates:0}}
  // Each row must get its date from the row itself or its nearest date/day
  // heading collected by contextFor(). Never use one whole-page date for every
  // row: a player profile normally contains matches on several tournament days.
  const matches=candidates.map(c=>candidateToMatch(c,current,lookup)).filter(Boolean);
  // Parse JSON responses captured during this profile as a second source. We only accept
  // JSON records when both the current player and another canonical player are identifiable.
  for(const packet of networkBucket.splice(0)){
    const stack=[packet.body];
    while(stack.length){const o=stack.pop();if(!o||typeof o!=='object')continue;if(Array.isArray(o)){stack.push(...o);continue}const txt=clean(JSON.stringify(o));const f=deriveFields(txt,`${current.gender==='Women'?'Women\'s':'Men\'s'} ${current.ageGroup}+`);if(f.date){const currentToken=hrefKey(current.href); const currentHit=(' '+norm(txt).replace(/[^a-z0-9]+/g,' ')+' ').includes(' '+norm(current.name).replace(/[^a-z0-9]+/g,' ').trim()+' ') || (currentToken&&txt.toLowerCase().includes(String(currentToken).toLowerCase()));if(currentHit){let opp='';const hay=' '+norm(txt).replace(/[^a-z0-9]+/g,' ')+' ';for(const rows of lookup.byNameAll.values()){for(const p of rows){if(String(p.officialPlayerId||'')===String(current.officialPlayerId||hrefKey(current.href)||''))continue;const k=norm(p.name).replace(/[^a-z0-9]+/g,' ').trim();if(k.length>4&&hay.includes(' '+k+' ')){const resolved=resolvePlayerByNameContext(lookup,p.name,f.event,p.officialPlayerId);if(resolved&&String(resolved.officialPlayerId||'')===String(p.officialPlayerId||'')){opp=p.name;break}}}if(opp)break}if(opp&&!explicitEventMismatch(f.event,current)){const op=resolvePlayerByNameContext(lookup,opp,f.event);matches.push({...f,player1:current.name,player1Id:current.officialPlayerId||hrefKey(current.href),player2:opp,player2Id:op?.officialPlayerId||'',rawText:txt,sourcePlayer:current.name,sourcePlayerId:current.officialPlayerId||hrefKey(current.href),sourceUrl:current.href})}}}for(const v of Object.values(o))if(v&&typeof v==='object')stack.push(v)}
  }
  return {matches,error:'',candidates:candidates.length};
}

function matchKey(m){
  const identities=[m.player1Id||nameKey(m.player1),m.player2Id||nameKey(m.player2)].sort().join('~');
  return [m.date,clean(m.time).toLowerCase(),identities].join('|');
}
function mergeMatches(list){
  const out=[];

  const fixtureNames=m=>[nameKey(m.player1||''),nameKey(m.player2||'')].filter(Boolean).sort().join('~');
  const sameFixture=(a,b)=>{
    if(a.date!==b.date||clean(a.time).toLowerCase()!==clean(b.time).toLowerCase())return false;

    // If both observations carry official IDs, different IDs mean different
    // people even when their displayed names are identical.
    const aIds=[a.player1Id,a.player2Id].filter(Boolean).map(String).sort().join('~');
    const bIds=[b.player1Id,b.player2Id].filter(Boolean).map(String).sort().join('~');
    if(aIds&&bIds&&aIds!==bIds)return false;

    const aEvent=eventIdentity(a.event||'');
    const bEvent=eventIdentity(b.event||'');
    if(aEvent.ageGroup&&bEvent.ageGroup&&String(aEvent.ageGroup)!==String(bEvent.ageGroup))return false;
    if(aEvent.gender&&bEvent.gender&&aEvent.gender!==bEvent.gender)return false;

    return !!fixtureNames(a)&&fixtureNames(a)===fixtureNames(b);
  };

  const scoreRichness=v=>{
    const s=clean(v);
    if(!s)return 0;
    const games=(s.match(/\b\d{1,2}\s*[-–]\s*\d{1,2}\b/g)||[]).length;
    return games*100+s.length;
  };

  const mergeInto=(x,m)=>{
    // Never let an older scheduled observation overwrite a completed result.
    if(String(m.status||'').toLowerCase()==='completed')x.status='completed';

    // Prefer the observation with the richest published score.
    if(scoreRichness(m.result)>scoreRichness(x.result))x.result=m.result;

    for(const fld of ['event','round','venue','court','rawText','player1Id','player2Id','sourcePlayerId']){
      if((!x[fld]||String(x[fld]).length<String(m[fld]||'').length)&&m[fld])x[fld]=m[fld];
    }

    if((x.player2==='TBD'||x.player2==='Bye')&&m.player2&&m.player2!=='TBD'&&m.player2!=='Bye')x.player2=m.player2;
    if((x.player1==='TBD'||x.player1==='Bye')&&m.player1&&m.player1!=='TBD'&&m.player1!=='Bye')x.player1=m.player1;
  };

  for(const m of list){
    let x=out.find(o=>matchKey(o)===matchKey(m));

    // The same match can be seen from each player's profile with different or
    // missing IDs. Merge by names/date/time so the result updates the fixture
    // already displayed on the website.
    if(!x)x=out.find(o=>sameFixture(o,m));

    if(!x){
      const mNames=[m.player1,m.player2].filter(n=>n&&n!=='TBD'&&n!=='Bye');
      x=out.find(o=>o.date===m.date&&clean(o.time).toLowerCase()===clean(m.time).toLowerCase()&&mNames.some(n=>sameName(o.player1,n)||sameName(o.player2,n))&&[o.player1,o.player2,m.player1,m.player2].some(n=>n==='TBD'||n==='Bye'));
    }

    if(x)mergeInto(x,m); else out.push({...m});
  }

  return out.sort((a,b)=>`${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
}


const SQUASHLEVELS_SEARCH_URL='https://api-leveltech.squashlevels.com/api/search';

// SquashLevels search is more reliable when hyphenated first/middle names are
// sent with spaces (e.g. "Jean-Marie" -> "Jean Marie"). Keep the original
// tournament player name unchanged for display and identity matching.
function squashLevelsSearchName(name){
  return clean(name)
    .replace(/[-‐‑‒–—―]/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}

const SQUASHLEVELS_RECHECK_MS=24*60*60*1000;
const SQUASHLEVELS_DEBUG_FILE=path.join(DIR,'squashlevels-debug.json');
const SQUASHLEVELS_NICKNAMES_FILE=path.join(DIR,'squashlevels-nicknames.json');
let squashLevelsDebugWritten=false;

function loadSquashLevelsNicknameGroups(){
  try{
    if(!fs.existsSync(SQUASHLEVELS_NICKNAMES_FILE))return [];
    const parsed=JSON.parse(fs.readFileSync(SQUASHLEVELS_NICKNAMES_FILE,'utf8'));
    const groups=Array.isArray(parsed)?parsed:parsed?.groups;
    if(!Array.isArray(groups))return [];
    return groups.map(g=>Array.isArray(g)?g.map(clean).filter(Boolean):[]).filter(g=>g.length>=2);
  }catch(e){
    console.warn(`Could not read ${path.basename(SQUASHLEVELS_NICKNAMES_FILE)}: ${e.message}`);
    return [];
  }
}
const SQUASHLEVELS_NICKNAME_GROUPS=loadSquashLevelsNicknameGroups();
function splitPersonName(name){
  const parts=clean(name).replace(/\s*\([^)]*\)\s*$/,'').split(/\s+/).filter(Boolean);
  return {first:parts[0]||'',last:parts.length>1?parts.at(-1):''};
}
function sameSimpleName(a,b){return norm(a)===norm(b);}
function nicknameEquivalent(a,b){
  if(!a||!b)return false;
  if(sameSimpleName(a,b))return true;
  return SQUASHLEVELS_NICKNAME_GROUPS.some(g=>g.some(x=>sameSimpleName(x,a))&&g.some(x=>sameSimpleName(x,b)));
}
function nicknameVariants(firstName){
  const out=new Set();
  for(const g of SQUASHLEVELS_NICKNAME_GROUPS){
    if(g.some(x=>sameSimpleName(x,firstName)))for(const x of g)if(!sameSimpleName(x,firstName))out.add(x);
  }
  return [...out];
}


const slKey=k=>String(k||'').replace(/[^a-z0-9]/gi,'').toLowerCase();
function slValue(obj,names){
  if(!obj||typeof obj!=='object'||Array.isArray(obj))return undefined;
  const wanted=new Set(names.map(slKey));
  for(const [k,v] of Object.entries(obj))if(wanted.has(slKey(k)))return v;
  return undefined;
}
function slName(obj){
  if(!obj||typeof obj!=='object')return '';
  if(Array.isArray(obj)){
    for(const v of obj)if(typeof v==='string'&&v.trim().split(/\s+/).length>=2)return clean(v);
    return '';
  }
  const direct=slValue(obj,['name','playerName','fullName','displayName','player_name','player','title','label','text']);
  if(typeof direct==='string'&&clean(direct))return clean(direct);
  const first=slValue(obj,['firstName','firstname','first_name','forename','givenName','given_name']);
  const last=slValue(obj,['lastName','lastname','last_name','surname','familyName','family_name']);
  if(clean(first)&&clean(last))return clean(`${first} ${last}`);
  return '';
}

function squashLevelsCandidateName(raw,targetName=''){
  const target=clean(targetName);
  const candidates=[];
  const add=v=>{if(typeof v==='string'&&clean(v))candidates.push(clean(v));};
  add(slName(raw));
  if(raw&&typeof raw==='object'&&!Array.isArray(raw)){
    for(const v of Object.values(raw))if(typeof v==='string')add(v);
  }
  for(const text of candidates){
    // Common SquashLevels search result shape: "Gordon Plant, AUS".
    // The country suffix is metadata, not part of the player's name.
    const beforeCountry=text.replace(/,\s*[A-Z]{3}\s*$/,'').trim();
    if(target&&sameName(beforeCountry,target))return target;
    if(target&&sameName(text,target))return target;
    if(target){
      const escaped=target.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const m=text.match(new RegExp(`^\\s*(${escaped})(?:\\s*[,|·\-]|\\s*$)`,'i'));
      if(m)return target;
    }
  }
  return clean(slName(raw)).replace(/,\s*[A-Z]{3}\s*$/,'').trim();
}
function squashLevelsObjectContainsExactName(obj,targetName){
  if(!obj||typeof obj!=='object')return false;
  const target=clean(targetName);
  const seen=new Set();
  function walk(v,depth=0){
    if(depth>4||v==null)return false;
    if(typeof v==='string'){
      const t=clean(v);
      const stripped=t.replace(/,\s*[A-Z]{3}\s*$/,'').trim();
      if(sameName(t,target)||sameName(stripped,target))return true;
      // Accept exact name followed by result metadata such as country, age or club.
      if(norm(t).startsWith(norm(target)+','))return true;
      return false;
    }
    if(typeof v!=='object'||seen.has(v))return false;
    seen.add(v);
    if(Array.isArray(v))return v.some(x=>walk(x,depth+1));
    return Object.values(v).some(x=>walk(x,depth+1));
  }
  return walk(obj);
}
function slId(obj){
  if(!obj||typeof obj!=='object'||Array.isArray(obj))return '';
  const v=slValue(obj,['playerId','playerID','player_id','playerid','squashLevelsId','squashlevelsId','squashLevelsID','profileId','profileID','userId','userID','userid','id']);
  return (typeof v==='string'||typeof v==='number')?clean(v):'';
}
function slUrl(obj){
  if(!obj||typeof obj!=='object'||Array.isArray(obj))return '';
  const v=slValue(obj,['profileUrl','profileURL','playerUrl','playerURL','player_url','url','href','link','profileLink']);
  if(typeof v!=='string')return '';
  const u=clean(v); if(!u)return '';
  if(/^https?:\/\//i.test(u)&&/squashlevels\.com/i.test(u))return u;
  if(u.startsWith('/'))return 'https://squashlevels.com'+u;
  return '';
}
function numericValue(v,min=1,max=10000000){
  if(v==null||typeof v==='object')return null;
  const m=String(v).replace(/[,#]/g,'').match(/-?\d+(?:\.\d+)?/); if(!m)return null;
  const n=Number(m[0]); return Number.isFinite(n)&&n>=min&&n<=max?n:null;
}
function slRankMetric(obj){
  if(!obj||typeof obj!=='object')return null;
  const wanted=new Set(['worldRank','worldRanking','worldPosition','globalRank','globalRanking','overallRank','rankWorld','rankingWorld','ranking','rank','position'].map(slKey));
  const seen=new Set();
  function walk(v,depth=0){
    if(depth>5||v==null)return null;
    if(Array.isArray(v)){for(const x of v){const n=walk(x,depth+1);if(n!=null)return n;}return null;}
    if(typeof v!=='object'||seen.has(v))return null; seen.add(v);
    for(const [k,x] of Object.entries(v)){
      if(wanted.has(slKey(k))){const n=numericValue(x,1,1000000);if(n!=null)return Math.round(n);}
    }
    for(const x of Object.values(v))if(x&&typeof x==='object'){const n=walk(x,depth+1);if(n!=null)return n;}
    return null;
  }
  return walk(obj);
}
function squashLevelsCandidates(payload,targetName){
  const found=[]; const seen=new Set();
  function walk(v,parent=null,depth=0){
    if(depth>10||v==null)return;
    if(Array.isArray(v)){for(const x of v)walk(x,v,depth+1);return;}
    if(typeof v!=='object'||seen.has(v))return; seen.add(v);
    const nm=squashLevelsCandidateName(v,targetName);
    let score=0;
    if(nm&&sameName(nm,targetName))score+=100;
    else if(squashLevelsObjectContainsExactName(v,targetName))score+=95;
    else if(nm&&norm(nm).includes(norm(targetName)))score+=55;
    for(const x of Object.values(v)){
      if(typeof x==='string'&&sameName(x,targetName)){score=Math.max(score,95);break;}
    }
    const typ=clean(slValue(v,['type','resultType','entityType','kind','category'])||'').toLowerCase();
    if(/club|venue|court/.test(typ))score-=100;
    const id=slId(v), url=slUrl(v);
    if(id)score+=10;if(url)score+=15;
    if(score>0)found.push({raw:v,parent,name:nm||targetName,type:typ,id,url,score});
    for(const x of Object.values(v))if(x&&typeof x==='object')walk(x,v,depth+1);
  }
  walk(payload);
  return found.sort((a,b)=>b.score-a.score);
}
function squashLevelsUrlFromCandidate(c){
  if(!c)return '';
  const u=c.url||slUrl(c.raw)||slUrl(c.parent);
  if(u)return canonicalSquashLevelsProfileUrl(u);
  const id=c.id||slId(c.raw)||slId(c.parent);
  if(id)return `https://app.squashlevels.com/player_detail.php?player=${encodeURIComponent(id)}`;
  return '';
}
function squashLevelsPlayerIdFromUrl(url){
  try{
    const u=new URL(url,'https://app.squashlevels.com');
    return clean(u.searchParams.get('player')||u.searchParams.get('playerId')||u.searchParams.get('id')||'');
  }catch{return ''}
}
function canonicalSquashLevelsProfileUrl(url){
  try{
    const u=new URL(url,'https://app.squashlevels.com');
    const id=clean(u.searchParams.get('player')||u.searchParams.get('playerId')||u.searchParams.get('id')||'');
    if(!id)return url;
    return `https://app.squashlevels.com/player_detail.php?player=${encodeURIComponent(id)}`;
  }catch{return url;}
}
function squashLevelsExpectedCountryCodes(player){
  const iso=clean(player?.iso3).toUpperCase();
  const country=clean(player?.country).toLowerCase();
  const aliases={
    RSA:['RSA','ZAF'], ZAF:['RSA','ZAF'], SIN:['SIN','SGP'], SGP:['SIN','SGP'],
    UAE:['UAE','ARE'], ARE:['UAE','ARE'], GER:['GER','DEU'], DEU:['GER','DEU'],
    NED:['NED','NLD'], NLD:['NED','NLD'], SUI:['SUI','CHE'], CHE:['SUI','CHE'],
    DEN:['DEN','DNK'], DNK:['DEN','DNK'], GRE:['GRE','GRC'], GRC:['GRE','GRC'],
    CRO:['CRO','HRV'], HRV:['CRO','HRV'], POR:['POR','PRT'], PRT:['POR','PRT'],
    ESP:['ESP'], FRA:['FRA'], ITA:['ITA'], AUS:['AUS'], NZL:['NZL'], CAN:['CAN'], USA:['USA'],
    ENG:['ENG'], SCO:['SCO'], WAL:['WAL'], IRL:['IRL'], NIR:['NIR'], PAK:['PAK'], IND:['IND'],
    MAS:['MAS','MYS'], MYS:['MAS','MYS'], JPN:['JPN'], KOR:['KOR'], HKG:['HKG'], CHN:['CHN'],
    EGY:['EGY'], MEX:['MEX'], BRA:['BRA'], ARG:['ARG'], COL:['COL'], CHI:['CHI','CHL'], CHL:['CHI','CHL']
  };
  const byName={
    'england':['ENG'],'scotland':['SCO'],'wales':['WAL'],
    'northern ireland':['NIR'],'ireland':['IRL'],
    'south africa':['RSA','ZAF'],'singapore':['SIN','SGP'],'united arab emirates':['UAE','ARE'],
    'germany':['GER','DEU'],'netherlands':['NED','NLD'],'switzerland':['SUI','CHE'],
    'denmark':['DEN','DNK'],'greece':['GRE','GRC'],'croatia':['CRO','HRV'],'portugal':['POR','PRT'],
    'malaysia':['MAS','MYS'],'chile':['CHI','CHL']
  };
  return [...new Set((byName[country]||aliases[iso]||[iso]).filter(Boolean))];
}
function squashLevelsExpectedAge(player){
  const n=Number(String(player?.ageGroup??'').match(/\d{2}/)?.[0]);
  return Number.isFinite(n)?n:null;
}


// Search API metadata parser. SquashLevels' autocomplete/search results already expose
// country and age group (e.g. "Sue Hillier (O60)" and "AUS - Vic Park, Western Australia").
// Keep this parser independent of the profile page so nickname resolution can use the
// same identity information a person sees in the SquashLevels search dropdown.
const SQUASHLEVELS_COUNTRY_NAME_CODES={
  'australia':'AUS','new zealand':'NZL','england':'ENG','scotland':'SCO','wales':'WAL',
  'ireland':'IRL','northern ireland':'NIR','united states':'USA','usa':'USA','canada':'CAN',
  'south africa':'RSA','singapore':'SIN','malaysia':'MAS','india':'IND','pakistan':'PAK',
  'japan':'JPN','hong kong':'HKG','china':'CHN','south korea':'KOR','korea':'KOR',
  'switzerland':'SUI','germany':'GER','france':'FRA','belgium':'BEL','netherlands':'NED',
  'denmark':'DEN','sweden':'SWE','norway':'NOR','finland':'FIN','poland':'POL',
  'spain':'ESP','portugal':'POR','italy':'ITA','greece':'GRE','croatia':'CRO',
  'czech republic':'CZE','czechia':'CZE','slovakia':'SVK','austria':'AUT','hungary':'HUN',
  'egypt':'EGY','united arab emirates':'UAE','qatar':'QAT','kuwait':'KUW','saudi arabia':'KSA',
  'mexico':'MEX','brazil':'BRA','argentina':'ARG','colombia':'COL','chile':'CHI',
  'guyana':'GUY','bermuda':'BER','jamaica':'JAM','barbados':'BAR','trinidad and tobago':'TTO'
};
const SQUASHLEVELS_COUNTRY_CODES=new Set([
  'AUS','NZL','ENG','SCO','WAL','IRL','NIR','USA','CAN','RSA','ZAF','SIN','SGP','MAS','MYS',
  'IND','PAK','JPN','HKG','CHN','KOR','SUI','CHE','GER','DEU','FRA','BEL','NED','NLD','DEN',
  'DNK','SWE','NOR','FIN','POL','ESP','POR','PRT','ITA','GRE','GRC','CRO','HRV','CZE','SVK',
  'AUT','HUN','EGY','UAE','ARE','QAT','KUW','KSA','MEX','BRA','ARG','COL','CHI','CHL','GUY',
  'BER','JAM','BAR','TTO'
]);
function squashLevelsStringsFromObject(obj,maxDepth=4){
  const out=[]; const seen=new Set();
  function walk(v,depth=0,key=''){
    if(depth>maxDepth||v==null)return;
    if(typeof v==='string'||typeof v==='number'){
      const text=clean(v); if(text)out.push({key,text}); return;
    }
    if(typeof v!=='object'||seen.has(v))return; seen.add(v);
    if(Array.isArray(v)){for(const x of v)walk(x,depth+1,key);return;}
    for(const [k,x] of Object.entries(v))walk(x,depth+1,k);
  }
  walk(obj); return out;
}
function squashLevelsCountryCodeFromApiCandidate(c){
  const rows=[...squashLevelsStringsFromObject(c?.raw),...squashLevelsStringsFromObject(c?.parent)];
  // Prefer fields explicitly labelled as country/allegiance/nation.
  const ordered=[
    ...rows.filter(x=>/(country|nation|allegiance|countrycode|country_code|iso3)/i.test(x.key)),
    ...rows
  ];
  for(const {text} of ordered){
    const upper=text.toUpperCase();
    if(SQUASHLEVELS_COUNTRY_CODES.has(upper))return upper;
    // Common search-result text: "AUS - Vic Park, Western Australia".
    let m=upper.match(/^\s*([A-Z]{3})\s*(?:[-–—·|,]|$)/);
    if(m&&SQUASHLEVELS_COUNTRY_CODES.has(m[1]))return m[1];
    // Also support "Sue Hillier, AUS" or "Australia, AUS".
    m=upper.match(/(?:^|[,|·])\s*([A-Z]{3})\s*(?:$|[-–—·|,])/);
    if(m&&SQUASHLEVELS_COUNTRY_CODES.has(m[1]))return m[1];
    const lower=norm(text);
    for(const [name,code] of Object.entries(SQUASHLEVELS_COUNTRY_NAME_CODES)){
      if(lower===name||lower.startsWith(name+' ')||lower.includes(', '+name))return code;
    }
  }
  return '';
}
function squashLevelsAgeFromApiCandidate(c){
  const rows=[...squashLevelsStringsFromObject(c?.raw),...squashLevelsStringsFromObject(c?.parent)];
  // Prefer explicitly age/category-labelled fields, then inspect display strings/name.
  const ordered=[
    ...rows.filter(x=>/(age|agegroup|category|division|class)/i.test(x.key)),
    ...rows
  ];
  for(const {key,text} of ordered){
    let m=String(text).toUpperCase().match(/\bO\s*(35|40|45|50|55|60|65|70|75|80|85)\b/);
    if(m)return Number(m[1]);
    if(/(age|agegroup|category|division|class)/i.test(key)){
      m=String(text).match(/\b(35|40|45|50|55|60|65|70|75|80|85)\+?\b/);
      if(m)return Number(m[1]);
    }
  }
  return null;
}
function squashLevelsApiCandidateIdentity(c,player){
  const countryCode=squashLevelsCountryCodeFromApiCandidate(c);
  const age=squashLevelsAgeFromApiCandidate(c);
  const expectedCodes=squashLevelsExpectedCountryCodes(player);
  const expectedAge=squashLevelsExpectedAge(player);
  return {
    countryCode,age,expectedCodes,expectedAge,
    countryMatch:countryCode?expectedCodes.includes(countryCode):null,
    ageMatch:age==null||expectedAge==null?null:age===expectedAge
  };
}
function squashLevelsAgeFromField(text){
  const m=String(text||'').toUpperCase().match(/\bO\s*(\d{2})\b/);
  return m?Number(m[1]):null;
}
function squashLevelsCountryFromNameField(text){
  // SquashLevels renders the name/country as one distinct string, e.g. "Harness Singh, AUS".
  // Country is ONLY the final comma-separated token. Never scan arbitrary profile text for 3-letter words.
  const parts=String(text||'').split(',').map(x=>clean(x)).filter(Boolean);
  if(parts.length<2)return '';
  const last=parts.at(-1).toUpperCase();
  return /^[A-Z]{3}$/.test(last)?last:'';
}
async function squashLevelsProfileIdentity(page,player,profileName=player.name){
  const name=clean(profileName||player.name);
  const expectedCodes=squashLevelsExpectedCountryCodes(player);
  const fields=await page.evaluate((targetName)=>{
    const norm=s=>String(s||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
    const target=norm(targetName).toLowerCase();
    const all=[...document.querySelectorAll('body *')];
    const textOf=el=>norm(el.innerText||el.textContent);

    // Field 1: a distinct name/country string such as "Joannah Yue, SIN".
    // Prefer the smallest element whose text begins with the exact name and whose final comma token is 3 letters.
    const nameCountryCandidates=[];
    for(const el of all){
      const t=textOf(el); if(!t||t.length>220)continue;
      const low=t.toLowerCase();
      if(!(low===target||low.startsWith(target+',')))continue;
      const parts=t.split(',').map(x=>norm(x)).filter(Boolean);
      const last=(parts.at(-1)||'').toUpperCase();
      if(parts.length>=2&&/^[A-Z]{3}$/.test(last))nameCountryCandidates.push(t);
    }
    nameCountryCandidates.sort((a,b)=>a.length-b.length);
    const nameCountryText=nameCountryCandidates[0]||'';

    // Field 2: a separate age/ID string, e.g. "O40" or "SA ID: 141651, O60".
    // Do not take Oxx from the name/country field or from a large parent container.
    const ageCandidates=[];
    for(const el of all){
      const t=textOf(el); if(!t||t.length>180||t===nameCountryText)continue;
      if(/\bO\s*\d{2}\b/i.test(t))ageCandidates.push(t);
    }
    ageCandidates.sort((a,b)=>{
      const aStarts=/^(?:[A-Z]{2,4}\s+ID\s*:\s*[^,]+,\s*)?O\s*\d{2}\b/i.test(a)?0:1;
      const bStarts=/^(?:[A-Z]{2,4}\s+ID\s*:\s*[^,]+,\s*)?O\s*\d{2}\b/i.test(b)?0:1;
      return aStarts-bStarts||a.length-b.length;
    });
    return {nameCountryText,ageText:ageCandidates[0]||''};
  },name);

  const countryCode=squashLevelsCountryFromNameField(fields.nameCountryText);
  const age=squashLevelsAgeFromField(fields.ageText);
  const expectedAge=squashLevelsExpectedAge(player);
  const ageMatch=age==null||expectedAge==null?null:age===expectedAge;
  const countryMatch=countryCode?expectedCodes.includes(countryCode):null;
  return {
    age,countryCode,expectedAge,expectedCodes,ageMatch,countryMatch,
    nameCountryText:fields.nameCountryText||'',ageText:fields.ageText||'',
    text:`name/country: ${fields.nameCountryText||'?'}\nage/id: ${fields.ageText||'?'}`
  };
}
function squashLevelsIdentityAccepted(identity){
  // Exact name is required by the search result. Country is the primary discriminator.
  // Age is only a tie-breaker because SquashLevels sometimes shows Senior/text or a stale age group.
  // Never reject a candidate solely because the age does not match.
  return identity.countryMatch!==false;
}

function squashLevelsLastMatchDateValue(value){
  const text=clean(value);
  if(!text||/not\s*played|never\s*played|no\s*matches?|tbd|unknown/i.test(text))return null;
  const months={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  let m;
  m=text.match(/\b(20\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})\b/);
  if(m)return Date.UTC(Number(m[1]),Number(m[2])-1,Number(m[3]));
  m=text.match(/\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](20\d{2})\b/);
  if(m)return Date.UTC(Number(m[3]),Number(m[2])-1,Number(m[1]));
  m=text.match(/\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(20\d{2})\b/i);
  if(m)return Date.UTC(Number(m[3]),months[m[2].slice(0,3).toLowerCase()]-1,Number(m[1]));
  m=text.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:,)?\s+(20\d{2})\b/i);
  if(m)return Date.UTC(Number(m[3]),months[m[1].slice(0,3).toLowerCase()]-1,Number(m[2]));
  // SquashLevels duplicate tables commonly use month + year, e.g. "Mar 2026".
  m=text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(20\d{2})\b/i);
  if(m)return Date.UTC(Number(m[2]),months[m[1].slice(0,3).toLowerCase()]-1,1);
  return null;
}

function squashLevelsLastMatchFromApiCandidate(c){
  const hits=[];
  const seen=new Set();
  const walk=(value,key='',depth=0)=>{
    if(value==null||depth>7)return;
    if(typeof value==='object'){
      if(seen.has(value))return;seen.add(value);
      if(Array.isArray(value)){for(const x of value)walk(x,key,depth+1);return;}
      for(const [k,v] of Object.entries(value))walk(v,k,depth+1);
      return;
    }
    if(!/(last.*match|match.*date|last.*played|lastplayed|last_match|lastmatch)/i.test(key))return;
    const ts=squashLevelsLastMatchDateValue(value);
    if(ts)hits.push(ts);
  };
  walk(c?.raw);walk(c?.parent);
  return hits.length?Math.max(...hits):null;
}

async function squashLevelsProfileLastMatch(page){
  try{
    const values=await page.evaluate(()=>{
      const clean=s=>String(s||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
      const out=[];
      const duplicateContainer=el=>{
        let cur=el;
        for(let i=0;i<6&&cur;i++,cur=cur.parentElement){
          const t=clean(cur.innerText||'');
          if(t.length<5000&&/possible\s+duplicates?|duplicate\s+players?\s+found/i.test(t))return true;
          if(cur.tagName==='TABLE'&&/duplicate\??/i.test(t)&&/last\s*match/i.test(t))return true;
        }
        return false;
      };
      const selectors=[
        'time[datetime]','[class*="match"] time','[class*="result"] time',
        '[class*="match"] [class*="date"]','[class*="result"] [class*="date"]',
        '[class*="match"]','[class*="result"]','tbody tr'
      ];
      const seen=new Set();
      for(const sel of selectors){
        for(const el of document.querySelectorAll(sel)){
          if(duplicateContainer(el))continue;
          const t=clean(el.getAttribute?.('datetime')||el.innerText||el.textContent||'');
          if(!t||t.length>700||seen.has(t))continue;
          // Only retain strings that plausibly contain a calendar date.
          if(!/(?:20\d{2}[-\/.]\d{1,2}[-\/.]\d{1,2}|\d{1,2}[\/.\-]\d{1,2}[\/.\-]20\d{2}|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b.*\b20\d{2}\b|\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+20\d{2}\b)/i.test(t))continue;
          seen.add(t);out.push(t);
        }
      }
      return out.slice(0,100);
    });
    const dates=values.map(squashLevelsLastMatchDateValue).filter(Boolean);
    return dates.length?Math.max(...dates):null;
  }catch{return null;}
}

function squashLevelsFormatLastMatch(ts){
  if(!ts)return 'Not played / unknown';
  try{return new Date(ts).toLocaleDateString('en-AU',{month:'short',year:'numeric',timeZone:'UTC'});}catch{return String(ts);}
}


function squashLevelsParseMonthYear(value){
  const s=clean(value);
  if(!s||/not\s+played|never\s+played|no\s+matches?/i.test(s))return null;
  const months={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,sept:8,oct:9,nov:10,dec:11};
  let m=s.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+(\d{4})\b/i);
  if(m){const k=m[1].toLowerCase().startsWith('sept')?'sept':m[1].toLowerCase().slice(0,3);return Date.UTC(Number(m[2]),months[k],1);}
  m=s.match(/\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](20\d{2})\b/); if(m)return Date.UTC(Number(m[3]),Number(m[2])-1,Number(m[1]));
  m=s.match(/\b(20\d{2})[\/.\-](\d{1,2})[\/.\-](\d{1,2})\b/); if(m)return Date.UTC(Number(m[1]),Number(m[2])-1,Number(m[3]));
  return null;
}
async function readSquashLevelsProfileEvidence(page,player){
  try{
    return await page.evaluate(({wantedName})=>{
      const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
      const allLines=String(document.body?.innerText||'')
        .split(/\r?\n/).map(clean).filter(Boolean);

      // --- Main profile evidence ---
      // Only use the profile area before the duplicate section for age/location.
      const dupHeadingIndex=allLines.findIndex(x=>/possible\s+duplicates?/i.test(x));
      const mainLines=dupHeadingIndex>=0?allLines.slice(0,dupHeadingIndex):allLines;
      const mainText=mainLines.join('\n');

      let age=null;
      const ageMatch=mainText.match(/\bO\s*(\d{2})\b/i);
      if(ageMatch)age=Number(ageMatch[1]);

      let clubLocation='',countryCode='';
      // SquashLevels location lines look like:
      // "Vic Park, Western Australia, AUS"
      // Prefer any short top-profile line ending in a 3-letter country code.
      for(const t of mainLines){
        if(t.length>180 || !t.includes(','))continue;
        if(/SA ID:|ratings|confidence|following|follow|invite|world ranking|level/i.test(t))continue;
        const cm=t.match(/,\s*([A-Z]{3})\s*$/);
        if(cm){
          clubLocation=t;
          countryCode=cm[1].toUpperCase();
          break;
        }
      }

      let level=null;
      // Find level from profile text without relying on CSS classes.
      for(let i=0;i<mainLines.length;i++){
        if(/^LEVEL$/i.test(mainLines[i])){
          for(let j=i+1;j<Math.min(mainLines.length,i+5);j++){
            const m=mainLines[j].match(/^([\d,]+)(?:\s*\(P\))?$/i);
            if(m){level=Number(m[1].replace(/,/g,''));break;}
          }
          if(level)break;
        }
      }

      // --- Possible Duplicates table ---
      // Do NOT depend on DOM ancestry. SquashLevels renders the heading and table
      // as siblings. Identify the table by its actual column headings.
      const duplicateRows=[];
      const debugTables=[];
      for(const table of document.querySelectorAll('table')){
        const tableText=clean(table.innerText||'');
        if(!tableText)continue;

        const headers=[...table.querySelectorAll('th')]
          .map(x=>clean(x.innerText||x.textContent||''));

        const looksLikeDuplicateTable =
          headers.some(x=>/^Level$/i.test(x)) &&
          headers.some(x=>/^Name$/i.test(x)) &&
          headers.some(x=>/Last\s*match/i.test(x));

        if(!looksLikeDuplicateTable){
          if(/Last\s*match/i.test(tableText)&&/Duplicate/i.test(tableText)){
            debugTables.push({headers,tableText:tableText.slice(0,1200)});
          }
          continue;
        }

        for(const tr of table.querySelectorAll('tbody tr, tr')){
          const cells=[...tr.querySelectorAll('td')]
            .map(td=>clean(td.innerText||td.textContent||''));
          if(cells.length<3)continue;

          const a=tr.querySelector('a[href*="player"]');
          const href=a?.href||a?.getAttribute('href')||'';
          const id=(href.match(/[?&]player=(\d+)/i)||[])[1]||'';

          // Resolve columns by header position where possible.
          const levelIndex=headers.findIndex(x=>/^Level$/i.test(x));
          const nameIndex=headers.findIndex(x=>/^Name$/i.test(x));
          const lastIndex=headers.findIndex(x=>/Last\s*match/i.test(x));

          duplicateRows.push({
            id,
            href,
            level: levelIndex>=0 ? cells[levelIndex]||'' : cells[0]||'',
            name: nameIndex>=0 ? cells[nameIndex]||'' : cells[1]||'',
            lastMatch: lastIndex>=0 ? cells[lastIndex]||'' : cells[2]||'',
            cells
          });
        }
      }

      return {
        age,clubLocation,countryCode,level,duplicateRows,
        debugTables,
        mainSample:mainLines.slice(0,40)
      };
    },{wantedName:player?.name||''});
  }catch(e){
    return {
      age:null,clubLocation:'',countryCode:'',level:null,
      duplicateRows:[],debugTables:[],mainSample:[],
      error:String(e?.message||e)
    };
  }
}
function squashLevelsDuplicateRowEvidence(row){
  const levelRaw=clean(row?.level||'');
  const levelMatch=levelRaw.match(/[\d,]+/);
  const level=levelMatch?Number(levelMatch[0].replace(/,/g,'')):null;
  const lastMatch=squashLevelsParseMonthYear(row?.lastMatch||'');
  return {level,lastMatch};
}
async function chooseSquashLevelsCandidate(page,candidates,player,requireExactAge=false){
  const checked=[]; const crossEvidence=new Map();
  for(const c of candidates){
    try{
      await safeGoto(page,c.url,2); await waitForSquashLevelsProfileReady(page,700);
      const identity=await squashLevelsProfileIdentity(page,player,c.name||player.name);
      const evidence=await readSquashLevelsProfileEvidence(page,player);
      if(SQUASHLEVELS_PLAYER_ONLY&&sameName(player.name,SQUASHLEVELS_PLAYER_ONLY)){
        console.log(`    DEBUG ${player.name} candidate ${c.playerId||squashLevelsPlayerIdFromUrl(c.url)||'?'}:`);
        console.log(`      profile country=${evidence.countryCode||'?'} age=${evidence.age??'?'} club=${evidence.clubLocation||'?'} level=${evidence.level??'?'}`);
        if(evidence.duplicateRows?.length){
          for(const r of evidence.duplicateRows){
            console.log(`      duplicate row: id=${r.id||'?'} name=${r.name||'?'} level=${r.level||'?'} last=${r.lastMatch||'?'}`);
          }
        }else{
          console.log(`      duplicate table rows: NONE`);
          if(evidence.debugTables?.length){
            for(const t of evidence.debugTables.slice(0,3)){
              console.log(`      near-match table headers=${JSON.stringify(t.headers)} text=${t.tableText}`);
            }
          }
          if(evidence.mainSample?.length){
            console.log(`      profile text sample: ${evidence.mainSample.slice(0,16).join(' | ')}`);
          }
        }
      }
      // readSquashLevelsProfileEvidence() is deliberately limited to the MAIN
      // profile area before any "Possible duplicates" section. Prefer it over
      // broad DOM scanning so another person's O40/O50/O60 cannot contaminate
      // the candidate identity.
      const apiIdentity=squashLevelsApiCandidateIdentity(c,player);
      const expectedCodes=squashLevelsExpectedCountryCodes(player);
      const expectedAge=squashLevelsExpectedAge(player);

      // Combine independent identity evidence from:
      //   1. the main profile area,
      //   2. the narrower profile identity parser,
      //   3. the SquashLevels search API candidate itself.
      // Any explicit contradiction rejects the candidate. Unknown evidence
      // never overrides a positive/negative explicit value.
      const countryEvidence=[
        clean(evidence.countryCode).toUpperCase(),
        clean(identity.countryCode).toUpperCase(),
        clean(apiIdentity.countryCode).toUpperCase()
      ].filter(Boolean);
      const countryConflict=countryEvidence.some(code=>
        expectedCodes.length&&!expectedCodes.includes(code)
      );
      const countryPositive=countryEvidence.some(code=>
        expectedCodes.includes(code)
      );
      const countryCode=countryPositive
        ? countryEvidence.find(code=>expectedCodes.includes(code))
        : (countryEvidence[0]||'');
      const countryMatch=countryConflict?false:(countryPositive?true:null);

      const ageEvidence=[
        evidence.age,
        identity.age,
        apiIdentity.age
      ].filter(v=>v!==null&&v!==undefined&&Number.isFinite(Number(v)))
       .map(Number);
      const ageConflict=expectedAge!==null&&ageEvidence.some(v=>v!==Number(expectedAge));
      const agePositive=expectedAge!==null&&ageEvidence.some(v=>v===Number(expectedAge));
      const age=agePositive
        ? Number(expectedAge)
        : (ageEvidence.length?ageEvidence[0]:null);
      const ageMatch=ageConflict?false:(agePositive?true:null);
      for(const row of evidence.duplicateRows||[]){const id=clean(row.id);if(!id)continue;const parsed=squashLevelsDuplicateRowEvidence(row);const prior=crossEvidence.get(id)||{};crossEvidence.set(id,{level:parsed.level??prior.level??null,lastMatch:Math.max(parsed.lastMatch||0,prior.lastMatch||0)||null});}
      const apiLastMatch=squashLevelsLastMatchFromApiCandidate(c); const profileLastMatch=await squashLevelsProfileLastMatch(page); const id=clean(c.playerId||squashLevelsPlayerIdFromUrl(c.url));
      checked.push({...c,identity:{...identity,countryCode,countryMatch,age,ageMatch},profileEvidence:evidence,playerId:id,lastMatch:Math.max(apiLastMatch||0,profileLastMatch||0)||null});
    }catch(e){console.log(`  Candidate profile check failed for ${player.name}: ${e.message}`);}
  }
  if(!checked.length)return null;
  for(const x of checked){const cross=crossEvidence.get(clean(x.playerId));if(cross){if(!x.lastMatch&&cross.lastMatch)x.lastMatch=cross.lastMatch;x.duplicateTableLevel=cross.level??null;}}
  // Explicit contradictions are NEVER acceptable, even when there is only one
  // TournamentSoftware player with this name.
  let pool=checked.filter(x=>
    x.identity.countryMatch!==false &&
    x.identity.ageMatch!==false
  );
  if(!pool.length){
    console.log(
      `    SquashLevels identity rejected for ${player.name}: every candidate ` +
      `has an explicit country and/or age mismatch.`
    );
    return null;
  }

  // Positive country evidence wins over unknown country evidence.
  if(pool.some(x=>x.identity.countryMatch===true)){
    pool=pool.filter(x=>x.identity.countryMatch===true);
  }

  if(requireExactAge){
    // Duplicate TournamentSoftware names MUST have explicit profile age evidence
    // matching the same Masters age band. Wrong age and unknown age are both
    // rejected; neither may win via activity/club/first-result fallback.
    const exactAge=pool.filter(x=>x.identity.ageMatch===true);
    if(!exactAge.length){
      console.log(
        `    Duplicate-name age guard: no SquashLevels candidate explicitly matches ` +
        `${player.name} ${player.ageGroup}+. Mapping left unresolved.`
      );
      return null;
    }
    pool=exactAge;
  }else if(pool.some(x=>x.identity.ageMatch===true)){
    pool=pool.filter(x=>x.identity.ageMatch===true);
  }else if(pool.some(x=>x.identity.ageMatch===false)){
    const unknownAge=pool.filter(x=>x.identity.ageMatch!==false);
    if(unknownAge.length)pool=unknownAge;
  }

  pool.sort((a,b)=>(b.lastMatch||0)-(a.lastMatch||0));
  if(pool.length>1){console.log(`  SquashLevels duplicate profiles for ${player.name}:`);for(const x of pool.slice(0,8))console.log(`    ${x.url} | country=${x.identity.countryCode||'?'} age=${x.identity.age??'?'} club=${x.profileEvidence?.clubLocation||'?'} level=${x.profileEvidence?.level??'?'} last match=${squashLevelsFormatLastMatch(x.lastMatch)}`);}
  const hasCountryEvidence=pool.some(x=>x.identity.countryMatch===true),hasAgeEvidence=pool.some(x=>x.identity.ageMatch===true),hasActivityEvidence=pool.some(x=>!!x.lastMatch),hasClubEvidence=pool.some(x=>!!x.profileEvidence?.clubLocation);
  if(pool.length>1&&!hasCountryEvidence&&!hasAgeEvidence&&!hasActivityEvidence&&!hasClubEvidence){console.log('    No usable country/age/club/activity evidence; duplicate selection left unresolved.');return null;}
  if(pool.length>1)console.log(`    Selected most appropriate profile: ${pool[0].url}`); return pool[0];
}
function squashLevelsWorldRankFromCandidate(c){return c?slRankMetric(c.raw)||slRankMetric(c.parent):null;}
function writeSquashLevelsDebug(player,payload,rows){
  if(squashLevelsDebugWritten)return;
  squashLevelsDebugWritten=true;
  try{
    fs.writeFileSync(SQUASHLEVELS_DEBUG_FILE,JSON.stringify({
      note:'First SquashLevels response that could not be resolved. This file is safe to send back for parser debugging.',
      searchedPlayer:player.name,
      candidateCount:rows.length,
      topCandidates:rows.slice(0,10).map(x=>({name:x.name,type:x.type,id:x.id,url:x.url,score:x.score,raw:x.raw})),
      payload
    },null,2));
    console.log(`  SquashLevels diagnostic written: ${path.basename(SQUASHLEVELS_DEBUG_FILE)}`);
  }catch{}
}
async function searchSquashLevels(player){
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),20000);
  try{
    const r=await fetch(SQUASHLEVELS_SEARCH_URL,{method:'POST',headers:{
      'Content-Type':'application/json','Accept':'application/json','User-Agent':'Mozilla/5.0','Origin':'https://squashlevels.com','Referer':'https://squashlevels.com/'
    },body:JSON.stringify({name:squashLevelsSearchName(player.name),includeClubs:true,clubsOnly:false}),signal:controller.signal});
    if(!r.ok)throw new Error(`HTTP ${r.status}`);
    const payload=await r.json();
    const rows=squashLevelsCandidates(payload,player.name).filter(x=>!/club|venue|court/.test(x.type));
    // Name is the first gate, but SquashLevels may append country/metadata to the API result string.
    // Accept candidates whose structured result contains the exact player name; country is verified on the profile page.
    const exact=rows.filter(x=>(sameName(x.name,player.name)||squashLevelsObjectContainsExactName(x.raw,player.name)||squashLevelsObjectContainsExactName(x.parent,player.name))&&(squashLevelsUrlFromCandidate(x)||slId(x.raw)||slId(x.parent)));
    if(!exact.length)writeSquashLevelsDebug(player,payload,rows);
    const seen=new Set();
    return exact.map(c=>({
      url:canonicalSquashLevelsProfileUrl(squashLevelsUrlFromCandidate(c)),
      playerId:c.id||slId(c.raw)||slId(c.parent)||squashLevelsPlayerIdFromUrl(squashLevelsUrlFromCandidate(c)),
      name:clean(c.name),
      raw:c.raw,
      parent:c.parent,
      apiCountryCode:squashLevelsCountryCodeFromApiCandidate(c),
      apiAge:squashLevelsAgeFromApiCandidate(c)
    })).filter(x=>{
      if(!x.url)return false;
      const key=x.playerId?`id:${x.playerId}`:`url:${x.url.toLowerCase()}`;
      if(seen.has(key))return false;
      seen.add(key);
      return true;
    }).slice(0,8);
  }finally{clearTimeout(timer)}
}

async function searchSquashLevelsByName(searchName,targetName){
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),20000);
  try{
    const r=await fetch(SQUASHLEVELS_SEARCH_URL,{method:'POST',headers:{
      'Content-Type':'application/json','Accept':'application/json','User-Agent':'Mozilla/5.0','Origin':'https://squashlevels.com','Referer':'https://squashlevels.com/'
    },body:JSON.stringify({name:squashLevelsSearchName(searchName),includeClubs:true,clubsOnly:false}),signal:controller.signal});
    if(!r.ok)throw new Error(`HTTP ${r.status}`);
    const payload=await r.json();
    // Parse candidates against the name we actually searched for.
    // Important for nickname retries: a search for 'Sue Hillier' must allow 'Sue Hillier'
    // into the candidate set even though the tournament player is named 'Susan Hillier'.
    const rows=squashLevelsCandidates(payload,searchName).filter(x=>!/club|venue|court/.test(x.type));
    const seen=new Set(), out=[];
    for(const c of rows){
      const rawUrl=squashLevelsUrlFromCandidate(c); if(!rawUrl)continue;
      const playerId=clean(c.id||slId(c.raw)||slId(c.parent)||squashLevelsPlayerIdFromUrl(rawUrl));
      const url=canonicalSquashLevelsProfileUrl(rawUrl);
      // SquashLevels can surface the same player via app.squashlevels.com, squashlevels.com,
      // player_detail vs player_detail.php, and URLs with extra query parameters. Identity is the
      // player id, not the raw URL. Fall back to the canonical URL only when no id is exposed.
      const key=playerId?`id:${playerId}`:`url:${url.toLowerCase()}`;
      if(seen.has(key))continue;
      seen.add(key);
      out.push({
        url,playerId,name:clean(c.name),raw:c.raw,parent:c.parent,
        apiCountryCode:squashLevelsCountryCodeFromApiCandidate(c),
        apiAge:squashLevelsAgeFromApiCandidate(c)
      });
    }
    return out.slice(0,20);
  }finally{clearTimeout(timer)}
}

async function searchSquashLevelsNicknameFallback(player){
  const {first,last}=splitPersonName(player.name);
  if(!first||!last)return [];
  const variants=nicknameVariants(first);
  if(!variants.length)return [];
  // Search each explicit nickname + surname. Do not do a broad surname-only search: it
  // adds unrelated candidates and can hide the actual nickname result in the API slice.
  const searches=variants.map(v=>`${v} ${last}`);
  const combined=[],seen=new Set();
  for(const q of searches){
    const rows=await searchSquashLevelsByName(q,q);
    for(const c of rows){
      const key=c.playerId?`id:${c.playerId}`:`url:${canonicalSquashLevelsProfileUrl(c.url).toLowerCase()}`;
      if(seen.has(key))continue;
      seen.add(key);
      combined.push({...c,url:canonicalSquashLevelsProfileUrl(c.url)});
    }
  }
  return combined;
}

async function chooseSquashLevelsNicknameCandidate(page,candidates,player){
  const wanted=splitPersonName(player.name);

  // 1. Exact surname from the SquashLevels search API result.
  let pool=candidates.filter(c=>sameSimpleName(splitPersonName(c.name).last,wanted.last));
  if(!pool.length)return null;

  // Attach the country/age metadata that SquashLevels already returns in its search result.
  // Do not depend on opening the profile page for these identity fields.
  let checked=pool.map(c=>{
    const countryCode=clean(c.apiCountryCode).toUpperCase();
    const age=c.apiAge==null?null:Number(c.apiAge);
    const expectedCodes=squashLevelsExpectedCountryCodes(player);
    const expectedAge=squashLevelsExpectedAge(player);
    return {...c,identity:{
      countryCode,age,expectedCodes,expectedAge,
      countryMatch:countryCode?expectedCodes.includes(countryCode):null,
      ageMatch:age==null||expectedAge==null?null:age===expectedAge
    }};
  });

  const describe=rows=>rows.map(x=>`${x.name} [${x.identity.countryCode||'?'} O${x.identity.age||'?'} id=${x.playerId||'?'}]`).join(' | ');

  // 2. Exact country. The API should expose this; explicit mismatches are rejected.
  const countryExact=checked.filter(x=>x.identity.countryMatch===true);
  if(countryExact.length)pool=countryExact;
  else{
    const unknown=checked.filter(x=>x.identity.countryMatch==null);
    if(!unknown.length){
      console.log(`    Nickname candidates for ${player.name}: no exact-country match. ${describe(checked)}`);
      return null;
    }
    // Keep unknown only as a defensive fallback; diagnostic makes parser gaps obvious.
    pool=unknown;
    console.log(`    Nickname candidates for ${player.name}: country not parsed from API result. ${describe(checked)}`);
  }

  // 3. Exact age group. Prefer exact age; reject explicit mismatches.
  const ageExact=pool.filter(x=>x.identity.ageMatch===true);
  if(ageExact.length)pool=ageExact;
  else{
    const unknown=pool.filter(x=>x.identity.ageMatch==null);
    if(!unknown.length){
      console.log(`    Nickname candidates for ${player.name}: no exact-age match. ${describe(pool)}`);
      return null;
    }
    pool=unknown;
    console.log(`    Nickname candidates for ${player.name}: age not parsed from API result. ${describe(pool)}`);
  }

  // 4. Controlled nickname equivalence from the external nickname file.
  const nicknameMatches=pool.filter(x=>nicknameEquivalent(splitPersonName(x.name).first,wanted.first));
  if(nicknameMatches.length!==1){
    console.log(`    Nickname candidates for ${player.name}: ${nicknameMatches.length} matching profile(s) after surname/country/age/nickname. ${describe(pool)}`);
    return null;
  }
  return nicknameMatches[0];
}

function groupedInteger(value){
  if(value==null)return null;
  // SquashLevels uses commas as thousands separators: 2,396 => 2396; 14,782 => 14782.
  // Allow whitespace/newlines between grouped digits because styled DOM nodes may split the number.
  const raw=String(value).replace(/\u00a0/g,' ').trim();
  const matches=[...raw.matchAll(/#?\b(\d{1,3}(?:[ ,\n\r\t]\d{3})+|\d+)\b/g)];
  if(!matches.length)return null;
  for(const m of matches){
    const digits=m[1].replace(/[^0-9]/g,'');
    if(digits){const n=Number(digits);if(Number.isSafeInteger(n)&&n>0)return n;}
  }
  return null;
}
function metricAfterLabel(text,label){
  const source=String(text||'').replace(/\u00a0/g,' ');
  const lines=source.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const want=String(label).toLowerCase();
  for(let i=0;i<lines.length;i++){
    if(lines[i].toLowerCase()===want){
      // Join nearby lines as well as testing each one. This handles numbers split as "2" + ",396".
      const nearby=lines.slice(i+1,Math.min(lines.length,i+6));
      for(let count=1;count<=Math.min(3,nearby.length);count++){
        const n=groupedInteger(nearby.slice(0,count).join(''));
        if(n)return n;
      }
      for(const line of nearby){const n=groupedInteger(line);if(n)return n;}
    }
  }
  const escaped=String(label).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const re=new RegExp(`(?:^|\\n)\\s*${escaped}\\s*(?:\\n|:)?\\s*([^\\n]{0,40}(?:\\n[^\\n]{0,40}){0,2})`,'i');
  const m=source.match(re);
  return m?groupedInteger(m[1]):null;
}
async function metricFromProfilePage(page,label){
  const isLevel=String(label||'').toLowerCase()==='level';

  function parseExactMetric(raw,{allowMasked=false}={}){
    const text=String(raw||'').replace(/&nbsp;/gi,' ').replace(/\u00a0/g,' ').replace(/<[^>]*>/g,' ').trim();
    // SquashLevels may deliberately mask the headline as 5XX/3XX for automated sessions.
    // Never turn a masked value into a number.
    if(!allowMasked && /x/i.test(text))return null;
    const exact=text.match(/^\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\s*$/);
    if(!exact)return null;
    const value=Number(exact[1].replace(/,/g,''));
    if(!Number.isSafeInteger(value)||value<=0)return null;
    if(isLevel&&value<=100)return null;
    return value;
  }

  const deadline=Date.now()+5000;
  while(Date.now()<deadline){
    for(const frame of page.frames()){
      try{
        if(isLevel){
          // AUTHORITATIVE LEVEL SOURCE:
          // Level stats -> Current. Example SquashLevels markup:
          // <div id="levels_row" class="row"> ...
          //   <span>Current</span><div class="larger_text">3,810</div>
          // </div>
          const currentRows=frame.locator('#levels_row .row_data');
          const rowCount=await currentRows.count();
          for(let i=0;i<rowCount;i++){
            const row=currentRows.nth(i);
            const rowText=(await row.innerText().catch(()=>'' )).trim();
            if(!/^current\b/i.test(rowText))continue;
            const valueText=await row.locator('.larger_text').first().innerText().catch(()=> '');
            const value=parseExactMetric(valueText);
            if(value)return value;
          }

          // Same extraction directly from rendered HTML. This avoids any locator/rendering quirks.
          const html=await frame.content();
          const levelsStart=html.search(/<[^>]*id=["']levels_row["'][^>]*>/i);
          const block=levelsStart>=0 ? html.slice(levelsStart,levelsStart+2500) : '';
          const currentRe=/<span[^>]*>\s*Current\s*<\/span>\s*<div[^>]*class=["'][^"']*\blarger_text\b[^"']*["'][^>]*>\s*([^<]+?)\s*<\/div>/ig;
          let cm;
          while(block && (cm=currentRe.exec(block))!==null){
            const value=parseExactMetric(cm[1]);
            if(value)return value;
          }

          // Fallback 2: the Level history chart contains a hidden accessible table.
          // The first data row is the most recent recorded level on observed SquashLevels profiles.
          const historyRows=frame.locator('#level_chart table tbody tr');
          const historyCount=await historyRows.count();
          for(let i=0;i<historyCount;i++){
            const cells=historyRows.nth(i).locator('td');
            if(await cells.count()<2)continue;
            const valueText=await cells.nth(1).innerText().catch(()=> '');
            const value=parseExactMetric(valueText);
            if(value)return value;
          }

          // Fallback 3: match-history blocks embed authoritative JSON.
          // player_info.level_after is the player's level after that match. Match history is newest first.
          const jsonScripts=frame.locator('script[id^="classic-json-data-match-"]');
          const jsonCount=await jsonScripts.count();
          for(let i=0;i<jsonCount;i++){
            const raw=await jsonScripts.nth(i).textContent().catch(()=> '');
            if(!raw)continue;
            try{
              const data=JSON.parse(raw);
              const candidates=[
                data?.player_info?.level_after,
                data?.match_details?.player_match_levels?.levelafter,
                data?.match_details?.playerteam_levels?.levelafter
              ];
              for(const c of candidates){
                const value=parseExactMetric(String(c??''));
                if(value)return value;
              }
            }catch{}
          }

          // Last resort: the headline is usable only when SquashLevels exposes a completely numeric value.
          // Values such as 5XX or 1X,XXX are intentionally masked and must never be interpreted.
          const headlineTexts=await frame.locator('.headline_player_level').allTextContents();
          for(const text of headlineTexts){
            const value=parseExactMetric(text);
            if(value)return value;
          }
        }else{
          // World ranking has a dedicated exact class and is not masked in the observed pages.
          const texts=await frame.locator('.ranking_pos.ranking_scope_type_system').allTextContents();
          for(const text of texts){
            const value=parseExactMetric(text);
            if(value)return value;
          }
          const html=await frame.content();
          const re=/<[^>]*class=["'][^"']*\branking_pos\b[^"']*\branking_scope_type_system\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/ig;
          let m;
          while((m=re.exec(html))!==null){
            const value=parseExactMetric(m[1]);
            if(value)return value;
          }
        }
      }catch{}
    }
    await page.waitForTimeout(200);
  }
  return null;
}

async function squashLevelsMetricDiagnostics(page){
  const rows=[];
  for(const frame of page.frames()){
    try{
      const levels=await frame.locator('.headline_player_level').allTextContents();
      const worlds=await frame.locator('.ranking_pos.ranking_scope_type_system').allTextContents();
      const html=await frame.content();
      const levelHtmlMatches=[...html.matchAll(/<[^>]*class=[\"'][^\"']*\bheadline_player_level\b[^\"']*[\"'][^>]*>([\s\S]*?)<\/[^>]+>/ig)].slice(0,10).map(m=>m[1].replace(/<[^>]*>/g,' ').trim());
      const worldHtmlMatches=[...html.matchAll(/<[^>]*class=[\"'][^\"']*\branking_pos\b[^\"']*\branking_scope_type_system\b[^\"']*[\"'][^>]*>([\s\S]*?)<\/[^>]+>/ig)].slice(0,10).map(m=>m[1].replace(/<[^>]*>/g,' ').trim());
      rows.push({url:frame.url(),levelCount:levels.length,levelTexts:levels.slice(0,10),worldCount:worlds.length,worldTexts:worlds.slice(0,10),levelHtmlMatches,worldHtmlMatches});
    }catch(e){rows.push({url:frame.url(),error:e.message});}
  }
  return rows;
}

async function acceptSquashLevelsCookiePreferences(page){
  const selectors=[
    '#onetrust-accept-btn-handler',
    'button#onetrust-accept-btn-handler',
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("Accept cookies")',
    'button:has-text("Allow all")',
    'button:has-text("Allow All")',
    'button:has-text("Agree")',
    'button:has-text("I agree")',
    'button:has-text("Got it")'
  ];
  for(const selector of selectors){
    try{
      const button=page.locator(selector).first();
      if(await button.count() && await button.isVisible().catch(()=>false)){
        await button.click({timeout:2500}).catch(()=>{});
        await page.waitForTimeout(500);
        console.log(`SquashLevels cookie preferences: accepted via ${selector}.`);
        return true;
      }
    }catch{}
  }
  // Some consent managers render inside an iframe.
  for(const frame of page.frames()){
    for(const text of [/accept\s+all/i,/accept\s+cookies/i,/allow\s+all/i,/i\s+agree/i]){
      try{
        const button=frame.getByRole('button',{name:text}).first();
        if(await button.count() && await button.isVisible().catch(()=>false)){
          await button.click({timeout:2500}).catch(()=>{});
          await page.waitForTimeout(500);
          console.log(`SquashLevels cookie preferences: accepted in consent frame (${text}).`);
          return true;
        }
      }catch{}
    }
  }
  return false;
}

function exactSquashLevelsLevelText(raw){
  const text=String(raw||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
  if(!text || /x/i.test(text))return null;
  const m=text.match(/^([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\s*(\(\s*P\s*\))?$/i);
  if(!m)return null;
  const value=Number(m[1].replace(/,/g,''));
  return Number.isSafeInteger(value)&&value>100?{value,provisional:!!m[2],raw:text}:null;
}

async function squashLevelsProfileAuthState(page){
  return await page.evaluate(()=>{
    const clean=v=>String(v||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
    const rows=[...document.querySelectorAll('#levels_row .row_data')];
    let currentLevel='';
    for(const row of rows){
      const label=clean(row.querySelector('span')?.textContent);
      if(label.toLowerCase()==='current'){
        currentLevel=clean(row.querySelector('.larger_text')?.textContent);
        break;
      }
    }
    const body=clean(document.body?.innerText);
    return {
      finalUrl:location.href,
      compareWithMe:!!document.querySelector('#compare_with_me'),
      loginForm:!!document.querySelector('input[type="password"]'),
      logoutText:/\blog\s*out\b/i.test(body),
      headlineLevel:clean(document.querySelector('.headline_player_level')?.textContent),
      currentLevel,
      world:clean(document.querySelector('.ranking_pos.ranking_scope_type_system')?.textContent),
      levelsRowCount:rows.length
    };
  });
}


function waitForEnter(promptText){
  return new Promise(resolve=>{
    process.stdout.write(`\n${promptText}\nPress ENTER here when finished... `);
    process.stdin.resume();
    process.stdin.once('data',()=>resolve());
  });
}

function savedSquashLevelsStorageState(){
  const githubActions=String(process.env.GITHUB_ACTIONS||'').toLowerCase()==='true';
  // Local runs must prefer the freshly exported files created by
  // `npm run refresh:squashlevels-login`. GitHub Actions has no persistent
  // local login files, so there the repository Secret remains authoritative.
  if(!githubActions&&fs.existsSync(SQUASHLEVELS_STORAGE_FILE)){
    console.log(`SquashLevels session source: local ${path.basename(SQUASHLEVELS_STORAGE_FILE)}`);
    try{return JSON.parse(fs.readFileSync(SQUASHLEVELS_STORAGE_FILE,'utf8'));}catch(e){throw new Error(`could not read ${path.basename(SQUASHLEVELS_STORAGE_FILE)}: ${e.message}`);}
  }
  if(process.env.SQUASHLEVELS_STORAGE_STATE_B64){
    console.log('SquashLevels session source: SQUASHLEVELS_STORAGE_STATE_B64');
    try{return JSON.parse(Buffer.from(process.env.SQUASHLEVELS_STORAGE_STATE_B64,'base64').toString('utf8'));}catch(e){throw new Error(`invalid SQUASHLEVELS_STORAGE_STATE_B64: ${e.message}`);}
  }
  if(fs.existsSync(SQUASHLEVELS_STORAGE_FILE)){
    console.log(`SquashLevels session source: local ${path.basename(SQUASHLEVELS_STORAGE_FILE)}`);
    try{return JSON.parse(fs.readFileSync(SQUASHLEVELS_STORAGE_FILE,'utf8'));}catch(e){throw new Error(`could not read ${path.basename(SQUASHLEVELS_STORAGE_FILE)}: ${e.message}`);}
  }
  console.log('SquashLevels session source: none');
  return null;
}

function savedSquashLevelsSessionStorage(){
  const githubActions=String(process.env.GITHUB_ACTIONS||'').toLowerCase()==='true';
  if(!githubActions&&fs.existsSync(SQUASHLEVELS_SESSION_FILE)){
    console.log(`SquashLevels sessionStorage source: local ${path.basename(SQUASHLEVELS_SESSION_FILE)}`);
    try{return JSON.parse(fs.readFileSync(SQUASHLEVELS_SESSION_FILE,'utf8'));}catch(e){throw new Error(`could not read ${path.basename(SQUASHLEVELS_SESSION_FILE)}: ${e.message}`);}
  }
  if(process.env.SQUASHLEVELS_SESSION_STORAGE_B64){
    console.log('SquashLevels sessionStorage source: SQUASHLEVELS_SESSION_STORAGE_B64');
    try{return JSON.parse(Buffer.from(process.env.SQUASHLEVELS_SESSION_STORAGE_B64,'base64').toString('utf8'));}catch(e){throw new Error(`invalid SQUASHLEVELS_SESSION_STORAGE_B64: ${e.message}`);}
  }
  if(fs.existsSync(SQUASHLEVELS_SESSION_FILE)){
    console.log(`SquashLevels sessionStorage source: local ${path.basename(SQUASHLEVELS_SESSION_FILE)}`);
    try{return JSON.parse(fs.readFileSync(SQUASHLEVELS_SESSION_FILE,'utf8'));}catch(e){throw new Error(`could not read ${path.basename(SQUASHLEVELS_SESSION_FILE)}: ${e.message}`);}
  }
  console.log('SquashLevels sessionStorage source: none');
  return {};
}

async function newSquashLevelsContext(browser,useSavedState=true){
  const opts={viewport:{width:1280,height:900},locale:'en-AU',timezoneId:'Australia/Perth'};
  const storage=useSavedState?savedSquashLevelsStorageState():null;
  if(storage)opts.storageState=storage;
  const context=await browser.newContext(opts);
  const session=useSavedState?savedSquashLevelsSessionStorage():{};
  if(session&&Object.keys(session).length){
    await context.addInitScript(({origin,values})=>{
      if(location.origin!==origin)return;
      for(const [k,v] of Object.entries(values||{}))sessionStorage.setItem(k,String(v));
    },{origin:'https://app.squashlevels.com',values:session});
  }
  return context;
}

// Session verification must be completely independent of identity matching/enrichment.
// Use one known-good SquashLevels profile by immutable player ID so a bad/missing
// tournament-to-SquashLevels mapping can never be misdiagnosed as an expired login.
const SQUASHLEVELS_SESSION_PROBE={
  name:'Sue Hillier',
  squashLevelsPlayerId:'26429',
  squashLevelsUrl:'https://app.squashlevels.com/player_detail.php?player=26429'
};

function squashLevelsProbe(_players){
  return SQUASHLEVELS_SESSION_PROBE;
}


function printSquashLevelsCookieExpiry(cookies,label='SquashLevels cookie expiry'){
  const list=Array.isArray(cookies)?cookies:[];
  const persistent=list
    .filter(c=>Number.isFinite(Number(c.expires))&&Number(c.expires)>0)
    .map(c=>({...c,expiresNumber:Number(c.expires)}))
    .sort((a,b)=>a.expiresNumber-b.expiresNumber);
  const session=list.filter(c=>!Number.isFinite(Number(c.expires))||Number(c.expires)<=0);

  console.log(`${label}:`);
  if(!list.length){
    console.log('  No cookies found.');
    return;
  }
  console.log(`  Persistent cookies: ${persistent.length}`);
  console.log(`  Session-only cookies: ${session.length}`);
  for(const c of persistent){
    const when=new Date(c.expiresNumber*1000);
    console.log(`  ${c.name} (${c.domain}) expires: ${when.toISOString()}`);
  }
  if(session.length){
    console.log(`  Session-only: ${session.map(c=>`${c.name} (${c.domain})`).join(', ')}`);
  }
  if(persistent.length){
    const first=persistent[0];
    const last=persistent[persistent.length-1];
    console.log(`  Earliest persistent expiry: ${new Date(first.expiresNumber*1000).toISOString()} [${first.name}]`);
    console.log(`  Latest persistent expiry:   ${new Date(last.expiresNumber*1000).toISOString()} [${last.name}]`);
  }else{
    console.log('  No persistent-cookie expiry timestamps are available; all cookies are session-only.');
  }
}

async function verifySquashLevelsProfileSession(page,context,players,label='SquashLevels saved-session verification'){
  const probe=squashLevelsProbe(players);
  if(!probe)throw new Error('no resolved SquashLevels profile is available to verify the session');
  const probeUrl=canonicalSquashLevelsProfileUrl(probe.squashLevelsUrl);
  await safeGoto(page,probeUrl,2);
  await page.waitForTimeout(1300);
  await acceptSquashLevelsCookiePreferences(page);
  await page.waitForTimeout(900);
  const state=await squashLevelsProfileAuthState(page);
  const cookies=await context.cookies('https://app.squashlevels.com').catch(()=>[]);
  const exact=exactSquashLevelsLevelText(state.currentLevel)||exactSquashLevelsLevelText(state.headlineLevel);
  console.log(label+':');
  console.log(`  Player: ${probe.name}`);
  console.log(`  Profile authenticated marker (#compare_with_me): ${state.compareWithMe?'YES':'NO'}`);
  console.log(`  SquashLevels cookies on profile: ${cookies.length}`);
  console.log(`  Login form present on profile: ${state.loginForm?'YES':'NO'}`);
  console.log(`  Logout text present on profile: ${state.logoutText?'YES':'NO'}`);
  console.log(`  Final profile URL: ${state.finalUrl||page.url()||'(missing)'}`);
  console.log(`  Headline Level: ${state.headlineLevel||'(missing)'}`);
  console.log(`  Level stats -> Current: ${state.currentLevel||'(missing)'}`);
  console.log(`  World ranking: ${state.world||'(missing)'}`);
  return {probe,probeUrl,state,cookies,exact};
}

async function setupInteractiveSquashLevelsLogin(players){
  console.log('\n=== SQUASHLEVELS INTERACTIVE LOGIN (:squashlevels-login) ===');
  console.log('A visible Chrome window will open. Complete cookie preferences, login and any human verification yourself.');
  console.log('No CAPTCHA/human-verification step is automated.');
  const browser=await launchBrowser(false);
  const context=await newSquashLevelsContext(browser,false);
  const page=await context.newPage();
  try{
    await safeGoto(page,'https://app.squashlevels.com/',2).catch(()=>{});
    await page.waitForTimeout(600);
    await acceptSquashLevelsCookiePreferences(page);
    await safeGoto(page,SQUASHLEVELS_LOGIN_URL,2);
    await page.waitForTimeout(700);
    await acceptSquashLevelsCookiePreferences(page);

    // Convenience only: pre-fill configured credentials, but leave the final login/human checks to the user.
    if(SQUASHLEVELS_EMAIL&&SQUASHLEVELS_PASSWORD){
      const email=page.locator('input[type="email"], input[name*="email" i], input[id*="email" i]').first();
      const password=page.locator('input[type="password"]').first();
      if(await email.count())await email.fill(SQUASHLEVELS_EMAIL).catch(()=>{});
      if(await password.count())await password.fill(SQUASHLEVELS_PASSWORD).catch(()=>{});
      console.log('Configured SquashLevels credentials were pre-filled where possible.');
    }

    while(true){
      await waitForEnter('In the Chrome window: accept cookie preferences, log in, and complete any SquashLevels human verification. It is OK if SquashLevels leaves you on the dashboard.');

      // SquashLevels normally redirects to its dashboard after a successful login.
      const dashboardUrl=page.url();
      console.log(`\nLogin window currently at: ${dashboardUrl}`);

      // Do NOT expect the dashboard itself to contain player-profile markers.
      // Deliberately navigate this exact same authenticated tab to a known player profile.
      // We capture the state AFTER that verification because SquashLevels can update
      // cookies/localStorage/sessionStorage while entering an authenticated profile.
      let result=null;
      try{
        result=await verifySquashLevelsProfileSession(page,context,players,'SquashLevels interactive-login profile verification');
      }catch(e){
        console.log(`Profile verification could not be completed: ${e.message}`);
      }

      if(result&&result.state&&result.state.compareWithMe&&result.exact){
        const capturedStorageState=await context.storageState();
        const capturedSession=await page.evaluate(()=>{
          const out={};
          try{for(let i=0;i<sessionStorage.length;i++){const k=sessionStorage.key(i);if(k!=null)out[k]=sessionStorage.getItem(k);}}catch{}
          return out;
        }).catch(()=>({}));

        fs.writeFileSync(SQUASHLEVELS_STORAGE_FILE,JSON.stringify(capturedStorageState,null,2));
        fs.writeFileSync(SQUASHLEVELS_SESSION_FILE,JSON.stringify(capturedSession||{},null,2));

        // Also create one-line Base64 files specifically for GitHub Actions secrets.
        // Do not print the secret values to the console.
        const storageB64=Buffer.from(JSON.stringify(capturedStorageState),'utf8').toString('base64');
        const sessionB64=Buffer.from(JSON.stringify(capturedSession||{}),'utf8').toString('base64');
        fs.writeFileSync(SQUASHLEVELS_STORAGE_B64_FILE,storageB64+'\n');
        fs.writeFileSync(SQUASHLEVELS_SESSION_B64_FILE,sessionB64+'\n');

        console.log(`\nAuthenticated SquashLevels state saved successfully.`);
        console.log(`  ${path.basename(SQUASHLEVELS_STORAGE_FILE)}`);
        console.log(`  ${path.basename(SQUASHLEVELS_SESSION_FILE)}`);
        console.log(`  ${path.basename(SQUASHLEVELS_STORAGE_B64_FILE)}  -> GitHub secret SQUASHLEVELS_STORAGE_STATE_B64`);
        console.log(`  ${path.basename(SQUASHLEVELS_SESSION_B64_FILE)} -> GitHub secret SQUASHLEVELS_SESSION_STORAGE_B64`);
        console.log(`  Verified exact Level: ${result.exact.raw}`);
        printSquashLevelsCookieExpiry(capturedStorageState.cookies,'SquashLevels saved-session cookie expiry');
        console.log('Keep these session files private; do not commit them.');
        console.log('After updating the two GitHub secrets, run a new GitHub Actions workflow.');
        return;
      }

      console.log('\nThe known player profile is still restricted/masked, so the login state was NOT saved.');
      console.log('The browser will return to the login page. Complete login/verification again, then press ENTER. Use Ctrl+C to cancel.');
      await safeGoto(page,SQUASHLEVELS_LOGIN_URL,2).catch(()=>{});
      await page.waitForTimeout(500);
      await acceptSquashLevelsCookiePreferences(page);
    }
  }finally{
    await page.close().catch(()=>{});
    await context.close().catch(()=>{});
    await browser.close().catch(()=>{});
  }
}

async function openSavedSquashLevelsSession(context,players){
  if(!savedSquashLevelsStorageState()){
    throw new Error('No saved interactive SquashLevels login was found. Run `npm run refresh:squashlevels-login` first.');
  }
  const page=await context.newPage();
  try{
    const result=await verifySquashLevelsProfileSession(page,context,players);
    const state=result?.state||{};
    const finalUrl=String(state.finalUrl||page.url()||'');
    const explicitLoginRedirect=/\/login(?:[/?#]|$)|sign[_-]?in|log[_-]?in/i.test(finalUrl);
    const explicitLoginForm=!!state.loginForm;

    console.log(`  Login form present on profile: ${explicitLoginForm?'YES':'NO'}`);
    console.log(`  Logout text present on profile: ${state.logoutText?'YES':'NO'}`);
    console.log(`  Final profile URL: ${finalUrl||'(missing)'}`);

    // Only explicit evidence that SquashLevels sent us back to login is fatal.
    // UI markers, Level and ranking can temporarily be absent because the profile
    // page can render differently or load those values asynchronously.
    if(explicitLoginRedirect||explicitLoginForm){
      throw new Error('Saved SquashLevels session was redirected to an explicit login page/form. Run `npm run refresh:squashlevels-login` again.');
    }

    if(result.exact){
      console.log(`SquashLevels saved login verified with exact Level ${result.exact.raw}.`);
    }else{
      console.log('SquashLevels saved-session warning: exact Level/profile markers were not visible on the probe page, but no explicit login redirect/form was detected. Continuing with the saved session.');
    }
    return page;
  }catch(e){
    await page.close().catch(()=>{});
    throw e;
  }
}

async function loginSquashLevels(context,players=[]){
  if(!SQUASHLEVELS_EMAIL||!SQUASHLEVELS_PASSWORD){
    throw new Error('SquashLevels credentials are required for exact Level refreshes.');
  }
  const page=await context.newPage();
  try{
    // 1) Establish consent state BEFORE login.
    await safeGoto(page,'https://app.squashlevels.com/',2).catch(()=>{});
    await page.waitForTimeout(700);
    await acceptSquashLevelsCookiePreferences(page);

    // 2) Login in this same browser context.
    await safeGoto(page,SQUASHLEVELS_LOGIN_URL,2);
    await page.waitForTimeout(700);
    await acceptSquashLevelsCookiePreferences(page);
    let email=page.locator('input[type="email"], input[name*="email" i], input[id*="email" i]').first();
    let password=page.locator('input[type="password"]').first();
    if(!(await email.count())||!(await password.count())){
      const loginLink=page.getByRole('link',{name:/log\s*in/i}).first();
      if(await loginLink.count()){await loginLink.click();await page.waitForTimeout(700);}
      await acceptSquashLevelsCookiePreferences(page);
      email=page.locator('input[type="email"], input[name*="email" i], input[id*="email" i]').first();
      password=page.locator('input[type="password"]').first();
    }
    if(!(await email.count())||!(await password.count()))throw new Error('login form fields were not found');
    await email.fill(SQUASHLEVELS_EMAIL);
    await password.fill(SQUASHLEVELS_PASSWORD);
    const submit=page.getByRole('button',{name:/log\s*in|sign\s*in/i}).first();
    if(await submit.count())await submit.click();
    else{
      const inputSubmit=page.locator('input[type="submit"]').first();
      if(await inputSubmit.count())await inputSubmit.click(); else await password.press('Enter');
    }
    await page.waitForTimeout(2200);
    await acceptSquashLevelsCookiePreferences(page);

    // 3) Prove authentication on an actual player profile, not on the login page.
    const probe=squashLevelsProbe(players);
    const probeUrl=canonicalSquashLevelsProfileUrl(probe.squashLevelsUrl);
    await safeGoto(page,probeUrl,2);
    await page.waitForTimeout(1500);
    await acceptSquashLevelsCookiePreferences(page);
    await page.waitForTimeout(1200);

    const state=await squashLevelsProfileAuthState(page);
    const cookies=await context.cookies('https://app.squashlevels.com').catch(()=>[]);
    const exact=exactSquashLevelsLevelText(state.currentLevel)||exactSquashLevelsLevelText(state.headlineLevel);
    const diagnostic={player:probe.name,url:probeUrl,cookieCount:cookies.length,cookieNames:cookies.map(c=>c.name),...state,exactLevel:exact?.value??null};
    fs.writeFileSync(path.join(DIR,'squashlevels-session-check.json'),JSON.stringify(diagnostic,null,2));

    console.log('SquashLevels authenticated-session verification:');
    console.log(`  Player: ${probe.name}`);
    console.log(`  Profile authenticated marker (#compare_with_me): ${state.compareWithMe?'YES':'NO'}`);
    console.log(`  SquashLevels cookies on profile: ${cookies.length}`);
    console.log(`  Login form present on profile: ${state.loginForm?'YES':'NO'}`);
    console.log(`  Headline Level: ${state.headlineLevel||'(missing)'}`);
    console.log(`  Level stats -> Current: ${state.currentLevel||'(missing)'}`);
    console.log(`  World ranking: ${state.world||'(missing)'}`);

    if(!state.compareWithMe){
      throw new Error('login did not persist to the individual SquashLevels profile page (#compare_with_me missing)');
    }
    if(!exact){
      throw new Error(`profile is authenticated but exact Level is still unavailable/masked (headline=${state.headlineLevel||'missing'}, current=${state.currentLevel||'missing'})`);
    }
    console.log(`SquashLevels login: authenticated profile session verified with exact Level ${exact.raw}.`);
    // IMPORTANT: keep this exact page alive. SquashLevels appears to keep part of the
    // authenticated state in tab-scoped sessionStorage, so new tabs may be restricted.
    return page;
  }catch(e){
    await page.close().catch(()=>{});
    throw e;
  }
}

async function readSquashLevelsWorld(page){
  // Prefer the ranking card whose scope label is literally "World".
  // Some SquashLevels profiles render World / country / region / club cards but do not
  // put ranking_scope_type_system on the World value, so relying on that class alone
  // can incorrectly produce TBD even when the World rank is plainly visible.
  const deadline=Date.now()+5000;
  while(Date.now()<deadline){
    let explicitTbd=false;
    for(const frame of page.frames()){
      try{
        const result=await frame.evaluate(()=>{
          const clean=v=>String(v||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
          const labels=[...document.querySelectorAll('.ranking_scope_name')];
          for(const label of labels){
            if(clean(label.textContent).toLowerCase()!=='world')continue;

            // Walk up through a few ancestors until we find the ranking value that belongs
            // to this exact World scope. This avoids confusing it with AUS/state/club ranks.
            let node=label.parentElement;
            for(let depth=0;node&&depth<6;depth++,node=node.parentElement){
              const value=node.querySelector('.ranking_pos');
              if(value){
                const raw=clean(value.textContent);
                if(raw)return {raw,source:'world-scope'};
              }
            }

            // Last local fallback: a nearby sibling in layouts where label/value share a row.
            const parent=label.parentElement;
            if(parent){
              const raw=clean(parent.textContent).replace(/^World\s*/i,'').trim();
              if(raw)return {raw,source:'world-parent'};
            }
          }
          return null;
        }).catch(()=>null);

        if(result?.raw){
          if(/^TBD$/i.test(result.raw))explicitTbd=true;
          else{const n=groupedInteger(result.raw);if(n)return n;}
        }

        // Existing markup used on many profiles. Keep it as the secondary fallback.
        const els=frame.locator('.ranking_pos.ranking_scope_type_system');
        const count=await els.count();
        for(let i=0;i<count;i++){
          const raw=String(await els.nth(i).textContent().catch(()=>'' )).trim();
          if(/^TBD$/i.test(raw)){explicitTbd=true;continue;}
          const n=groupedInteger(raw); if(n)return n;
        }

        // Text fallback for another observed layout: a World label followed immediately by
        // its value. Restrict the search to the ranking area where possible.
        const text=await frame.locator('[class*=ranking]').allTextContents().catch(()=>[]);
        for(const block of text){
          const lines=String(block||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
          for(let i=0;i<lines.length;i++){
            if(lines[i].toLowerCase()!=='world')continue;
            const nearby=lines.slice(i+1,i+4).join(' ');
            if(/^TBD$/i.test(nearby)){explicitTbd=true;continue;}
            const n=groupedInteger(nearby);if(n)return n;
          }
        }
      }catch{}
    }
    if(explicitTbd)return 'TBD';
    await page.waitForTimeout(200);
  }
  return null;
}

async function readSquashLevelsLevel(page){
  // Exact SquashLevels markup supplied by the user:
  // #levels_row .row_data -> label "Current" -> .larger_text
  // fallback: .headline_player_level
  function parseLevelText(raw){
    const text=String(raw||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
    if(!text || /x/i.test(text))return null;
    const m=text.match(/^\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\s*(\(\s*P\s*\))?\s*$/i);
    if(!m)return null;
    const value=Number(m[1].replace(/,/g,''));
    if(!Number.isSafeInteger(value)||value<=100)return null;
    return {value,provisional:!!m[2],display:`${value.toLocaleString('en-US')}${m[2]?' (P)':''}`};
  }

  // The ranking block is available very early, but the Level section can be hydrated later.
  // Wait for the exact Level elements rather than relying on a fixed 700 ms sleep.
  const deadline=Date.now()+8000;
  while(Date.now()<deadline){
    for(const frame of page.frames()){
      try{
        const rows=frame.locator('#levels_row .row_data');
        const count=await rows.count();
        for(let i=0;i<count;i++){
          const row=rows.nth(i);
          const label=String(await row.locator('span').first().textContent().catch(()=>''))
            .replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
          if(label.toLowerCase()!=='current')continue;
          const raw=await row.locator('.larger_text').first().textContent().catch(()=> '');
          const parsed=parseLevelText(raw);
          if(parsed)return parsed;
        }

        // Exact DOM-evaluation equivalent. textContent is used intentionally because the
        // Level stats block may exist while hidden/collapsed and innerText can then be blank.
        const exact=await frame.evaluate(()=>{
          const rows=[...document.querySelectorAll('#levels_row .row_data')];
          for(const row of rows){
            const label=(row.querySelector('span')?.textContent||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
            if(label.toLowerCase()!=='current')continue;
            return (row.querySelector('.larger_text')?.textContent||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
          }
          return '';
        }).catch(()=> '');
        const parsedExact=parseLevelText(exact);
        if(parsedExact)return parsedExact;

        const headlines=await frame.locator('.headline_player_level').allTextContents();
        for(const raw of headlines){
          const parsed=parseLevelText(raw);
          if(parsed)return parsed;
        }
      }catch{}
    }
    await page.waitForTimeout(250);
  }
  return null;
}

async function resolveSquashLevelsLinks(players,sharedContext=null,sharedPage=null){
  const now=Date.now();

  const tournamentNameCounts=new Map();
  for(const p of players||[]){
    const k=nameKey(p?.name);
    if(k)tournamentNameCounts.set(k,(tournamentNameCounts.get(k)||0)+1);
  }
  const duplicateTournamentNameKeys=new Set(
    [...tournamentNameCounts.entries()]
      .filter(([,count])=>count>1)
      .map(([key])=>key)
  );

  // During :squashlevels, re-run the lightweight search API for mappings that are already
  // verified. This is intentionally NOT a full re-verification of every profile page.
  // We only open candidate profile pages when the search reveals multiple plausible profiles.
  const verifiedToDuplicateCheck=SQUASHLEVELS_ONLY
    ? players.filter(p=>p.squashLevelsUrl&&p.squashLevelsIdentityVerified)
    : [];

  const existingToValidate=players.filter(p=>p.squashLevelsUrl&&!p.squashLevelsIdentityVerified);
  const missing=players.filter(p=>!p.squashLevelsUrl&&(SQUASHLEVELS_ONLY||!p.squashLevelsSearchCheckedAt||now-new Date(p.squashLevelsSearchCheckedAt).getTime()>=SQUASHLEVELS_RECHECK_MS));
  const queue=[...verifiedToDuplicateCheck,...existingToValidate,...missing];

  if(!queue.length)return {found:0,verified:0,rejected:0,failed:0,duplicateChecked:0,duplicatesFound:0,remapped:0};

  if(verifiedToDuplicateCheck.length){
    console.log(`SquashLevels: duplicate-checking ${verifiedToDuplicateCheck.length} existing verified profile mapping(s) using the search API; only duplicate candidate sets will open profile pages...`);
  }
  console.log(`SquashLevels: identity-checking ${queue.length} profile mapping(s); nickname fallback uses exact surname -> exact country -> exact age group -> external nickname list...`);

  const ownsBrowser=!sharedContext;
  const browser=ownsBrowser?await launchBrowser():null;
  const context=sharedContext||await browser.newContext({viewport:{width:1280,height:900},locale:'en-AU',timezoneId:'Australia/Perth'});
  const page=sharedPage||(ownsBrowser?await loginSquashLevels(context,players):await context.newPage());

  let done=0,found=0,verified=0,rejected=0,failed=0;
  let duplicateChecked=0,duplicatesFound=0,remapped=0;

  while(queue.length){
    const p=queue.shift();
    const requiresExactAge=duplicateTournamentNameKeys.has(nameKey(p.name));
    const isVerifiedDuplicateRecheck=!!(SQUASHLEVELS_ONLY&&p.squashLevelsUrl&&p.squashLevelsIdentityVerified);

    try{
      let candidates=[];
      let accepted=null;

      if(isVerifiedDuplicateRecheck){
        duplicateChecked++;

        const currentUrl=canonicalSquashLevelsProfileUrl(p.squashLevelsUrl);
        const currentId=clean(p.squashLevelsPlayerId||squashLevelsPlayerIdFromUrl(currentUrl));
        const fresh=await searchSquashLevels(p);
        p.squashLevelsSearchCheckedAt=new Date().toISOString();

        // For a UNIQUE TournamentSoftware name, 0/1 exact-name search result is enough
        // to keep an already verified mapping. For a DUPLICATE tournament name this
        // shortcut is forbidden: the cached profile must be reopened and its age checked.
        if(fresh.length<=1&&!requiresExactAge){
          done++;
          if(done%40===0||queue.length===0){
            console.log(`  ${done} identity checks · ${verified} verified · ${duplicatesFound} duplicate set(s) · ${remapped} remapped · ${rejected} rejected · ${failed} failures`);
          }
          await sleep(25);
          continue;
        }

        const requiresExactAgeForSelection=requiresExactAge||fresh.length>1;
        if(fresh.length>1||requiresExactAge)duplicatesFound++;
        if(fresh.length>1&&!requiresExactAge){
          console.log(
            `  SquashLevels same-name ambiguity for ${p.name}: ${fresh.length} exact-name profiles; ` +
            `requiring explicit O${p.ageGroup} age evidence.`
          );
        }

        // Multiple SquashLevels profiles with the same exact name are ambiguous
        // even when TournamentSoftware itself contains only one such name.
        // Require explicit Masters age evidence before retaining/selecting one.

        // Ensure the currently cached profile participates in the comparison even if a
        // SquashLevels search response happens to omit it.
        const compare=[...fresh];
        const currentPresent=compare.some(c=>{
          const id=clean(c.playerId||squashLevelsPlayerIdFromUrl(c.url));
          return (currentId&&id&&currentId===id)||canonicalSquashLevelsProfileUrl(c.url)===currentUrl;
        });
        if(!currentPresent){
          compare.push({
            url:currentUrl,
            playerId:currentId,
            name:p.name,
            existing:true
          });
        }

        accepted=await chooseSquashLevelsCandidate(page,compare,p,requiresExactAgeForSelection);

        if(accepted){
          const chosenUrl=canonicalSquashLevelsProfileUrl(accepted.url);
          const chosenId=clean(accepted.playerId||squashLevelsPlayerIdFromUrl(chosenUrl));
          const changed=chosenUrl!==currentUrl||(chosenId&&currentId&&chosenId!==currentId);

          if(changed){
            console.log(`  SquashLevels mapping corrected for ${p.name}:`);
            console.log(`    old: ${currentUrl}`);
            console.log(`    new: ${chosenUrl}`);
            remapped++;
          }

          p.squashLevelsUrl=chosenUrl;
          p.squashLevelsPlayerId=chosenId;
          p.squashLevelsIdentityVerified=true;
          p.squashLevelsIdentityVerifiedAt=new Date().toISOString();
          p.squashLevelsMatchedCountry=accepted.identity.countryCode||p.squashLevelsMatchedCountry||null;
          p.squashLevelsMatchedAge=accepted.identity.age??p.squashLevelsMatchedAge??null;
          verified++;
        }else if(requiresExactAgeForSelection){
          // For either a duplicate TournamentSoftware name OR multiple exact-name
          // SquashLevels profiles, unresolved age evidence is unsafe. Clear the
          // cached mapping rather than displaying another same-name person's data.
          console.log(
            `  Ambiguous-name mapping rejected for ${p.name}: no candidate had an ` +
            `explicit ${p.ageGroup}+ age match. Clearing cached SquashLevels identity.`
          );
          p.squashLevelsUrl='';
          p.squashLevelsPlayerId='';
          p.squashLevelsIdentityVerified=false;
          p.squashLevelsIdentityVerifiedAt=null;
          p.squashLevelsMatchedCountry=null;
          p.squashLevelsMatchedAge=null;
          p.squashLevelsProfileCheckedAt=null;
          p.squashLevelsWorldRank=null;
          p.squashLevelsLevel=null;
          p.squashLevelsLevelProvisional=false;
          rejected++;
        }else{
          // Unique-name mappings keep their prior verified identity when a recheck
          // cannot distinguish anything better.
          console.log(`  Duplicate check unresolved for ${p.name}; keeping existing verified profile ${currentUrl}`);
        }
      }else{
        if(p.squashLevelsUrl&&!p.squashLevelsIdentityVerified){
          candidates=[{
            url:canonicalSquashLevelsProfileUrl(p.squashLevelsUrl),
            playerId:p.squashLevelsPlayerId||squashLevelsPlayerIdFromUrl(p.squashLevelsUrl),
            existing:true
          }];
        }else{
          candidates=await searchSquashLevels(p);
          p.squashLevelsSearchCheckedAt=new Date().toISOString();
        }

        let requiresExactAgeForSelection=requiresExactAge||candidates.length>1;
        accepted=await chooseSquashLevelsCandidate(page,candidates,p,requiresExactAgeForSelection);
        if(!accepted&&candidates.length)rejected+=candidates.length;

        if(!accepted&&candidates.some(c=>c.existing)){
          p.squashLevelsUrl='';
          p.squashLevelsPlayerId='';
          p.squashLevelsIdentityVerified=false;
          delete p.squashLevelsLevel;
          p.squashLevelsWorldRank=null;

          const fresh=await searchSquashLevels(p);
          p.squashLevelsSearchCheckedAt=new Date().toISOString();
          requiresExactAgeForSelection=requiresExactAge||fresh.length>1;
          accepted=await chooseSquashLevelsCandidate(page,fresh,p,requiresExactAgeForSelection);
          if(!accepted&&fresh.length)rejected+=fresh.length;
        }

        if(!accepted&&!p.squashLevelsUrl){
          const variants=nicknameVariants(splitPersonName(p.name).first);
          if(variants.length){
            const fallback=await searchSquashLevelsNicknameFallback(p);
            const nicknameAccepted=await chooseSquashLevelsNicknameCandidate(page,fallback,p);
            if(nicknameAccepted&&(!requiresExactAgeForSelection||nicknameAccepted.identity?.ageMatch===true)){
              accepted=nicknameAccepted;
              console.log(`  Nickname match: ${p.name} -> ${nicknameAccepted.name} (${nicknameAccepted.identity.countryCode}, O${nicknameAccepted.identity.age})`);
            }else if(nicknameAccepted&&requiresExactAgeForSelection){
              console.log(
                `  Nickname candidate rejected for ambiguous name ${p.name}: ` +
                `no explicit ${p.ageGroup}+ age match.`
              );
            }else if(fallback.length){
              console.log(`  Nickname fallback unresolved for ${p.name}; ${fallback.length} candidate(s) found, no unique surname/country/age/nickname match.`);
            }
          }
        }

        if(accepted){
          const wasMissing=!p.squashLevelsUrl;
          p.squashLevelsUrl=canonicalSquashLevelsProfileUrl(accepted.url);
          p.squashLevelsPlayerId=accepted.playerId||squashLevelsPlayerIdFromUrl(accepted.url)||'';
          p.squashLevelsIdentityVerified=true;
          p.squashLevelsIdentityVerifiedAt=new Date().toISOString();
          p.squashLevelsMatchedCountry=accepted.identity.countryCode||null;
          p.squashLevelsMatchedAge=accepted.identity.age||null;
          if(wasMissing)found++;
          verified++;
        }else if(!p.squashLevelsUrl){
          p.squashLevelsIdentityVerified=false;
        }
      }
    }catch(e){
      failed++;
      console.log(`  SquashLevels identity lookup failed for ${p.name}: ${e.message}`);
      // Existing verified mappings are deliberately retained on duplicate-check failures.
    }

    done++;
    if(done%40===0||queue.length===0){
      console.log(`  ${done} identity checks · ${verified} verified · ${duplicatesFound} duplicate set(s) · ${remapped} remapped · ${rejected} rejected · ${failed} failures`);
    }
    await sleep(100);
  }

  if(!sharedPage)await page.close().catch(()=>{});
  if(ownsBrowser)await browser.close();

  if(verifiedToDuplicateCheck.length){
    console.log(`SquashLevels duplicate recheck complete: ${duplicateChecked} cached mapping(s) searched, ${duplicatesFound} duplicate set(s) inspected, ${remapped} mapping(s) corrected.`);
  }

  return {found,verified,rejected,failed,duplicateChecked,duplicatesFound,remapped};
}

// Removed duplicate verifySquashLevelsProfileSession implementation.
// The interactive/saved-session verifier above deliberately reuses the existing logged-in page.


async function readSquashLevelsClubLocation(page,player){
  const evidence=await readSquashLevelsProfileEvidence(page,player||{name:''});
  const v=clean(evidence?.clubLocation||''); return /^TBD$/i.test(v)?'':v;
}

async function refreshSquashLevelsProfileMetrics(players,sharedContext=null,sharedPage=null){
  const queue=players.filter(p=>p.squashLevelsUrl&&p.squashLevelsIdentityVerified);
  if(!queue.length)return {ranked:0,leveled:0,failed:0};
  const workerCount=Math.min(SQUASHLEVELS_METRIC_WORKERS,queue.length);
  console.log(`SquashLevels: reading current World ranking + Level from all ${queue.length} resolved profile page(s) with ${workerCount} authenticated worker tab(s)...`);
  const stopTiming=phaseTimer('SquashLevels rankings/levels/club-location');
  const ownsBrowser=!sharedContext;
  const browser=ownsBrowser?await launchBrowser():null;
  const context=sharedContext||await browser.newContext({viewport:{width:1280,height:900},locale:'en-AU',timezoneId:'Australia/Perth'});
  const primaryPage=sharedPage||(ownsBrowser?await loginSquashLevels(context,players):await context.newPage());
  const workQueue=[...queue];
  const retryQueue=[];
  const extraPages=[];
  let done=0,ranked=0,leveled=0,failed=0,diagnosticSlots=3;

  async function processProfile(page,p,isRetry=false){
    const showDiagnostic=!isRetry&&diagnosticSlots>0;
    if(showDiagnostic)diagnosticSlots--;
    try{
      const profileUrl=canonicalSquashLevelsProfileUrl(p.squashLevelsUrl);
      if(profileUrl!==p.squashLevelsUrl)p.squashLevelsUrl=profileUrl;
      await safeGoto(page,profileUrl,2);
      await waitForSquashLevelsProfileReady(page,900);
      if(showDiagnostic){
        const st=await squashLevelsProfileAuthState(page);
        console.log(`  Worker-tab check ${p.name}: auth=${st.compareWithMe?'YES':'NO'}, headline=${st.headlineLevel||'(missing)'}, current=${st.currentLevel||'(missing)'}`);
      }
      const world=await readSquashLevelsWorld(page);
      const level=await readSquashLevelsLevel(page);
      const clubLocation=await readSquashLevelsClubLocation(page,p);
      if(showDiagnostic)console.log(`    Club/location: ${clubLocation||'(missing)'}`);
      p.squashLevelsProfileCheckedAt=new Date().toISOString();
      p.squashLevelsWorldRank=world??null;
      p.squashLevelsLevel=level?.value??null;
      p.squashLevelsLevelProvisional=!!level?.provisional;
      p.squashLevelsClubLocation=clubLocation||p.squashLevelsClubLocation||'';
      if(world!==null&&world!==undefined&&String(world).trim()!=='')ranked++;
      if(level?.value)leveled++;
      return true;
    }catch(e){
      if(!isRetry){
        retryQueue.push(p);
        console.log(`  SquashLevels worker retry queued for ${p.name}: ${e.message}`);
      }else{
        failed++;
        p.squashLevelsProfileCheckedAt=new Date().toISOString();
        console.log(`  SquashLevels profile failed for ${p.name} after sequential retry: ${e.message}`);
      }
      return false;
    }
  }

  async function worker(page){
    while(workQueue.length){
      const p=workQueue.shift();
      await processProfile(page,p,false);
      done++;
      if(done%40===0||done===queue.length)console.log(`  ${done}/${queue.length} profiles · ${ranked} World rankings · ${leveled} Levels · ${retryQueue.length} retry queued`);
    }
  }

  try{
    const pages=[primaryPage];
    for(let i=1;i<workerCount;i++){
      const p=await context.newPage();
      await installSessionStorageClone(primaryPage,p);
      extraPages.push(p);pages.push(p);
    }
    await Promise.all(pages.map(worker));

    // Safety net: concurrent tabs are only the fast path. Any navigation/parser failure is
    // retried once in the original authenticated tab so optimization cannot reduce coverage.
    if(retryQueue.length){
      console.log(`SquashLevels: retrying ${retryQueue.length} profile(s) sequentially in the original authenticated tab...`);
      const uniqueRetries=[];const seen=new Set();
      for(const p of retryQueue){const k=canonicalSquashLevelsProfileUrl(p.squashLevelsUrl);if(seen.has(k))continue;seen.add(k);uniqueRetries.push(p);}
      for(let i=0;i<uniqueRetries.length;i++){
        await processProfile(primaryPage,uniqueRetries[i],true);
        if((i+1)%20===0||i+1===uniqueRetries.length)console.log(`  Sequential retries ${i+1}/${uniqueRetries.length} · ${failed} final failure(s)`);
      }
    }
  }finally{
    for(const p of extraPages)await p.close().catch(()=>{});
    if(!sharedPage)await primaryPage.close().catch(()=>{});
    if(ownsBrowser)await browser.close();
    stopTiming();
  }
  return {ranked,leveled,failed};
}

async function enrichSquashLevels(players){
  const stopSquashTiming=phaseTimer('SquashLevels total');
  // One browser context AND one browser PAGE for the entire SquashLevels phase.
  // This preserves cookies, localStorage and tab-scoped sessionStorage from login.
  const browser=await launchBrowser();
  const context=await newSquashLevelsContext(browser,true);
  let page=null;
  try{
    // Prefer a previously verified interactive session when available (local runs or
    // GitHub session-state secrets). On a fresh GitHub Actions runner there is no local
    // session file, so fall back to SQUASHLEVELS_EMAIL / SQUASHLEVELS_PASSWORD.
    if(savedSquashLevelsStorageState()){
      page=await openSavedSquashLevelsSession(context,players);
    }else if(SQUASHLEVELS_EMAIL&&SQUASHLEVELS_PASSWORD){
      console.log('No saved SquashLevels session found; attempting credential login from environment/config.');
      page=await loginSquashLevels(context,players);
    }else{
      throw new Error('No SquashLevels session or credentials are available. Locally run `npm run refresh:squashlevels-login`, or configure SQUASHLEVELS_EMAIL and SQUASHLEVELS_PASSWORD.');
    }
    const stopLinkTiming=phaseTimer('SquashLevels identity/duplicate resolution');
    const linkResult=await resolveSquashLevelsLinks(players,context,page);
    stopLinkTiming();
    for(const p of players){
      if(!p.squashLevelsUrl||!p.squashLevelsIdentityVerified){
        p.squashLevelsWorldRank=null;
        p.squashLevelsLevel=null;
        p.squashLevelsLevelProvisional=false;
      }
    }
    const metricResult=await refreshSquashLevelsProfileMetrics(players,context,page);
    const totalLinks=players.filter(p=>p.squashLevelsUrl).length;
    const totalRanked=players.filter(p=>p.squashLevelsWorldRank!==null&&p.squashLevelsWorldRank!==undefined&&String(p.squashLevelsWorldRank).trim()!=='').length;
    const totalLeveled=players.filter(p=>Number(p.squashLevelsLevel)>0).length;
    console.log(`SquashLevels: ${linkResult.found} new link(s), ${linkResult.verified} identity mapping(s) verified, ${linkResult.duplicatesFound||0} duplicate set(s) inspected, ${linkResult.remapped||0} cached mapping(s) corrected, ${linkResult.rejected} candidate(s) rejected, ${metricResult.ranked} World ranking(s) refreshed, ${metricResult.leveled} Level(s) refreshed, ${linkResult.failed+metricResult.failed} failure(s).`);
    console.log(`SquashLevels links stored: ${totalLinks}/${players.length}`);
    console.log(`SquashLevels World rankings stored (including TBD): ${totalRanked}/${players.length}`);
    console.log(`SquashLevels Levels stored: ${totalLeveled}/${players.length}`);
    return players;
  }finally{
    if(page)await page.close().catch(()=>{});
    await browser.close().catch(()=>{});
    stopSquashTiming();
  }
}


async function fetchSquashScoresLiveMatches(canonicalPlayers){
  try{
    const url=`${SQUASH_SCORES_API_URL}&_=${Date.now()}`;
    const response=await fetch(url,{headers:{'accept':'application/json'}});
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const payload=await response.json();
    const locations=Array.isArray(payload?.locations)?payload.locations:[];

    const byName=new Map((canonicalPlayers||[]).map(p=>[nameKey(p.name),p]));
    const canonicalName=raw=>byName.get(nameKey(raw))?.name||clean(raw);
    const rows=[];

    for(const location of locations){
      for(const m of Array.isArray(location?.matches)?location.matches:[]){
        const player1=canonicalName(m?.player1Name||'');
        const player2=canonicalName(m?.player2Name||'');
        if(!player1||!player2)continue;

        const rawDate=clean(m?.matchDate||m?.date||'');
        let date=parseDate(rawDate);
        if(!date){
          const dm=rawDate.match(/^(2026)-(\d{2})-(\d{2})/);
          if(dm)date=`${dm[1]}-${dm[2]}-${dm[3]}`;
        }
        if(!date)continue;

        let time='';
        const description=clean(m?.description||'');
        let tm=description.match(/\b(\d{1,2}):([0-5]\d)\b/);
        if(!tm)tm=rawDate.match(/[T\s](\d{1,2}):([0-5]\d)/);
        if(tm)time=`${String(Number(tm[1])).padStart(2,'0')}:${tm[2]}`;
        const timeFromDescription=!!tm;

        const games=Array.isArray(m?.games)?m.games:[];
        const scorePairs=[];
        let p1Games=0,p2Games=0;
        for(const g of games){
          const a=Number(g?.player1Score),b=Number(g?.player2Score);
          if(!Number.isFinite(a)||!Number.isFinite(b))continue;
          if(a===0&&b===0)continue;
          scorePairs.push(`${a}-${b}`);
          if(a>b)p1Games++; else if(b>a)p2Games++;
        }

        const apiP1=Number(m?.player1GamesWon),apiP2=Number(m?.player2GamesWon);
        if(Number.isFinite(apiP1))p1Games=apiP1;
        if(Number.isFinite(apiP2))p2Games=apiP2;

        const completed=p1Games>=3||p2Games>=3;
        const live=!completed&&(scorePairs.length>0||p1Games>0||p2Games>0);

        rows.push({
          date,time,movedTime:timeFromDescription?time:'',timeFromDescription,
          player1,player2,
          result:scorePairs.join(', '),
          status:completed?'completed':(live?'live':'scheduled'),
          venue:clean(location?.name||location?.locationName||''),
          court:clean(m?.courtName||m?.court||''),
          event:clean(m?.categoryName||m?.category||''),
          round:description,
          rawText:`SquashScores API ${clean(m?.id||m?.matchId||'')}`,
          source:'SquashScores'
        });
      }
    }

    const groups=new Map();
    for(const row of rows){
      const key=`${canonicalTournamentDate(row.date)}|${[nameKey(row.player1),nameKey(row.player2)].sort().join('~')}`;
      if(!groups.has(key))groups.set(key,[]);
      groups.get(key).push(row);
    }

    const collapsed=[];
    for(const group of groups.values()){
      if(group.length===1){collapsed.push(group[0]);continue;}
      const times=[...new Set(group.map(x=>clean(x.time)).filter(Boolean))];
      const active=group
        .filter(x=>x.status==='live'||x.status==='completed'||x.result)
        .sort((a,b)=>String(b.result||'').length-String(a.result||'').length);

      if(times.length>1){
        let current=active[0];
        if(!current)current=group.slice().sort((a,b)=>clean(b.time).localeCompare(clean(a.time)))[0];
        const other=times.filter(t=>clean(t)!==clean(current.time));
        if(other.length)current={...current,originalTime:other.slice().sort()[0],timeMoved:true};
        collapsed.push(current);
      }else{
        collapsed.push(group.slice().sort((a,b)=>{
          const ar=(a.status==='completed'?3000:a.status==='live'?2000:0)+String(a.result||'').length;
          const br=(b.status==='completed'?3000:b.status==='live'?2000:0)+String(b.result||'').length;
          return br-ar;
        })[0]);
      }
    }

    console.log(`SquashScores API: ${locations.length} location(s), ${collapsed.length} match(es) after move/dedupe, ${collapsed.filter(m=>m.result).length} with score data.`);
  if(!locations.length)console.warn('WARNING: SquashScores API returned no locations/matches in this refresh. TournamentSoftware data will be published without SquashScores augmentation.');
    return collapsed;
  }catch(e){
    console.warn(`SquashScores API refresh skipped: ${e.message}`);
    return [];
  }
}

function orientSquashScoresResult(existing,live){
  const result=clean(live?.result||'');
  if(!result)return '';

  const reversed=
    sameName(existing?.player1,live?.player2) &&
    sameName(existing?.player2,live?.player1);

  if(!reversed)return result;

  return [...result.matchAll(/(\d{1,2})\s*[-–—]\s*(\d{1,2})/g)]
    .map(x=>`${Number(x[2])}-${Number(x[1])}`)
    .join(', ');
}

function enrichScheduleWithTournamentResults(schedule,resultRows){
  const out=(schedule||[]).map(m=>({...m,rawText:''}));

  const pairKey=m=>{
    const ids=[String(m.player1Id||''),String(m.player2Id||'')].filter(Boolean).sort();
    if(ids.length===2)return ids.join('|');
    return [nameKey(m.player1),nameKey(m.player2)].sort().join('|');
  };

  for(const r of resultRows||[]){
    if(!r?.result)continue;

    const candidates=out.filter(m=>
      canonicalTournamentDate(m.date)===canonicalTournamentDate(r.date) &&
      pairKey(m)===pairKey(r)
    );
    if(candidates.length!==1)continue;

    const target=candidates[0];
    // Never replace a newly scraped TournamentSoftware score with stale data.
    if(!target.result){
      target.result=r.result;
      target.status='completed';
      target.resultSource='TournamentSoftware';
    }
  }

  return out;
}






function drawAuthorityEvidenceSummary(drawRows,matchesRows=[]){
  const exactKey=m=>[
    canonicalTournamentDate(m?.date),
    clean(m?.time||'').toLowerCase(),
    ...[
      nameKey(splitPlayerSeed(m?.player1||'').name),
      nameKey(splitPlayerSeed(m?.player2||'').name)
    ].sort()
  ].join('|');

  const matchesExact=new Set((matchesRows||[]).map(exactKey));
  const summary={
    total:0,
    officialMatch:0,
    tree:0,
    structural:0,
    inline:0,
    visualWithLocation:0,
    visualCorroboratedByMatches:0,
    rejectedVisual:0
  };

  for(const m of drawRows||[]){
    if(!m?.date||!m?.time||!m?.player1||!m?.player2)continue;
    summary.total++;

    const sources=new Set([...(m.evidenceSources||[]),m.source].map(clean).filter(Boolean));
    const validLocation=
      /^(?:Karrinyup Shopping Centre|Squashworld Mirrabooka|Belmont Saints Squash Centre)$/i.test(clean(m.venue||'')) &&
      !!sanitizeCourtValue(m.court);

    if(sources.has('TournamentSoftware Match')){
      summary.officialMatch++;
    }else if(sources.has('TournamentSoftware Draw Tree')){
      summary.tree++;
    }else if(sources.has('TournamentSoftware Draw Structural')){
      summary.structural++;
    }else if(sources.has('TournamentSoftware Draw Inline')){
      summary.inline++;
    }else if(sources.has('TournamentSoftware Draw Visual')&&validLocation){
      summary.visualWithLocation++;
    }else if(sources.has('TournamentSoftware Draw Visual')&&matchesExact.has(exactKey(m))){
      summary.visualCorroboratedByMatches++;
    }else if(sources.has('TournamentSoftware Draw Visual')){
      summary.rejectedVisual++;
    }
  }

  return summary;
}


function extractTournamentLocationFromText(text){
  const s=clean(text||'');
  if(!s)return {venue:'',court:''};

  const venueMatch=s.match(
    /\b(Squashworld\s+Mirrabooka|Belmont\s+Saints\s+Squash\s+Centre|Karrinyup\s+Shopping\s+Centre)\b/i
  );
  const courtMatch=s.match(
    /\b(AGC(?:\s*\d+)?|SC\s*\d+|Court\s*\d+)\b/i
  );

  return {
    venue:venueMatch?clean(venueMatch[1]):'',
    court:courtMatch?sanitizeCourtValue(courtMatch[1]):''
  };
}

function provenLocationFromRow(row){
  const direct={
    venue:clean(row?.venue||''),
    court:sanitizeCourtValue(row?.court)
  };

  if(
    /^(?:Karrinyup Shopping Centre|Squashworld Mirrabooka|Belmont Saints Squash Centre)$/i.test(direct.venue) &&
    direct.court
  ){
    return direct;
  }

  const fromText=extractTournamentLocationFromText(
    `${row?.rawText||''} ${row?.context||''} ${row?.text||''}`
  );

  return {
    venue:direct.venue||fromText.venue,
    court:direct.court||fromText.court
  };
}

function assertDeterministicDrawCompleteness(officialDraw,label='Official draw crawl'){
  if((officialDraw?.failed||0)>0){
    throw new Error(
      `${label} had ${officialDraw.failed} incomplete/failed age-group draw page(s). `+
      `Existing published data was left unchanged.`
    );
  }

  const missingTreeDraws=officialDraw?.missingTreeDraws||[];
  if(missingTreeDraws.length){
    throw new Error(
      `${label} was incomplete for ${missingTreeDraws.length} main draw(s): `+
      missingTreeDraws.map(x=>`${x.drawName} (${x.players} players)`).join(', ')+
      `. Existing published data was left unchanged.`
    );
  }

  if((officialDraw?.mainTreeDraws||0)<20){
    throw new Error(
      `${label} exposed only ${officialDraw?.mainTreeDraws||0} main age-group draw(s). `+
      `Existing published data was left unchanged.`
    );
  }

  if((officialDraw?.players||[]).length<900){
    throw new Error(
      `${label} exposed only ${(officialDraw?.players||[]).length} unique players. `+
      `Existing published data was left unchanged.`
    );
  }

  if((officialDraw?.treeObservations||0)<300){
    throw new Error(
      `${label} produced only ${officialDraw?.treeObservations||0} deterministic tree observations. `+
      `Existing published data was left unchanged.`
    );
  }

  console.log(
    `DRAW TREE completeness: ${officialDraw.mainTreeDraws} main draw(s), `+
    `${officialDraw.treeObservations} deterministic observation(s), `+
    `${(officialDraw.players||[]).length} unique draw player(s), 0 missing main trees.`
  );
}

function buildDrawAuthoritativeTournamentSchedule(existingRows,drawRows,matchesRows,{preserveHistory=true}={}){
  const today=perthTodayIsoRefresh();

  const realPlayer=name=>!!name&&!/^(?:TBD|Bye)$/i.test(clean(name));
  const tbdPlayer=name=>/^TBD$/i.test(clean(name||''));
  const dateKey=m=>canonicalTournamentDate(m?.date);
  const timeKey=m=>clean(m?.time||'').toLowerCase();
  const pairKey=m=>[
    nameKey(splitPlayerSeed(m?.player1||'').name),
    nameKey(splitPlayerSeed(m?.player2||'').name)
  ].sort().join('|');
  const exactKey=m=>`${dateKey(m)}|${timeKey(m)}|${pairKey(m)}`;
  const pairDay=m=>`${dateKey(m)}|${pairKey(m)}`;

  const validVenue=v=>
    /^(?:Karrinyup Shopping Centre|Squashworld Mirrabooka|Belmont Saints Squash Centre)$/i.test(clean(v||''));

  const validLocation=m=>validVenue(m?.venue)&&!!sanitizeCourtValue(m?.court);

  const fresh=(matchesRows||[])
    .filter(m=>m?.date&&m?.time&&realPlayer(m.player1)&&realPlayer(m.player2))
    .map(m=>({...m,court:sanitizeCourtValue(m.court),rawText:''}));

  const matchesExact=new Set(fresh.map(exactKey));

  // Collect every exact draw observation as metadata evidence, even if the
  // observation itself is not trusted to create fixture existence.
  const drawMetaByExact=new Map();
  for(const m0 of drawRows||[]){
    const treeTbd=!!m0?.deterministicTbd &&
      ((realPlayer(m0.player1)&&tbdPlayer(m0.player2))||(tbdPlayer(m0.player1)&&realPlayer(m0.player2)));
    if(!m0?.date||!m0?.time||(!(realPlayer(m0.player1)&&realPlayer(m0.player2))&&!treeTbd))continue;

    const loc=provenLocationFromRow(m0);
    const m={
      ...m0,
      player1:splitPlayerSeed(m0.player1).name,
      player2:splitPlayerSeed(m0.player2).name,
      venue:loc.venue,
      court:loc.court
    };

    const k=exactKey(m);
    if(!drawMetaByExact.has(k))drawMetaByExact.set(k,[]);
    drawMetaByExact.get(k).push(m);
  }

  const drawMetaByPairDay=new Map();
  for(const rows of drawMetaByExact.values()){
    for(const m of rows){
      const k=pairDay(m);
      if(!drawMetaByPairDay.has(k))drawMetaByPairDay.set(k,[]);
      drawMetaByPairDay.get(k).push(m);
    }
  }

  const evidenceSummary=drawAuthorityEvidenceSummary(drawRows,matchesRows);

  // Fixture existence authority:
  //   1. deterministic TournamentSoftware bracket-tree relationship
  //      (numeric slot tree or modern explicit match wrapper)
  //   2. official TournamentSoftware match evidence
  //   3. old inline/structural/visual extractors are corroboration/metadata only
  //      and cannot independently create a fixture.
  const authorityCandidates=[];

  for(const m0 of drawRows||[]){
    const sourceSet0=new Set([...(m0?.evidenceSources||[]),m0?.source].map(clean).filter(Boolean));
    const treeTbd=!!m0?.deterministicTbd && sourceSet0.has('TournamentSoftware Draw Tree') &&
      ((realPlayer(m0.player1)&&tbdPlayer(m0.player2))||(tbdPlayer(m0.player1)&&realPlayer(m0.player2)));
    const concrete=realPlayer(m0?.player1)&&realPlayer(m0?.player2);

    if(!m0?.date||!m0?.time||(!concrete&&!treeTbd))continue;
    if(!isTournamentDate(dateKey(m0)))continue;
    if(treeTbd&&dateKey(m0)<today)continue;

    const loc=provenLocationFromRow(m0);
    const m={
      ...m0,
      player1:splitPlayerSeed(m0.player1).name,
      player2:splitPlayerSeed(m0.player2).name,
      venue:loc.venue,
      court:loc.court
    };

    const sources=new Set([...(m.evidenceSources||[]),m.source].map(clean).filter(Boolean));

    const strong=
      sources.has('TournamentSoftware Match') ||
      sources.has('TournamentSoftware Draw Tree');

    const corroboratedLegacy=
      (
        sources.has('TournamentSoftware Draw Inline') ||
        sources.has('TournamentSoftware Draw Structural') ||
        sources.has('TournamentSoftware Draw Visual')
      ) &&
      matchesExact.has(exactKey(m));

    if(!strong&&!corroboratedLegacy)continue;
    if(treeTbd&&!validLocation(m))continue;

    m.status=String(m.status||'').toLowerCase()==='completed'?'completed':'scheduled';
    m.source='TournamentSoftware Official Draw';
    m.drawEvidenceSources=[...sources];

    authorityCandidates.push(m);
  }

  const richness=m=>
    (m.result?10000:0)+
    (m.winner?5000:0)+
    (validLocation(m)?1000:0)+
    (m.event?50:0)+
    (m.round?25:0)+
    (m.player1Id?5:0)+
    (m.player2Id?5:0);

  const authorityMap=new Map();
  for(const m of authorityCandidates){
    const k=exactKey(m);
    const old=authorityMap.get(k);
    if(!old||richness(m)>richness(old))authorityMap.set(k,m);
  }

  let authoritative=[...authorityMap.values()];

  // Deterministic contradiction handling.
  //
  // No weighted scoring is used. The explicit TournamentSoftware draw tree is
  // the schedule authority, the Matches page is secondary, and legacy
  // extractors are lowest priority.
  //
  // Equal-strength contradictory fixtures are never guessed.
  const sideIdentity=(m,side)=>{
    const id=clean(side===1?m.player1Id:m.player2Id);
    if(id)return `id:${id.toLowerCase()}`;

    const name=nameKey(side===1?m.player1:m.player2);
    const age=clean(m.ageGroup||m.age||'');
    const gender=clean(m.gender||'');
    const event=clean(m.event||'');
    return `ctx:${name}|${gender}|${age}|${event}`;
  };

  const playerSlot=(m,side)=>[
    dateKey(m),
    timeKey(m),
    sideIdentity(m,side)
  ].join('|');

  const authorityTier=m=>{
    const sources=new Set([
      ...(m.drawEvidenceSources||[]),
      ...(m.evidenceSources||[]),
      m.source
    ].map(clean).filter(Boolean));

    if(sources.has('TournamentSoftware Draw Tree'))return 3;
    if(sources.has('TournamentSoftware Match'))return 2;
    if(
      sources.has('TournamentSoftware Draw Inline') ||
      sources.has('TournamentSoftware Draw Structural') ||
      sources.has('TournamentSoftware Draw Visual')
    )return 1;
    return 0;
  };

  const slotCandidates=new Map();
  for(const m of authoritative){
    for(const side of [1,2]){
      const sideName=side===1?m.player1:m.player2;
      if(tbdPlayer(sideName)||/^Bye$/i.test(clean(sideName||'')))continue;
      const slot=playerSlot(m,side);
      if(!slotCandidates.has(slot))slotCandidates.set(slot,new Map());
      slotCandidates.get(slot).set(exactKey(m),m);
    }
  }

  const rejectedFixtureKeys=new Set();
  const hardAmbiguities=[];

  for(const [slot,candidateMap] of slotCandidates){
    const candidates=[...candidateMap.values()];
    if(candidates.length<=1)continue;

    const bestTier=Math.max(...candidates.map(authorityTier));
    const strongest=candidates.filter(m=>authorityTier(m)===bestTier);

    if(strongest.length!==1){
      hardAmbiguities.push({slot,candidates:strongest});
      continue;
    }

    const keepKey=exactKey(strongest[0]);
    for(const m of candidates){
      if(exactKey(m)!==keepKey)rejectedFixtureKeys.add(exactKey(m));
    }
  }

  if(hardAmbiguities.length){
    const sample=hardAmbiguities.slice(0,8).map(x=>
      x.candidates.map(m=>
        `${m.date} ${m.time} ${m.player1} vs ${m.player2} [tier ${authorityTier(m)}]`
      ).join(' / ')
    ).join(' | ');

    throw new Error(
      `DRAW AUTHORITY found ${hardAmbiguities.length} equal-strength contradictory player/date/time slot(s). ` +
      `No fixture was guessed. Existing published data was left unchanged. Sample: ${sample}`
    );
  }

  if(rejectedFixtureKeys.size){
    const before=authoritative.length;
    authoritative=authoritative.filter(m=>!rejectedFixtureKeys.has(exactKey(m)));
    console.log(
      `DRAW AUTHORITY deterministic precedence removed ${before-authoritative.length} lower-tier conflicting fixture(s).`
    );
  }

  // Index exact previous fixtures. Previous data may supply LOCATION ONLY, never
  // fixture existence, and only for the exact same date/time/player pair.
  const previousExact=new Map();
  for(const m of existingRows||[]){
    if(!m?.date||!m?.time||!realPlayer(m.player1)||!realPlayer(m.player2))continue;
    const k=exactKey(m);
    if(!previousExact.has(k))previousExact.set(k,[]);
    previousExact.get(k).push(m);
  }

  const previousByPairDay=new Map();
  for(const rows of previousExact.values()){
    for(const m of rows){
      const k=pairDay(m);
      if(!previousByPairDay.has(k))previousByPairDay.set(k,[]);
      previousByPairDay.get(k).push(m);
    }
  }

  // Matches page by exact pair/day. It is an overlay only.
  const freshByPairDay=new Map();
  for(const m of fresh){
    const k=pairDay(m);
    if(!freshByPairDay.has(k))freshByPairDay.set(k,[]);
    freshByPairDay.get(k).push(m);
  }

  const out=[];

  // Preserve immutable history only.
  if(preserveHistory){
    for(const old0 of existingRows||[]){
      const old={...old0,court:sanitizeCourtValue(old0.court),rawText:''};
      const d=dateKey(old);
      if(!d||d>=today)continue;
      out.push(old);
    }
  }

  let metadataUpdates=0;
  let previousLocationRestores=0;
  let drawLocationRestores=0;

  for(const auth0 of authoritative){
    const d=dateKey(auth0);
    if(!d)continue;
    if(preserveHistory&&d<today)continue;

    const m={...auth0};

    // 1) Merge location from ANY exact draw observation of this already-trusted
    // fixture. Visual/raw draw text is allowed to enrich metadata once fixture
    // existence itself is independently trusted.
    for(const dm of drawMetaByExact.get(exactKey(m))||[]){
      const loc=provenLocationFromRow(dm);
      if(!m.venue&&validVenue(loc.venue)){
        m.venue=loc.venue;
        drawLocationRestores++;
      }
      if(!sanitizeCourtValue(m.court)&&loc.court){
        m.court=loc.court;
        drawLocationRestores++;
      }
    }

    // 1b) If exact-time draw metadata lacks location, a UNIQUE same-pair/day
    // draw observation may provide it. This is metadata recovery only; it does
    // not alter who plays whom.
    if(!validLocation(m)){
      const sameDay=(drawMetaByPairDay.get(pairDay(m))||[])
        .map(x=>({...x,...provenLocationFromRow(x)}))
        .filter(x=>validVenue(x.venue)&&sanitizeCourtValue(x.court));

      const signatures=[...new Set(
        sameDay.map(x=>`${clean(x.venue)}|${sanitizeCourtValue(x.court)}`)
      )];

      if(signatures.length===1&&sameDay.length){
        const loc=provenLocationFromRow(sameDay[0]);
        if(!m.venue&&validVenue(loc.venue)){
          m.venue=loc.venue;
          drawLocationRestores++;
        }
        if(!sanitizeCourtValue(m.court)&&loc.court){
          m.court=loc.court;
          drawLocationRestores++;
        }
      }
    }

    // 2) Matches page may update time/location/result for the SAME pair/day.
    const candidates=freshByPairDay.get(pairDay(m))||[];
    if(candidates.length===1){
      const f=candidates[0];

      if(f.time&&clean(f.time)!==clean(m.time)){
        m.time=f.time;
        metadataUpdates++;
      }
      if(f.venue&&validVenue(f.venue)&&clean(f.venue)!==clean(m.venue)){
        m.venue=clean(f.venue);
        metadataUpdates++;
      }
      const fc=sanitizeCourtValue(f.court);
      if(fc&&fc!==sanitizeCourtValue(m.court)){
        m.court=fc;
        metadataUpdates++;
      }
      if(f.event)m.event=f.event;
      if(f.round)m.round=f.round;

      if(f.result)m.result=f.result;
      if(f.winner)m.winner=f.winner;
      if(f.winnerId)m.winnerId=f.winnerId;
      if(f.result||f.winner){
        m.status='completed';
        m.resultSource='TournamentSoftware';
      }
    }

    // 3) Previous data may restore LOCATION only. Prefer exact fixture first;
    // then allow a unique same-pair/day location signature if the official time
    // moved slightly between views.
    if(!validLocation(m)){
      const prevExact=previousExact.get(exactKey(m))||[];
      let candidates=prevExact;

      if(!candidates.length){
        candidates=previousByPairDay.get(pairDay(m))||[];
      }

      const locs=candidates
        .map(x=>provenLocationFromRow(x))
        .filter(x=>validVenue(x.venue)&&x.court);

      const signatures=[...new Set(
        locs.map(x=>`${clean(x.venue)}|${sanitizeCourtValue(x.court)}`)
      )];

      if(signatures.length===1&&locs.length){
        const loc=locs[0];
        if(!m.venue){
          m.venue=loc.venue;
          previousLocationRestores++;
        }
        if(!sanitizeCourtValue(m.court)){
          m.court=loc.court;
          previousLocationRestores++;
        }
      }
    }

    m.court=sanitizeCourtValue(m.court);
    out.push(m);
  }

  const finalMap=new Map();
  for(const m of out){
    const k=exactKey(m);
    const old=finalMap.get(k);
    if(!old||richness(m)>richness(old))finalMap.set(k,m);
  }

  const final=[...finalMap.values()].sort((a,b)=>
    `${dateKey(a)} ${clean(a.time)}`.localeCompare(`${dateKey(b)} ${clean(b.time)}`)
  );

  const currentFuture=final.filter(m=>dateKey(m)>=today);

  // Hard integrity rule: a published current/future fixture must have a valid
  // location. If extraction cannot prove it, fail safely instead of showing TBD.
  const incomplete=currentFuture.filter(m=>!validLocation(m));
  if(incomplete.length){
    const sample=incomplete.slice(0,10).map(m=>{
      const exactDraw=(drawMetaByExact.get(exactKey(m))||[]).length;
      const dayDraw=(drawMetaByPairDay.get(pairDay(m))||[]).length;
      const prevExact=(previousExact.get(exactKey(m))||[]).length;
      const prevDay=(previousByPairDay.get(pairDay(m))||[]).length;
      return `${m.date} ${m.time} ${m.player1} vs ${m.player2} ` +
        `(${m.venue||'venue?'} / ${m.court||'court?'}; ` +
        `drawExact=${exactDraw}, drawDay=${dayDraw}, prevExact=${prevExact}, prevDay=${prevDay})`;
    }).join(' | ');
    const sourceCounts={};
    for(const m of incomplete){
      const sig=(m.drawEvidenceSources||[m.source||'unknown']).join('+')||'unknown';
      sourceCounts[sig]=(sourceCounts[sig]||0)+1;
    }
    throw new Error(
      `Draw-authoritative schedule contains ${incomplete.length} trusted current/future fixture(s) ` +
      `without a proven venue/court. Evidence sources: ${JSON.stringify(sourceCounts)}. ` +
      `Existing published data was left unchanged. Sample: ${sample}`
    );
  }

  const occupied=new Map();
  const collisions=[];
  for(const m of currentFuture){
    for(const side of [1,2]){
      const sideName=side===1?m.player1:m.player2;
      if(tbdPlayer(sideName)||/^Bye$/i.test(clean(sideName||'')))continue;
      const s=playerSlot(m,side);
      if(!occupied.has(s))occupied.set(s,m);
      else if(exactKey(occupied.get(s))!==exactKey(m)){
        collisions.push({a:occupied.get(s),b:m});
      }
    }
  }
  if(collisions.length){
    const sample=collisions.slice(0,6).map(x=>
      `${x.a.date} ${x.a.time}: ${x.a.player1} vs ${x.a.player2} / ${x.b.player1} vs ${x.b.player2}`
    ).join(' | ');
    throw new Error(
      `Draw-authoritative schedule has ${collisions.length} impossible player/date/time collision(s). ` +
      `Existing published data was left unchanged. Sample: ${sample}`
    );
  }

  if(currentFuture.length<40){
    throw new Error(
      `Draw-authoritative current/future coverage is implausibly small: ${currentFuture.length} fixtures. ` +
      `Existing published data was left unchanged.`
    );
  }

  const byDate={};
  for(const m of currentFuture){
    const d=dateKey(m);
    byDate[d]=(byDate[d]||0)+1;
  }

  console.log(`DRAW AUTHORITY evidence: ${JSON.stringify(evidenceSummary)}`);
  console.log(
    `DRAW AUTHORITY accepted ${authoritative.length} trusted draw fixture(s); ` +
    `${drawLocationRestores} draw-location field restore(s), ` +
    `${metadataUpdates} Matches-page metadata update(s), ` +
    `${previousLocationRestores} exact-prior location restore(s).`
  );
  console.log(`DRAW AUTHORITY current/future by date: ${JSON.stringify(byDate)}`);
  const trackedForAudit=loadTrackedNames();
  const trackedCurrentFuture=currentFuture.filter(m=>
    trackedForAudit.some(n=>sameName(m.player1,n)||sameName(m.player2,n))
  );
  console.log(`DRAW AUTHORITY tracked current/future fixtures: ${JSON.stringify(
    trackedCurrentFuture.map(m=>({
      date:m.date,time:m.time,player1:m.player1,player2:m.player2,
      venue:m.venue||'',court:m.court||'',
      source:m.source||'',evidence:m.drawEvidenceSources||[],
      deterministicTbd:!!m.deterministicTbd
    }))
  )}`);
  console.log(
    `DRAW AUTHORITY final schedule: ${final.length} fixture(s), ` +
    `${currentFuture.length} current/future with proven location.`
  );

  return final;
}

function overlayAuthoritativeTournamentResults(baseRows,resultRows,label='TournamentSoftware'){
  const out=(baseRows||[]).map(m=>({...m}));
  const results=(resultRows||[]).filter(m=>m&&(m.result||m.winner));

  const person=name=>nameKey(splitPlayerSeed(name).name);
  const pair=m=>[person(m.player1),person(m.player2)].sort().join('|');
  const date=m=>canonicalTournamentDate(m.date);
  const time=m=>clean(m.time||'').toLowerCase();

  const exactKey=m=>`${date(m)}|${time(m)}|${pair(m)}`;
  const dayPairKey=m=>`${date(m)}|${pair(m)}`;

  const exactMap=new Map();
  const dayPairMap=new Map();

  for(const r of results){
    const ek=exactKey(r);
    if(!exactMap.has(ek))exactMap.set(ek,[]);
    exactMap.get(ek).push(r);

    const dk=dayPairKey(r);
    if(!dayPairMap.has(dk))dayPairMap.set(dk,[]);
    dayPairMap.get(dk).push(r);
  }

  const apply=(target,r)=>{
    let changed=false;

    if(r.result&&clean(target.result)!==clean(r.result)){
      target.result=r.result;
      changed=true;
    }

    if(r.winner&&person(target.winner)!==person(r.winner)){
      target.winner=splitPlayerSeed(r.winner).name;
      changed=true;
    }

    if(r.winnerId&&!target.winnerId){
      target.winnerId=r.winnerId;
      changed=true;
    }

    if((r.result||r.winner)&&String(target.status||'').toLowerCase()!=='completed'){
      target.status='completed';
      changed=true;
    }

    if(changed)target.resultSource=label;
    return changed;
  };

  let exactApplied=0;
  let safeDayPairApplied=0;
  let ambiguous=0;

  for(const m of out){
    // First choice: exact date + time + player pair.
    const exactRows=exactMap.get(exactKey(m))||[];
    if(exactRows.length===1){
      if(apply(m,exactRows[0]))exactApplied++;
      continue;
    }
    if(exactRows.length>1){
      // Multiple rows are still safe if they all agree on result/winner.
      const sig=new Set(exactRows.map(r=>`${clean(r.result)}|${person(r.winner||'')}`));
      if(sig.size===1){
        if(apply(m,exactRows[0]))exactApplied++;
      }else{
        ambiguous++;
      }
      continue;
    }

    // TournamentSoftware draw/result rows can omit or shift the list-view time.
    // Use same-day + same-pair only when BOTH sides are unambiguous:
    //   - exactly one result row for that pair/day
    //   - exactly one published fixture for that pair/day
    const dayRows=dayPairMap.get(dayPairKey(m))||[];
    if(dayRows.length!==1)continue;

    const publishedSameDayPair=out.filter(x=>dayPairKey(x)===dayPairKey(m));
    if(publishedSameDayPair.length!==1)continue;

    if(apply(m,dayRows[0]))safeDayPairApplied++;
  }

  console.log(
    `${label} authoritative result overlay: ${exactApplied} exact result update(s), ` +
    `${safeDayPairApplied} safe same-day/pair update(s), ${ambiguous} ambiguous skipped.`
  );

  return out;
}

function preserveHistoricalTournamentResults(currentRows,previousRows){
  const out=(currentRows||[]).map(m=>({...m}));
  const previous=(previousRows||[]).filter(m=>m&&m.result);

  const dateKey=m=>canonicalTournamentDate(m.date);
  const timeKey=m=>clean(m.time||'').toLowerCase();
  const pairKey=m=>[
    nameKey(splitPlayerSeed(m.player1).name),
    nameKey(splitPlayerSeed(m.player2).name)
  ].sort().join('|');

  const key=m=>`${dateKey(m)}|${timeKey(m)}|${pairKey(m)}`;
  const today=perthTodayIsoRefresh();

  const oldByKey=new Map();

  for(const old of previous){
    const d=dateKey(old);
    if(!d||d>=today)continue;

    const k=key(old);
    if(!k)continue;

    if(!oldByKey.has(k)){
      oldByKey.set(k,old);
    }else{
      const existing=oldByKey.get(k);
      // If historical snapshots disagree on the score, refuse to guess.
      if(clean(existing.result)!==clean(old.result))oldByKey.set(k,null);
    }
  }

  const reverseResult=result=>
    [...String(result||'').matchAll(/(\d{1,2})\s*[-–—]\s*(\d{1,2})/g)]
      .map(x=>`${Number(x[2])}-${Number(x[1])}`)
      .join(', ');

  let restored=0;

  for(const m of out){
    const d=dateKey(m);
    if(!d||d>=today)continue;
    if(m.result)continue;

    const old=oldByKey.get(key(m));
    if(!old||!old.result)continue;

    const sameOrientation=
      nameKey(splitPlayerSeed(m.player1).name)===nameKey(splitPlayerSeed(old.player1).name) &&
      nameKey(splitPlayerSeed(m.player2).name)===nameKey(splitPlayerSeed(old.player2).name);

    const reversedOrientation=
      nameKey(splitPlayerSeed(m.player1).name)===nameKey(splitPlayerSeed(old.player2).name) &&
      nameKey(splitPlayerSeed(m.player2).name)===nameKey(splitPlayerSeed(old.player1).name);

    if(!sameOrientation&&!reversedOrientation)continue;

    const restoredResult=reversedOrientation?reverseResult(old.result):old.result;
    if(!restoredResult)continue;

    m.result=restoredResult;
    m.status=old.status||'completed';
    m.resultSource=old.resultSource||'TournamentSoftware';

    // Preserve result-related metadata where available.
    if(old.winner!==undefined&&m.winner===undefined)m.winner=old.winner;
    if(old.winnerId!==undefined&&m.winnerId===undefined)m.winnerId=old.winnerId;

    restored++;
  }

  console.log(`Historical score preservation restored ${restored} past fixture result(s) by date/time/player pair.`);
  return out;
}


function sanitizeFutureResultMetadata(rows){
  const today=perthTodayIsoRefresh();
  let futureCleared=0;
  let untrustedCurrentCleared=0;

  return (rows||[]).map(m=>{
    const x={...m};
    const d=canonicalTournamentDate(x.date);
    const status=String(x.status||'').toLowerCase();
    if(!d)return x;

    // A bare current/today Walkover with no result authority and no winner is
    // not sufficient evidence that the match actually ended as a walkover.
    // The word can leak in from a broad TournamentSoftware list/draw context.
    if(
      d>=today &&
      /^walkover$/i.test(clean(x.result||'')) &&
      !x.winner &&
      !/^(?:TournamentSoftware|SquashScores)/i.test(clean(x.resultSource||''))
    ){
      x.result='';
      x.winner='';
      x.winnerId='';
      x.resultSource='';
      if(status==='completed'||status==='played')x.status='scheduled';
      x.untrustedResultSuppressed=true;
      untrustedCurrentCleared++;
    }

    if(d<=today)return x;

    // A future scheduled fixture cannot already have a winner/result.
    if(String(x.status||'').toLowerCase()!=='live'){
      if(
        x.result||x.winner||x.winnerId||
        String(x.status||'').toLowerCase()==='completed'||
        String(x.status||'').toLowerCase()==='played'
      ){
        x.result='';
        x.winner='';
        x.winnerId='';
        x.resultSource='';
        x.status='scheduled';
        futureCleared++;
      }
    }

    return x;
  }).map((m,i,arr)=>{
    if(i===arr.length-1){
      if(untrustedCurrentCleared){
        console.log(
          `Current result sanitiser cleared ${untrustedCurrentCleared} unverified Walkover row(s).`
        );
      }
      if(futureCleared){
        console.log(
          `Future result sanitiser cleared stale result/winner metadata on ${futureCleared} fixture(s).`
        );
      }
    }
    return m;
  });
}

function mergeSquashScoresIntoMatches(baseMatches, liveMatches){
  const out=(baseMatches||[]).map(m=>({...m}));
  const pair=m=>{
    const ids=[String(m.player1Id||''),String(m.player2Id||'')].filter(Boolean).sort();
    return ids.length===2?ids.join('~'):[nameKey(m.player1),nameKey(m.player2)].sort().join('~');
  };
  const date=m=>canonicalTournamentDate(m.date);
  const time=m=>clean(m.time).toLowerCase();
  const perthToday=perthTodayIsoRefresh();

  for(const live of liveMatches||[]){
    const liveStatus=String(live.status||'').toLowerCase();
    if(liveStatus!=='live'&&liveStatus!=='completed')continue;
    if(date(live)!==perthToday)continue;

    const candidates=out.filter(m=>
      date(m)===date(live) &&
      time(m)===time(live) &&
      pair(m)===pair(live)
    );
    if(candidates.length!==1)continue;

    const existing=candidates[0];
    if(live.result){
      existing.result=orientSquashScoresResult(existing,live);
      existing.resultSource='SquashScores';
    }
    existing.status=liveStatus;
    existing.liveSource='SquashScores';
    existing.liveUpdatedAt=new Date().toISOString();
  }
  return out;
}

// canonicalDate is a frontend helper; keep a tiny refresh-side equivalent.
function perthTodayIsoRefresh(){
  const parts=new Intl.DateTimeFormat('en-CA',{
    timeZone:'Australia/Perth',
    year:'numeric',month:'2-digit',day:'2-digit'
  }).formatToParts(new Date());
  const get=t=>parts.find(x=>x.type===t)?.value||'';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function canonicalTournamentDate(v){
  const s=clean(v);
  const m=s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m?`${m[1]}-${m[2]}-${m[3]}`:s;
}


function normalizeSelfMatchAsBye(m,canonicalPlayers){
  if(!m)return m;

  const n1=splitPlayerSeed(m.player1).name;
  const n2=splitPlayerSeed(m.player2).name;

  if(!n1||!n2||nameKey(n1)!==nameKey(n2))return m;

  const p1Id=String(m.player1Id||'');
  const p2Id=String(m.player2Id||'');

  // Two different official IDs are two distinct people who happen to share a name.
  if(p1Id&&p2Id&&p1Id!==p2Id)return m;

  const explicitBye=
    /^bye$/i.test(clean(m.player2||'')) ||
    /\bBye\b/i.test(clean(m.rawText||'')) ||
    String(m.status||'').toLowerCase()==='bye';

  const sameOfficialId=!!(p1Id&&p2Id&&p1Id===p2Id);

  // Do NOT infer a Bye merely because two parsed names collapse to the same
  // identity. That inference caused valid tracked fixtures to become Bye.
  if(!explicitBye&&!sameOfficialId)return m;

  return {
    ...m,
    player1:n1,
    player2:'Bye',
    player2Id:'',
    status:String(m.status||'').toLowerCase()==='completed'?m.status:'bye'
  };
}

function isGlass(m){return /\bAGC\b|Karrinyup/i.test([m.court,m.venue,m.rawText].join(' '))}
function hasPlayer(m,n){return sameName(m.player1,n)||sameName(m.player2,n)}





function overlayTrackedDrawSlotLocation(schedule,drawMatches){
  const out=(schedule||[]).map(m=>({...m}));
  const draws=(drawMatches||[]).filter(m=>m.date&&m.time&&m.venue&&m.court);
  const trackedNames=loadTrackedNames();

  const token=(name,id)=>String(id||'')||nameKey(name);
  const slot=(m,name,id)=>[
    canonicalTournamentDate(m.date),
    clean(m.time||'').toLowerCase(),
    token(name,id)
  ].join('|');

  const locations=new Map();

  for(const d of draws){
    for(const [name,id] of [[d.player1,d.player1Id],[d.player2,d.player2Id]]){
      if(!name||!trackedNames.some(n=>sameName(name,n)))continue;
      const k=slot(d,name,id);
      const value={venue:clean(d.venue),court:sanitizeCourtValue(d.court)};
      if(!value.venue||!value.court)continue;

      if(!locations.has(k))locations.set(k,value);
      else{
        const old=locations.get(k);
        if(old&&(old.venue!==value.venue||old.court!==value.court))locations.set(k,null);
      }
    }
  }

  let corrected=0;
  for(const m of out){
    for(const [name,id] of [[m.player1,m.player1Id],[m.player2,m.player2Id]]){
      if(!name||!trackedNames.some(n=>sameName(name,n)))continue;
      const loc=locations.get(slot(m,name,id));
      if(!loc)continue;

      if(clean(m.venue)!==loc.venue||sanitizeCourtValue(m.court)!==loc.court){
        m.venue=loc.venue;
        m.court=loc.court;
        corrected++;
      }
      break;
    }
  }

  console.log(`Tracked draw slot-location overlay corrected ${corrected} fixture location(s).`);
  return out;
}

function overlayVerifiedDrawLocation(schedule,drawMatches){
  const out=(schedule||[]).map(m=>({...m}));
  const verified=(drawMatches||[]).filter(m=>
    m.date&&m.time&&m.venue&&m.court &&
    !/^(?:TBD|Bye)$/i.test(clean(m.player1||'')) &&
    !/^(?:TBD|Bye)$/i.test(clean(m.player2||''))
  );
  const token=(name,id)=>String(id||'')||nameKey(name);
  const key=m=>[
    canonicalTournamentDate(m.date),
    clean(m.time||'').toLowerCase(),
    ...[token(m.player1,m.player1Id),token(m.player2,m.player2Id)].sort()
  ].join('|');

  const map=new Map();
  for(const d of verified){
    const k=key(d);
    if(!map.has(k))map.set(k,{...d});
    else{
      const old=map.get(k);
      if(old && (clean(old.venue)!==clean(d.venue) || sanitizeCourtValue(old.court)!==sanitizeCourtValue(d.court))){
        map.set(k,null);
      }
    }
  }

  let corrected=0;
  for(const m of out){
    const d=map.get(key(m));
    if(!d)continue;
    const venue=clean(d.venue),court=sanitizeCourtValue(d.court);
    if(clean(m.venue)!==venue || sanitizeCourtValue(m.court)!==court){
      m.venue=venue;m.court=court;corrected++;
    }
    if(!m.event&&d.event)m.event=d.event;
    if(!m.round&&d.round)m.round=d.round;
  }
  console.log(`Verified draw location overlay corrected ${corrected} fixture location(s).`);
  return out;
}


function filterUncorroboratedFutureRecoveredFixtures(schedule,drawMatches){
  const today=perthTodayIsoRefresh();
  const draws=(drawMatches||[]).filter(m=>
    m?.date&&m?.time&&m?.player1&&m?.player2 &&
    !/^(?:TBD|Bye)$/i.test(clean(m.player1||'')) &&
    !/^(?:TBD|Bye)$/i.test(clean(m.player2||''))
  );

  const key=m=>[
    canonicalTournamentDate(m.date),
    clean(m.time||'').toLowerCase(),
    ...[nameKey(m.player1),nameKey(m.player2)].sort()
  ].join('|');

  const drawKeys=new Set(draws.map(key));
  let removed=0;

  const out=(schedule||[]).filter(m=>{
    const d=canonicalTournamentDate(m.date);
    const lowConfidence=
      clean(m.recoveredFrom||'')==='adjacent-one-player-fragments';

    if(!lowConfidence||!d||d<=today)return true;

    // A future concrete pairing reconstructed only from adjacent single-player
    // fragments is not authoritative by itself. Retain it only when the
    // official draw independently confirms the exact date/time/player pair.
    if(drawKeys.has(key(m)))return true;

    removed++;
    return false;
  });

  if(removed){
    console.log(
      `Future recovered-fragment guard removed ${removed} uncorroborated ` +
      `adjacent-fragment fixture(s).`
    );
  }

  return out;
}

function mergeTrackedDrawFallback(schedule,drawMatches,canonicalPlayers){
  let out=(schedule||[]).map(m=>({...m}));
  const fallback=(drawMatches||[]).map(m=>({...m}));

  const playerToken=(name,id)=>String(id||'')||nameKey(name);
  const timeKey=m=>clean(m.time||'').toLowerCase();
  const dateKey=m=>canonicalTournamentDate(m.date);

  const isRealPlayer=name=>!!name&&!/^(?:TBD|Bye)$/i.test(clean(name));

  // Build authoritative concrete draw slots first.
  const concreteByPlayerSlot=new Map();

  for(const m of fallback){
    if(m.source!=='TournamentSoftware Draw Tracked Concrete Verified')continue;
    if(!m.date||!m.time||!m.venue||!sanitizeCourtValue(m.court))continue;
    if(!isRealPlayer(m.player1)||!isRealPlayer(m.player2))continue;

    const d=dateKey(m),t=timeKey(m);
    if(!d||!t)continue;

    concreteByPlayerSlot.set(`${d}|${t}|${playerToken(m.player1,m.player1Id)}`,m);
    concreteByPlayerSlot.set(`${d}|${t}|${playerToken(m.player2,m.player2Id)}`,m);
  }

  // Remove stale/incorrect rows for a tracked player when the official draw has
  // a fully specified concrete opponent at that exact date/time.
  out=out.filter(m=>{
    const d=dateKey(m),t=timeKey(m);
    if(!d||!t)return true;

    const p1slot=m.player1?`${d}|${t}|${playerToken(m.player1,m.player1Id)}`:'';
    const p2slot=m.player2?`${d}|${t}|${playerToken(m.player2,m.player2Id)}`:'';

    const authoritative=
      (p1slot&&concreteByPlayerSlot.get(p1slot)) ||
      (p2slot&&concreteByPlayerSlot.get(p2slot));

    if(!authoritative)return true;

    const samePair=
      [playerToken(m.player1,m.player1Id),playerToken(m.player2,m.player2Id)].sort().join('|')===
      [playerToken(authoritative.player1,authoritative.player1Id),playerToken(authoritative.player2,authoritative.player2Id)].sort().join('|');

    if(samePair)return true;

    console.log(
      `Removed stale future fixture: ${m.date} ${m.time} ${m.player1} vs ${m.player2}; ` +
      `official draw says ${authoritative.player1} vs ${authoritative.player2}.`
    );
    return false;
  });

  // Add verified concrete draw fixtures.
  const exactKey=m=>[
    dateKey(m),
    timeKey(m),
    ...[
      playerToken(m.player1,m.player1Id),
      playerToken(m.player2,m.player2Id)
    ].sort()
  ].join('|');

  const seen=new Set(out.map(exactKey));

  let addedConcrete=0;
  for(const m of fallback){
    if(m.source!=='TournamentSoftware Draw Tracked Concrete Verified')continue;
    const k=exactKey(m);
    if(seen.has(k))continue;
    seen.add(k);
    out.push({...m,rawText:''});
    addedConcrete++;
  }

  // Guessed TBD rows are deliberately disabled. A fixture must have two
  // concrete players from the deterministic TournamentSoftware draw tree.
  const addedTbd=0;

  // Final tracked-slot dedupe: when a verified concrete draw fixture exists,
  // keep that one and remove every conflicting row for the same tracked player/date/time.
  for(const [slot,authoritative] of concreteByPlayerSlot){
    out=out.filter(m=>{
      const d=dateKey(m),t=timeKey(m);
      if(!d||!t)return true;
      const slots=[
        m.player1?`${d}|${t}|${playerToken(m.player1,m.player1Id)}`:'',
        m.player2?`${d}|${t}|${playerToken(m.player2,m.player2Id)}`:''
      ];
      if(!slots.includes(slot))return true;

      const samePair=
        [playerToken(m.player1,m.player1Id),playerToken(m.player2,m.player2Id)].sort().join('|')===
        [playerToken(authoritative.player1,authoritative.player1Id),playerToken(authoritative.player2,authoritative.player2Id)].sort().join('|');

      return samePair;
    });
  }

  console.log(
    `Tracked draw fallback added ${addedConcrete} concrete and ${addedTbd} TBD future fixture(s).`
  );

  return out;
}




function applyFreshGlobalSlotAuthority(mergedMatches,freshSchedule){
  let out=(mergedMatches||[]).map(m=>({...m}));
  const fresh=(freshSchedule||[]).filter(m=>
    m?.date&&m?.time&&m?.player1&&m?.player2 &&
    !/^(?:Bye|TBD)$/i.test(clean(m.player1)) &&
    !/^(?:Bye|TBD)$/i.test(clean(m.player2))
  );

  const person=name=>nameKey(splitPlayerSeed(name).name);
  const slot=(m,name)=>[
    canonicalTournamentDate(m.date),
    clean(m.time||'').toLowerCase(),
    person(name)
  ].join('|');
  const pair=m=>[
    person(m.player1),
    person(m.player2)
  ].sort().join('|');
  const exact=m=>[
    canonicalTournamentDate(m.date),
    clean(m.time||'').toLowerCase(),
    pair(m)
  ].join('|');

  const authority=new Map();

  for(const m of fresh){
    for(const name of [m.player1,m.player2]){
      const s=slot(m,name);
      if(!authority.has(s))authority.set(s,m);
      else if(exact(authority.get(s))!==exact(m))authority.set(s,null);
    }
  }

  let removed=0;
  out=out.filter(m=>{
    let authoritative=null;

    for(const name of [m.player1,m.player2]){
      if(!name)continue;
      const a=authority.get(slot(m,name));
      if(a){authoritative=a;break;}
    }

    if(!authoritative)return true;
    if(exact(m)===exact(authoritative))return true;

    removed++;
    return false;
  });

  const seen=new Set(out.map(exact));
  let added=0;
  for(const m of authority.values()){
    if(!m)continue;
    const k=exact(m);
    if(seen.has(k))continue;
    out.push({...m,rawText:''});
    seen.add(k);
    added++;
  }

  console.log(
    `Global fresh slot authority: ${removed} stale/conflicting fixture(s) removed, ` +
    `${added} current fixture(s) added.`
  );

  return out;
}

function cleanupDuplicateTournamentFixtures(rows,freshRows=[]){
  let out=(rows||[]).map(m=>({...m}));
  const fresh=(freshRows||[]);

  const person=name=>nameKey(splitPlayerSeed(name).name);
  const dayPair=m=>[
    canonicalTournamentDate(m.date),
    ...[person(m.player1),person(m.player2)].sort()
  ].join('|');

  const exact=m=>[
    canonicalTournamentDate(m.date),
    clean(m.time||'').toLowerCase(),
    ...[person(m.player1),person(m.player2)].sort()
  ].join('|');

  const freshExact=new Set(fresh.map(exact));

  const quality=m=>
    (freshExact.has(exact(m))?100000:0)+
    (m.result?10000:0)+
    (m.winner?5000:0)+
    (String(m.status||'').toLowerCase()==='completed'?1000:0)+
    (m.venue?200:0)+
    (m.court?100:0)+
    (m.player1Id?20:0)+
    (m.player2Id?20:0)+
    (m.event?5:0);

  // First collapse exact duplicate fixtures.
  const exactMap=new Map();
  for(const m of out){
    const k=exact(m);
    const old=exactMap.get(k);
    if(!old||quality(m)>quality(old))exactMap.set(k,m);
  }
  out=[...exactMap.values()];

  // A pair cannot play two separate official fixtures on the same tournament
  // day. If polluted additive snapshots contain the same pair more than once,
  // retain the current fresh row where available; otherwise retain the richest
  // result/metadata row.
  const groups=new Map();
  for(const m of out){
    const k=dayPair(m);
    if(!groups.has(k))groups.set(k,[]);
    groups.get(k).push(m);
  }

  let pairDayRemoved=0;
  const cleaned=[];

  for(const rows0 of groups.values()){
    if(rows0.length===1){
      cleaned.push(rows0[0]);
      continue;
    }

    const freshCandidates=rows0.filter(m=>freshExact.has(exact(m)));
    let keep;

    if(freshCandidates.length===1){
      keep=freshCandidates[0];
    }else{
      keep=[...rows0].sort((a,b)=>quality(b)-quality(a))[0];
    }

    cleaned.push(keep);
    pairDayRemoved+=rows0.length-1;
  }

  console.log(
    `Duplicate fixture cleanup: ${rows.length-cleaned.length} duplicate/obsolete row(s) removed ` +
    `(${pairDayRemoved} repeated same-pair/day row(s)).`
  );

  return cleaned;
}


function applyFreshTrackedMatchAuthority(mergedMatches,freshSchedule){
  let out=(mergedMatches||[]).map(m=>({...m}));
  const fresh=(freshSchedule||[]).map(m=>({...m}));
  const trackedNames=loadTrackedNames();

  const token=(name,id)=>String(id||'')||nameKey(name);

  // Tracked-player DATE/TIME slot identity deliberately uses the normalized
  // displayed name, not officialPlayerId. Old published rows can have a
  // missing/stale ID while the fresh official row has the current ID. Using
  // IDs here allowed duplicate Susan rows at the same slot to survive.
  const slot=(m,name,_id)=>[
    canonicalTournamentDate(m.date),
    clean(m.time||'').toLowerCase(),
    nameKey(name)
  ].join('|');
  const pairKey=m=>[
    canonicalTournamentDate(m.date),
    clean(m.time||'').toLowerCase(),
    ...[token(m.player1,m.player1Id),token(m.player2,m.player2Id)].sort()
  ].join('|');

  const authority=new Map();

  for(const m of fresh){
    if(!m.date||!m.time)continue;
    if(/^(?:TBD|Bye)$/i.test(clean(m.player1||'')))continue;
    if(/^(?:TBD|Bye)$/i.test(clean(m.player2||'')))continue;

    const tracked1=trackedNames.some(n=>sameName(m.player1,n));
    const tracked2=trackedNames.some(n=>sameName(m.player2,n));
    if(!tracked1&&!tracked2)continue;

    for(const [name,id,isTracked] of [
      [m.player1,m.player1Id,tracked1],
      [m.player2,m.player2Id,tracked2]
    ]){
      if(!isTracked)continue;
      const s=slot(m,name,id);
      if(!authority.has(s))authority.set(s,m);
      else if(pairKey(authority.get(s))!==pairKey(m))authority.set(s,null);
    }
  }

  let removed=0;
  out=out.filter(m=>{
    const slots=[];
    if(m.player1)slots.push(slot(m,m.player1,m.player1Id));
    if(m.player2)slots.push(slot(m,m.player2,m.player2Id));

    let auth=null;
    for(const s of slots){
      const a=authority.get(s);
      if(a){auth=a;break;}
    }
    if(!auth)return true;
    if(pairKey(m)===pairKey(auth))return true;

    console.log(
      `Fresh tracked authority removed conflicting fixture: ${m.date} ${m.time} ` +
      `${m.player1} vs ${m.player2}; fresh official Matches page says ` +
      `${auth.player1} vs ${auth.player2}.`
    );
    removed++;
    return false;
  });

  const seen=new Set(out.map(pairKey));
  let added=0;
  for(const auth of authority.values()){
    if(!auth)continue;
    const k=pairKey(auth);
    if(seen.has(k))continue;
    out.push({...auth,rawText:''});
    seen.add(k);
    added++;
  }

  console.log(`Fresh tracked authority: ${removed} conflicting fixture(s) removed, ${added} authoritative fixture(s) added.`);
  return out;
}

function applyFinalTrackedDrawAuthority(matches,drawMatches){
  let out=(matches||[]).map(m=>({...m}));
  const verified=(drawMatches||[]).filter(m=>
    m.source==='TournamentSoftware Draw Tracked Concrete Verified' &&
    m.date&&m.time&&m.venue&&sanitizeCourtValue(m.court) &&
    !/^(?:TBD|Bye)$/i.test(clean(m.player1||'')) &&
    !/^(?:TBD|Bye)$/i.test(clean(m.player2||''))
  );

  const token=(name,id)=>String(id||'')||nameKey(name);
  const slot=(d,t,name,id)=>`${canonicalTournamentDate(d)}|${clean(t||'').toLowerCase()}|${token(name,id)}`;
  const pairKey=m=>[
    canonicalTournamentDate(m.date),
    clean(m.time||'').toLowerCase(),
    ...[
      token(m.player1,m.player1Id),
      token(m.player2,m.player2Id)
    ].sort()
  ].join('|');

  const authorityBySlot=new Map();

  for(const m of verified){
    const s1=slot(m.date,m.time,m.player1,m.player1Id);
    const s2=slot(m.date,m.time,m.player2,m.player2Id);

    for(const s of [s1,s2]){
      if(!authorityBySlot.has(s)){
        authorityBySlot.set(s,m);
      }else{
        const old=authorityBySlot.get(s);
        if(pairKey(old)!==pairKey(m)){
          // Ambiguous draw data: don't enforce this player/time slot.
          authorityBySlot.set(s,null);
        }
      }
    }
  }

  // Remove all rows that conflict with an unambiguous verified concrete draw slot.
  out=out.filter(m=>{
    const s1=m.player1?slot(m.date,m.time,m.player1,m.player1Id):'';
    const s2=m.player2?slot(m.date,m.time,m.player2,m.player2Id):'';

    const auth=(s1&&authorityBySlot.get(s1))||(s2&&authorityBySlot.get(s2));
    if(!auth)return true;

    const same=pairKey(m)===pairKey(auth);
    if(!same){
      console.log(
        `FINAL draw authority removed conflicting fixture: ` +
        `${m.date} ${m.time} ${m.player1} vs ${m.player2}; ` +
        `official draw says ${auth.player1} vs ${auth.player2}.`
      );
    }
    return same;
  });

  // Index remaining rows, then force the verified draw fixture's metadata.
  const byPair=new Map();
  out.forEach((m,i)=>byPair.set(pairKey(m),i));

  let added=0,corrected=0;

  for(const auth0 of verified){
    const auth={
      ...auth0,
      venue:clean(auth0.venue||''),
      court:sanitizeCourtValue(auth0.court),
      rawText:''
    };

    const k=pairKey(auth);
    const i=byPair.get(k);

    if(i===undefined){
      out.push(auth);
      byPair.set(k,out.length-1);
      added++;
      continue;
    }

    const cur=out[i];
    const beforeVenue=clean(cur.venue||'');
    const beforeCourt=sanitizeCourtValue(cur.court);

    cur.player1=splitPlayerSeed(auth.player1).name;
    cur.player2=splitPlayerSeed(auth.player2).name;
    cur.player1Id=auth.player1Id||cur.player1Id||'';
    cur.player2Id=auth.player2Id||cur.player2Id||'';

    // Draw proves the fixture; location is only overwritten when the draw
    // actually supplied authoritative location metadata.
    if(auth.venue)cur.venue=auth.venue;
    if(auth.court)cur.court=auth.court;
    if(auth.event)cur.event=auth.event;
    if(auth.round)cur.round=auth.round;

    if(beforeVenue!==clean(cur.venue||'')||beforeCourt!==sanitizeCourtValue(cur.court))corrected++;
  }

  // Exact dedupe after authority application.
  const finalMap=new Map();
  for(const m of out){
    const k=pairKey(m);
    if(!finalMap.has(k)){
      finalMap.set(k,m);
      continue;
    }

    const old=finalMap.get(k);
    const richness=x=>
      (x.result?1000:0)+
      (x.venue?200:0)+
      (x.court?100:0)+
      (x.event?20:0)+
      (x.round?10:0);

    if(richness(m)>richness(old))finalMap.set(k,m);
  }

  const final=[...finalMap.values()];
  console.log(`FINAL tracked draw authority: ${verified.length} verified fixture(s), ${added} added, ${corrected} location(s) corrected.`);

  const sue=final.filter(m=>sameName(m.player1,'Susan Hillier')||sameName(m.player2,'Susan Hillier'));
  console.log(`FINAL Susan Hillier fixtures: ${JSON.stringify(sue.map(m=>({
    date:m.date,time:m.time,player1:m.player1,player2:m.player2,
    venue:m.venue||'',court:m.court||'',source:m.source||''
  })))}`);

  return final;
}

function sanitizeCourtValue(value){
  let s=clean(value||'');
  if(!s)return '';

  s=s
    .replace(/\b(?:Round\s+of|Round|Quarter\s*Final|Quarter[- ]?final|Semi[- ]?final|Final)\s*\d*\b/ig,' ')
    .replace(/\s+/g,' ')
    .trim();

  if(!/^(?:AGC(?:\s*\d+)?|SC\s*\d+|Court\s*\d+)$/i.test(s))return '';
  if(/^SC\s*\d+$/i.test(s))return s.replace(/\s+/g,'').toUpperCase();
  if(/^AGC(?:\s*\d+)?$/i.test(s))return s.replace(/\s+/g,'').toUpperCase();
  return s.replace(/\s+/g,' ').trim();
}


function overlayFreshTournamentResults(baseRows,freshRows){
  const out=(baseRows||[]).map(m=>({...m}));
  const fresh=(freshRows||[]).filter(m=>m&&(m.result||m.winner));

  const pairKey=m=>[
    nameKey(splitPlayerSeed(m.player1).name),
    nameKey(splitPlayerSeed(m.player2).name)
  ].sort().join('|');

  const key=m=>[
    canonicalTournamentDate(m.date),
    clean(m.time||'').toLowerCase(),
    pairKey(m)
  ].join('|');

  const byKey=new Map();
  for(const m of out){
    const k=key(m);
    if(!byKey.has(k))byKey.set(k,[]);
    byKey.get(k).push(m);
  }

  let applied=0,ambiguous=0,unmatched=0;

  for(const r of fresh){
    const candidates=byKey.get(key(r))||[];
    if(candidates.length!==1){
      if(candidates.length>1)ambiguous++;
      else unmatched++;
      continue;
    }

    const target=candidates[0];

    // TournamentSoftware fresh score/result is authoritative for this exact
    // date/time/player pair even if that day's schedule render was incomplete.
    if(r.result)target.result=r.result;
    target.status=r.status||'completed';
    target.resultSource='TournamentSoftware';

    if(r.winner)target.winner=r.winner;
    if(r.winnerId)target.winnerId=r.winnerId;

    applied++;
  }

  console.log(
    `Fresh TournamentSoftware result overlay: ${applied} result(s) applied ` +
    `from incomplete/complete date renders; ${ambiguous} ambiguous, ${unmatched} unmatched.`
  );

  return out;
}

function mergeDateScopedTournamentMatches(existingRows,freshRows){
  const existing=(existingRows||[])
    .filter(m=>{
      const source=clean(m.source||'');
      const recovered=clean(m.recoveredFrom||'');
      const opponentTbd=/^TBD$/i.test(clean(m.player1||''))||/^TBD$/i.test(clean(m.player2||''));

      // Remove loose draw/future-TBD rows created by earlier experimental
      // fallbacks. Verified draw rows are rebuilt fresh below.
      if(source==='TournamentSoftware Draw Tracked Future')return false;
      if(recovered==='future-one-player-tbd' && opponentTbd && (!m.venue||!m.court))return false;
      return true;
    })
    .map(m=>({...m,court:sanitizeCourtValue(m.court),rawText:''}));

  const fresh=(freshRows||[]).map(m=>({...m,court:sanitizeCourtValue(m.court),rawText:''}));

  const pairKey=m=>{
    const ids=[String(m.player1Id||''),String(m.player2Id||'')].filter(Boolean).sort();
    if(ids.length===2)return ids.join('|');
    return [nameKey(m.player1),nameKey(m.player2)].sort().join('|');
  };

  const timeKey=m=>clean(m.time||'').toLowerCase();
  const exactKey=m=>`${canonicalTournamentDate(m.date)||m.date||''}|${timeKey(m)}|${pairKey(m)}`;

  // These figures are guidance only. A date can be accepted as a useful fresh
  // scrape without being treated as a complete replacement for that day.
  const knownGood={
    '2026-08-30':180,
    '2026-08-31':208,
    '2026-09-01':156,
    '2026-09-02':20,
    '2026-09-03':13,
    '2026-09-04':6,
    '2026-09-05':2
  };

  const freshByDate=new Map();
  for(const m of fresh){
    const d=canonicalTournamentDate(m.date);
    if(!d)continue;
    if(!freshByDate.has(d))freshByDate.set(d,[]);
    freshByDate.get(d).push(m);
  }

  const acceptedDates=new Set();
  const replacementSafeDates=new Set();

  for(const [d,rows] of freshByDate){
    const freshCount=rows.length;
    const target=knownGood[d]||0;

    let plausible=true;
    if(target>=100) plausible=freshCount>=Math.floor(target*0.80);
    else if(target>=10) plausible=freshCount>=Math.max(5,Math.floor(target*0.60));
    else if(target>0) plausible=freshCount>=1;
    else plausible=freshCount>=1;

    // Deleting stale FUTURE scheduled fixtures needs stronger evidence than
    // merely accepting fresh rows additively. Require at least ~80% of the
    // known-good day size. For unknown days we never delete from prior data.
    const replacementSafe=
      target>0 &&
      freshCount>=Math.ceil(target*0.80);

    console.log(
      `Matches-only date coverage ${d}: fresh ${freshCount}, known-good ${target||'n/a'}, ` +
      `${plausible?'ACCEPT ADDITIVELY':'KEEP PRIOR ONLY'}` +
      `${replacementSafe?' · FUTURE REPLACEMENT SAFE':''}.`
    );

    if(plausible)acceptedDates.add(d);
    if(replacementSafe)replacementSafeDates.add(d);
  }

  if(!acceptedDates.size){
    throw new Error(
      `Matches-only scan did not provide plausible coverage for any date ` +
      `(${[...freshByDate.keys()].join(', ')}). Existing published data was left unchanged.`
    );
  }

  // Start with the complete currently published schedule. A fresh crawl is NOT
  // allowed to delete an unmatched fixture merely because the rendered Matches
  // page failed to expose it. This is the key protection for Vic Park/Favourites.
  const finalMap=new Map();

  const richness=x=>
    (x.result?1000:0)+
    (/^(Karrinyup Shopping Centre|Squashworld Mirrabooka|Belmont Saints Squash Centre)$/i.test(clean(x.venue||''))?200:0)+
    (x.court?40:0)+
    (x.event?15:0)+
    (x.round?8:0)+
    (x.player1Id?3:0)+
    (x.player2Id?3:0);

  for(const old of existing){
    const k=exactKey(old);
    if(!k)continue;

    if(!finalMap.has(k) || richness(old)>richness(finalMap.get(k))){
      finalMap.set(k,{...old,rawText:''});
    }
  }

  const freshKeysByDate=new Map();

  for(const incoming0 of fresh){
    const d=canonicalTournamentDate(incoming0.date);
    if(!acceptedDates.has(d))continue;

    const incoming={...incoming0,rawText:''};
    const k=exactKey(incoming);
    if(!k)continue;

    if(!freshKeysByDate.has(d))freshKeysByDate.set(d,new Set());
    freshKeysByDate.get(d).add(k);

    const old=finalMap.get(k);

    if(old){
      // TournamentSoftware's current fixture/result is authoritative when it
      // supplies a value. Retain richer metadata that the current text view
      // omitted.
      if(!incoming.venue&&old.venue)incoming.venue=old.venue;
      if(!incoming.court&&old.court)incoming.court=old.court;
      if(!incoming.event&&old.event)incoming.event=old.event;
      if(!incoming.round&&old.round)incoming.round=old.round;
      if(!incoming.player1Id&&old.player1Id)incoming.player1Id=old.player1Id;
      if(!incoming.player2Id&&old.player2Id)incoming.player2Id=old.player2Id;

      if(!incoming.result&&old.result){
        incoming.result=old.result;
        incoming.status=old.status||'completed';
      }

      // Fresh row wins after exact metadata enrichment.
      finalMap.set(k,incoming);
    }else{
      finalMap.set(k,incoming);
    }
  }

  // Report how many previously published fixtures on each accepted date were
  // not visible in the fresh TournamentSoftware render and were therefore
  // deliberately preserved.
  for(const d of [...acceptedDates].sort()){
    const freshKeys=freshKeysByDate.get(d)||new Set();
    const preservedExisting=existing.filter(m=>{
      if(canonicalTournamentDate(m.date)!==d)return false;
      const k=exactKey(m);
      return k&&!freshKeys.has(k);
    });

    const futurePrunable=
      replacementSafeDates.has(d) &&
      d>perthTodayIsoRefresh()
        ? preservedExisting.filter(m=>{
            const status=String(m.status||'').toLowerCase();
            return !m.result&&!m.winner&&status!=='completed'&&status!=='played';
          }).length
        : 0;

    console.log(
      `Matches-only ${d}: ${preservedExisting.length} previously published fixture(s) ` +
      `not present in this fresh render` +
      '.'
    );
  }



  // Future schedule preservation rule:
  // Absence from an incomplete fresh render is NOT evidence that a previously
  // published future fixture was cancelled. Future rows are removed only by
  // positive slot-conflict authority below (fresh Matches / verified draw).
  console.log(
    'Future schedule preservation: unmatched future fixtures are retained unless ' +
    'positive official slot-conflict evidence replaces them.'
  );

  // If a future fixture was previously stored as Player vs TBD and the current
  // TournamentSoftware data now names the opponent, remove the stale TBD row.
  const concretePlayerSlots=new Set();
  for(const m of finalMap.values()){
    const p1=clean(m.player1||'');
    const p2=clean(m.player2||'');

    // A TBD placeholder may only be superseded by a fixture with two REAL
    // named players. "Bye" is not a confirmed opponent and must never delete
    // a scheduled Player vs TBD fixture such as Susan Hillier's next round.
    if(/^(?:TBD|Bye)$/i.test(p1)||/^(?:TBD|Bye)$/i.test(p2))continue;

    const d=canonicalTournamentDate(m.date);
    const t=timeKey(m);
    if(m.player1)concretePlayerSlots.add(`${d}|${t}|${String(m.player1Id||nameKey(m.player1))}`);
    if(m.player2)concretePlayerSlots.add(`${d}|${t}|${String(m.player2Id||nameKey(m.player2))}`);
  }

  for(const [k,m] of [...finalMap.entries()]){
    const p1Tbd=/^TBD$/i.test(clean(m.player1||''));
    const p2Tbd=/^TBD$/i.test(clean(m.player2||''));
    if(!p1Tbd&&!p2Tbd)continue;

    const knownName=p1Tbd?m.player2:m.player1;
    const knownId=p1Tbd?m.player2Id:m.player1Id;
    const slot=`${canonicalTournamentDate(m.date)}|${timeKey(m)}|${String(knownId||nameKey(knownName))}`;

    if(concretePlayerSlots.has(slot)){
      finalMap.delete(k);
    }
  }

  const final=[...finalMap.values()].sort((a,b)=>
    `${canonicalTournamentDate(a.date)} ${String(a.time||'')}`.localeCompare(
      `${canonicalTournamentDate(b.date)} ${String(b.time||'')}`
    )
  );

  const byDate={};
  for(const m of final){
    const d=canonicalTournamentDate(m.date)||'unknown';
    byDate[d]=(byDate[d]||0)+1;
  }

  console.log(
    `Matches-only merged schedule: ${final.length} fixtures across ` +
    `${Object.keys(byDate).length} date(s).`
  );
  console.log(`Matches-only merged by date: ${JSON.stringify(byDate)}`);

  // Helpful diagnostics for the tracked/Vic Park list. This catches cases where
  // the scraper saw a fixture but the merge later removed it.
  const trackedNames=loadTrackedNames();
  const trackedRows=final.filter(m=>
    trackedNames.some(n=>sameName(m.player1,n)||sameName(m.player2,n))
  );
  const trackedByDate={};
  for(const m of trackedRows){
    const d=canonicalTournamentDate(m.date)||'unknown';
    trackedByDate[d]=(trackedByDate[d]||0)+1;
  }
  console.log(`Vic Park merged matches by date: ${JSON.stringify(trackedByDate)}`);

  const sueRows=final.filter(m=>
    sameName(m.player1,'Susan Hillier')||sameName(m.player2,'Susan Hillier')
  );
  console.log(`Susan Hillier merged fixtures: ${JSON.stringify(
    sueRows.map(m=>({
      date:canonicalTournamentDate(m.date),
      time:m.time,
      player1:m.player1,
      player2:m.player2,
      venue:m.venue||'',
      court:m.court||''
    }))
  )}`);

  return final;
}

(async()=>{
  const stopTotalTiming=phaseTimer('TOTAL refresh');
  const existing=loadExisting();
  const existingPlayers=repairDuplicateSquashLevelsIdentity(Array.isArray(existing.players)?existing.players.map(p=>normalizePlayerIdentityRecord({...p})):[]);
  const trackedNames=loadTrackedNames();

  if(FULL_REBUILD){
    console.log('\n=== FULL REBUILD (:full) ===\nRebuilding players and matches from the official TournamentSoftware draws. No player-profile directory is required.\n');
  }

  if(SQUASHLEVELS_ONLY){
    console.log('\n=== SQUASHLEVELS ONLY (:squashlevels) ===\nUsing the currently published TournamentSoftware-derived players/matches and refreshing SquashLevels only.\n');

    if(existingPlayers.length<850){
      throw new Error(`Published player snapshot has only ${existingPlayers.length} players; refusing SquashLevels-only refresh.`);
    }

    let squashPlayers=existingPlayers;
    if(SQUASHLEVELS_PLAYER_ONLY){
      squashPlayers=existingPlayers.filter(p=>sameName(p.name,SQUASHLEVELS_PLAYER_ONLY));
      if(squashPlayers.length!==1){
        const names=existingPlayers.filter(p=>norm(p.name).includes(norm(SQUASHLEVELS_PLAYER_ONLY))).slice(0,10).map(p=>p.name);
        throw new Error(`SquashLevels single-player test could not resolve exactly one player for "${SQUASHLEVELS_PLAYER_ONLY}". Matches: ${names.join(', ')||'(none)'}`);
      }
      console.log(`\n=== SQUASHLEVELS SINGLE PLAYER TEST ===\nOnly checking: ${squashPlayers[0].name}\n`);
    }

    await enrichSquashLevels(squashPlayers);
    const next={...existing,squashLevelsRefreshedAt:new Date().toISOString(),players:existingPlayers};
    delete next.trackedNames;
    writeDataFiles(next);
    console.log(SQUASHLEVELS_PLAYER_ONLY
      ? `SquashLevels single-player refresh complete for ${squashPlayers[0].name}.`
      : 'SquashLevels-only refresh complete.');
    stopTotalTiming();
    return;
  }

  if(SQUASHLEVELS_LOGIN_SETUP){
    if(existingPlayers.length<850)throw new Error('No complete published player set exists for SquashLevels login setup.');
    await setupInteractiveSquashLevelsLogin(existingPlayers);
    return;
  }

  if(DRAW_DEBUG){
    console.log('\n=== DRAW STRUCTURE DEBUG (:drawdebug) ===');
    console.log('Scanning only the official TournamentSoftware age-group draw pages.');
    console.log('No published data files will be changed.\n');

    if(existingPlayers.length<850){
      throw new Error(`Published player snapshot has only ${existingPlayers.length} players; draw debug needs the existing official player identities.`);
    }

    const browser=await launchBrowser();
    const context=await browser.newContext();

    try{
      const stop=phaseTimer('TournamentSoftware draw-structure debug');
      const result=await scrapeOfficialDrawSchedule(
        context,
        {skipMatchPages:true,canonicalPlayers:existingPlayers,debugStructure:true}
      );
      stop();

      console.log(
        `DRAW DEBUG complete: ${result.drawLinks||0} draw page(s), `+
        `${result.treeObservations||0} deterministic draw-tree fixture(s).`
      );
      console.log('Upload draw-structure-debug.json so the TournamentSoftware bracket relationships can be implemented from the actual DOM.');
    }finally{
      await context.close().catch(()=>{});
      await browser.close().catch(()=>{});
    }

    stopTotalTiming();
    return;
  }

  if(MATCHES_ONLY){
    console.log('\n=== MATCHES ONLY (:matches) ===');
    console.log('Using the currently published player identities, countries, age groups and SquashLevels values.');
    console.log('Skipping SquashLevels. Scanning the official TournamentSoftware Matches page and all authoritative age-group draw trees.\n');

    if(existingPlayers.length<850){
      throw new Error(`Published player snapshot has only ${existingPlayers.length} players; refusing matches-only refresh.`);
    }

    const existingMatchCount=Array.isArray(existing.matches)?existing.matches.length:0;
    if(existingMatchCount<500){
      throw new Error(
        `Existing matches base has only ${existingMatchCount} fixtures. ` +
        `Refusing additive :matches refresh because it cannot safely preserve ` +
        `missing fixtures/results from an already incomplete base. ` +
        `Restore a known-good data.js or matches-data.js snapshot first.`
      );
    }

    const existingResultCount=(existing.matches||[]).filter(m=>m&&m.result).length;
    console.log(
      `Matches-only additive base: ${existingMatchCount} existing fixtures, ` +
      `${existingResultCount} with stored results.`
    );

    const browser=await launchBrowser();
    const context=await browser.newContext({
      viewport:{width:1440,height:1000},
      locale:'en-AU',
      timezoneId:'Australia/Perth'
    });

    let officialMatches;
    let officialDrawFallback={matches:[],trackedTbdMatches:[]};
    let trackedDrawFallback=[];
    try{
      const stopMatchesTiming=phaseTimer('TournamentSoftware Matches-only crawl');
      officialMatches=await scrapeOfficialMatchesSchedule(context,existingPlayers,Array.isArray(existing.matches)?existing.matches:[]);
      stopMatchesTiming();

      console.log('\nScanning official draws for authoritative tournament fixtures...');
      const stopTrackedDrawTiming=phaseTimer('TournamentSoftware authoritative draw crawl');

      try{
        officialDrawFallback=await scrapeOfficialDrawSchedule(
          context,
          {skipMatchPages:true,canonicalPlayers:existingPlayers}
        );

        const trackedNames=loadTrackedNames();

        const trackedConcrete=(officialDrawFallback.matches||[]).filter(m=>{
          if(!m.date||!m.time||!m.venue||!sanitizeCourtValue(m.court))return false;
          if(canonicalTournamentDate(m.date)<perthTodayIsoRefresh())return false;

          const tracked=
            trackedNames.some(n=>sameName(m.player1,n)||sameName(m.player2,n));

          if(!tracked)return false;
          if(/^(?:TBD|Bye)$/i.test(clean(m.player1||'')))return false;
          if(/^(?:TBD|Bye)$/i.test(clean(m.player2||'')))return false;

          return true;
        });

        trackedDrawFallback=trackedConcrete.map(m=>({
          ...m,
          source:'TournamentSoftware Draw Tracked Concrete Verified'
        }));

        const sueConcrete=trackedConcrete.filter(m=>
          sameName(m.player1,'Susan Hillier')||sameName(m.player2,'Susan Hillier')
        );
        console.log(`Susan Hillier concrete draw fixture(s): ${JSON.stringify(
          sueConcrete.map(m=>({
            date:m.date,time:m.time,player1:m.player1,player2:m.player2,
            venue:m.venue,court:m.court,source:m.source||''
          }))
        )}`);

        console.log(
          `Tracked draw deterministic candidates: ${trackedDrawFallback.length} concrete fixture(s), 0 guessed TBD.`
        );
      }catch(e){
        officialDrawFallback={matches:[],trackedTbdMatches:[]};
        trackedDrawFallback=[];
        throw new Error(
          `Authoritative draw crawl failed: ${String(e?.message||e).split('\n')[0]}`
        );
      }finally{
        stopTrackedDrawTiming();
      }
    }finally{
      await browser.close();
    }

    const highConfidenceOfficialMatches=filterUncorroboratedFutureRecoveredFixtures(
      officialMatches.matches||[],
      officialDrawFallback.matches||[]
    );

    assertDeterministicDrawCompleteness(officialDrawFallback,'Official draw crawl');

    // OFFICIAL DRAW = fixture existence authority for today + future.
    // Existing data is retained only for historical dates.
    let tournamentMatches=buildDrawAuthoritativeTournamentSchedule(
      Array.isArray(existing.matches)?existing.matches:[],
      officialDrawFallback.matches||[],
      highConfidenceOfficialMatches,
      {preserveHistory:true}
    );

    tournamentMatches=overlayFreshTournamentResults(
      tournamentMatches,
      highConfidenceOfficialMatches
    );

    tournamentMatches=overlayAuthoritativeTournamentResults(
      tournamentMatches,
      officialDrawFallback.matches||[],
      'TournamentSoftware Draw'
    );

    tournamentMatches=cleanupDuplicateTournamentFixtures(
      tournamentMatches,
      highConfidenceOfficialMatches
    );

    if(tournamentMatches.length<500){
      const dist={};
      for(const m of tournamentMatches){
        const d=canonicalTournamentDate(m.date)||m.date||'unknown';
        dist[d]=(dist[d]||0)+1;
      }
      throw new Error(`Merged TournamentSoftware schedule is still incomplete: ${tournamentMatches.length} fixtures. Dates: ${JSON.stringify(dist)}. Existing published data was left unchanged.`);
    }

    tournamentMatches=preserveHistoricalTournamentResults(
      tournamentMatches,
      Array.isArray(existing.matches)?existing.matches:[]
    );

    tournamentMatches=sanitizeFutureResultMetadata(tournamentMatches);

    tournamentMatches=tournamentMatches.map(m=>({
      ...m,
      court:sanitizeCourtValue(m.court)
    }));

    const squashScoresMatches=await fetchSquashScoresLiveMatches(existingPlayers);
    console.log(`Perth-today SquashScores live/completed rows eligible for overlay: ${squashScoresMatches.filter(m=>['live','completed'].includes(String(m.status||'').toLowerCase())&&canonicalTournamentDate(m.date)===perthTodayIsoRefresh()).length} (${perthTodayIsoRefresh()})`);

    const matches=mergeSquashScoresIntoMatches(tournamentMatches,squashScoresMatches)
      .map(m=>normalizeSelfMatchAsBye(m,existingPlayers))
      .map(m=>({
        ...m,
        player1:splitPlayerSeed(m.player1).name,
        player2:splitPlayerSeed(m.player2).name,
        court:sanitizeCourtValue(m.court),
        rawText:''
      }));

    const todayResultCount=matches.filter(m=>
      canonicalTournamentDate(m.date)===perthTodayIsoRefresh() &&
      !!m.result
    ).length;
    const todayWinnerCount=matches.filter(m=>
      canonicalTournamentDate(m.date)===perthTodayIsoRefresh() &&
      !!m.winner
    ).length;
    console.log(
      `PUBLISHED Perth-today result coverage: ${todayResultCount} with game scores, ` +
      `${todayWinnerCount} with winner markers.`
    );

    const todayTrackedResults=matches.filter(m=>
      canonicalTournamentDate(m.date)===perthTodayIsoRefresh() &&
      trackedNames.some(n=>sameName(m.player1,n)||sameName(m.player2,n))
    );
    console.log(`PUBLISHED Perth-today tracked fixtures: ${JSON.stringify(
      todayTrackedResults.map(m=>({
        time:m.time,player1:m.player1,player2:m.player2,
        result:m.result||'',winner:m.winner||'',status:m.status||'',
        resultSource:m.resultSource||''
      }))
    )}`);

    const watchedTodayPairs=matches.filter(m=>
      canonicalTournamentDate(m.date)===perthTodayIsoRefresh() &&
      (
        (sameName(m.player1,'Michael Corren')&&sameName(m.player2,'Alan Zaeh')) ||
        (sameName(m.player2,'Michael Corren')&&sameName(m.player1,'Alan Zaeh')) ||
        (sameName(m.player1,'Jahangir Khan')&&sameName(m.player2,'Steven May')) ||
        (sameName(m.player2,'Jahangir Khan')&&sameName(m.player1,'Steven May'))
      )
    );
    console.log(`PUBLISHED watched Aug-31 result rows: ${JSON.stringify(
      watchedTodayPairs.map(m=>({
        time:m.time,player1:m.player1,player2:m.player2,
        result:m.result||'',winner:m.winner||'',status:m.status||'',
        resultSource:m.resultSource||''
      }))
    )}`);

    const finalPublishedOnnie=matches.filter(m=>
      sameName(m.player1,'Onnie Biswas')||sameName(m.player2,'Onnie Biswas')
    );
    console.log(`PUBLISHED Onnie Biswas fixtures: ${JSON.stringify(
      finalPublishedOnnie.map(m=>({
        date:m.date,time:m.time,player1:m.player1,player2:m.player2,
        venue:m.venue||'',court:m.court||'',status:m.status||''
      }))
    )}`);

    const finalPublishedSusan=matches.filter(m=>
      sameName(m.player1,'Susan Hillier')||sameName(m.player2,'Susan Hillier')
    );
    console.log(`PUBLISHED Susan Hillier fixtures: ${JSON.stringify(
      finalPublishedSusan.map(m=>({
        date:m.date,time:m.time,player1:m.player1,player2:m.player2,
        venue:m.venue||'',court:m.court||'',result:m.result||'',status:m.status||''
      }))
    )}`);

    const invalidMatchDates=matches.filter(m=>m.date&&!isTournamentDate(canonicalTournamentDate(m.date)));
    if(invalidMatchDates.length){
      throw new Error(`Matches-only date validation failed for ${invalidMatchDates.length} fixture(s). Existing published data was left unchanged.`);
    }

    const next={
      ...existing,
      refreshedAt:new Date().toISOString(),
      players:existingPlayers,
      matches
    };
    delete next.trackedNames;

    writeDataFiles(next);

    console.log(`Matches-only refresh complete: ${matches.length} fixtures.`);
    console.log(`Preserved historical scores on ${matches.filter(m=>m.result&&String(m.status||'').toLowerCase()!=='live').length} fixture(s).`);
    console.log('SquashLevels values and player metadata were left unchanged.');
    stopTotalTiming();
    return;
  }

  const browser=await launchBrowser();
  const context=await browser.newContext({
    viewport:{width:1440,height:1000},
    locale:'en-AU',
    timezoneId:'Australia/Perth'
  });

  const all=[]; let done=0, failed=0, candidateTotal=0;
  console.log('No player-profile crawl: players and matches are rebuilt from TournamentSoftware draws only.');

  console.log('Crawling TournamentSoftware draws for players + result enrichment...');
  const stopDrawTiming=phaseTimer('TournamentSoftware draw crawl');
  const officialDraw=await scrapeOfficialDrawSchedule(context);
  stopDrawTiming();

  let canonicalPlayers=mergePreviousSquashLevelsFields(officialDraw.players||[],existingPlayers);

  const existingMatches=Array.isArray(existing.matches)?existing.matches:[];

  console.log('Crawling TournamentSoftware Matches page for authoritative schedule...');
  const stopMatchesTiming=phaseTimer('TournamentSoftware Matches schedule crawl');
  const officialMatches=await scrapeOfficialMatchesSchedule(context,canonicalPlayers,existingMatches);
  stopMatchesTiming();

  await browser.close();

  const officialSchedule=officialMatches.matches||[];

  const metadataCounts={
    country:canonicalPlayers.filter(p=>p.country).length,
    flag:canonicalPlayers.filter(p=>p.flagCode).length,
    age:canonicalPlayers.filter(p=>p.ageGroup).length,
    gender:canonicalPlayers.filter(p=>p.gender).length
  };

  // Strong all-in-one publication gates. Never silently fall back to stale
  // player-directory/profile data if the draw crawl is incomplete.
  if(canonicalPlayers.length<900){
    throw new Error(`Official draw player coverage looks incomplete: ${canonicalPlayers.length} players (expected at least 900 from the draw hierarchy). Existing published data was left unchanged.`);
  }
  if(metadataCounts.country<Math.floor(canonicalPlayers.length*0.95)){
    throw new Error(`Official draw country coverage looks incomplete: ${metadataCounts.country}/${canonicalPlayers.length} players. Existing published data was left unchanged.`);
  }
  if(metadataCounts.age<Math.floor(canonicalPlayers.length*0.95) || metadataCounts.gender<Math.floor(canonicalPlayers.length*0.95)){
    throw new Error(`Official draw age/gender coverage looks incomplete: age ${metadataCounts.age}/${canonicalPlayers.length}, gender ${metadataCounts.gender}/${canonicalPlayers.length}. Existing published data was left unchanged.`);
  }
  assertDeterministicDrawCompleteness(
    officialDraw,
    FULL_REBUILD?'Full deterministic draw-tree rebuild':'Deterministic draw-tree refresh'
  );

  const todayForAuthority=perthTodayIsoRefresh();
  const officialHistoricalRows=officialSchedule.filter(m=>
    m?.date&&m?.time&&
    canonicalTournamentDate(m.date)<todayForAuthority&&
    !/^(?:TBD|Bye)$/i.test(clean(m.player1||''))&&
    !/^(?:TBD|Bye)$/i.test(clean(m.player2||''))
  );

  // Normal scheduled refreshes preserve already-published history because the
  // TournamentSoftware Matches page can render incompletely from one request to
  // the next. :full deliberately reconstructs history from the fresh official
  // Matches crawl instead.
  const historicalBase=FULL_REBUILD?officialHistoricalRows:existingMatches;

  console.log(
    `Historical authority base: ${historicalBase.length} row(s) from `+
    `${FULL_REBUILD?'fresh TournamentSoftware Matches crawl':'existing published history'}.`
  );

  let tournamentMatches=buildDrawAuthoritativeTournamentSchedule(
    historicalBase,
    officialDraw.matches||[],
    officialSchedule,
    {preserveHistory:true}
  );

  tournamentMatches=overlayFreshTournamentResults(
    tournamentMatches,
    officialSchedule
  );

  tournamentMatches=overlayAuthoritativeTournamentResults(
    tournamentMatches,
    officialDraw.matches||[],
    'TournamentSoftware Draw'
  );


  tournamentMatches=cleanupDuplicateTournamentFixtures(
    tournamentMatches,
    officialSchedule
  );

  if(!FULL_REBUILD){
    tournamentMatches=preserveHistoricalTournamentResults(
      tournamentMatches,
      existingMatches
    );
  }

  tournamentMatches=sanitizeFutureResultMetadata(tournamentMatches);

  const drawCompleted=(officialDraw.matches||[]).filter(m=>m.result||String(m.status||'').toLowerCase()==='completed');
  const drawScored=(officialDraw.matches||[]).filter(m=>m.result);

  console.log(`Authoritative TournamentSoftware draw players: ${canonicalPlayers.length}`);
  console.log(`Player metadata from draws: country ${metadataCounts.country}, flag ${metadataCounts.flag}, age ${metadataCounts.age}, gender ${metadataCounts.gender}`);
  console.log(`TournamentSoftware Matches overlay rows: ${officialSchedule.length}`);
  console.log(`TournamentSoftware draw/result rows available for score enrichment: ${drawCompleted.length} (${drawScored.length} with game scores).`);
  console.log(`Published schedule fixtures carrying TournamentSoftware scores: ${tournamentMatches.filter(m=>m.result).length}`);

  // SquashScores is Perth-today LIVE enrichment only. It can only update
  // score/status on an exact existing TournamentSoftware fixture.
  const squashScoresMatches=await fetchSquashScoresLiveMatches(canonicalPlayers);
  console.log(`Perth-today SquashScores live/completed rows eligible for overlay: ${squashScoresMatches.filter(m=>['live','completed'].includes(String(m.status||'').toLowerCase())&&canonicalTournamentDate(m.date)===perthTodayIsoRefresh()).length} (${perthTodayIsoRefresh()})`);
  const matches=mergeSquashScoresIntoMatches(tournamentMatches,squashScoresMatches).map(m=>normalizeSelfMatchAsBye(m,canonicalPlayers));

  const glass=matches.filter(isGlass);
  const freshCompleted=officialDraw.matches.filter(m=>String(m.status||'').toLowerCase()==='completed'||m.result);
  const freshScored=officialDraw.matches.filter(m=>m.result);
  const completedMatches=matches.filter(m=>String(m.status||'').toLowerCase()==='completed'||m.result);
  const scoredMatches=matches.filter(m=>m.result);

  console.log(`Existing published matches before refresh: ${existingMatches.length}`);
  console.log(`SquashScores live matches observed: ${squashScoresMatches.length}`);
  console.log(`Final published matches after live merge: ${matches.length}`);
  console.log(`Glass Court matches after merge: ${glass.length}`);
  console.log(`Fresh completed/result matches: ${freshCompleted.length} (${freshScored.length} with score data)`);
  console.log(`Merged completed/result matches: ${completedMatches.length} (${scoredMatches.length} with score data)`);
  console.log(`Vic Park watchlist (${trackedNames.length}): ${trackedNames.join(', ')}`);
  for(const n of trackedNames)console.log(`  ${n}: ${matches.filter(m=>hasPlayer(m,n)).length} match(es)`);

  const audit={
    refreshedAt:new Date().toISOString(),
    officialPlayerIds:canonicalPlayers.filter(p=>p.officialPlayerId).length,
    existingMatches:existingMatches.length,
    matchesOverlayRows:officialSchedule.length,
    rawDrawFixtureCandidates:officialDraw.rawFixtureCandidates||0,
    tournamentMatchesAfterDrawResults:tournamentMatches.length,
    squashScoresMatches:squashScoresMatches.length,
    squashScoresScoredMatches:squashScoresMatches.filter(m=>m.result).length,
    mergedMatches:matches.length,
    glassCourtMatches:glass.length,
    drawCompletedMatches:freshCompleted.length,
    drawScoredMatches:freshScored.length,
    mergedCompletedMatches:completedMatches.length,
    mergedScoredMatches:scoredMatches.length,
    tracked:trackedNames.map(n=>({name:n,matches:matches.filter(m=>hasPlayer(m,n)).length}))
  };
  fs.writeFileSync(path.join(DIR,'refresh-audit.json'),JSON.stringify(audit,null,2));
  fs.writeFileSync(path.join(DIR,'refresh-matches.json'),JSON.stringify(matches,null,2));


  // Structural schedule safety is enforced by assertDeterministicDrawCompleteness()
  // plus buildDrawAuthoritativeTournamentSchedule()'s location/collision checks.
  // For a normal refresh, additionally make sure historical preservation did
  // not unexpectedly collapse the published dataset.
  if(!FULL_REBUILD){
    const oldHistory=existingMatches.filter(m=>
      canonicalTournamentDate(m.date)<perthTodayIsoRefresh()
    ).length;
    const newHistory=tournamentMatches.filter(m=>
      canonicalTournamentDate(m.date)<perthTodayIsoRefresh()
    ).length;

    if(oldHistory>=100 && newHistory<Math.floor(oldHistory*0.90)){
      throw new Error(
        `Historical preservation unexpectedly dropped from ${oldHistory} to ${newHistory} fixture(s). `+
        `Existing published data was left unchanged.`
      );
    }
  }

  if(FULL_REBUILD){
    console.log('Full rebuild: TournamentSoftware players/matches were rebuilt entirely from draws; SquashLevels mappings are retained by official player ID and revalidated during enrichment.');
  }
  // SquashLevels is enrichment only for a normal tournament refresh.
  // Do not throw away a successful TournamentSoftware refresh just because
  // SquashLevels blocks/partially authenticates an automated CI session.
  // canonicalPlayers started as a copy of the existing dataset, so if this
  // phase fails the last known valid SquashLevels values remain intact.
  try{
    await enrichSquashLevels(canonicalPlayers);
  }catch(e){
    console.warn(`SquashLevels enrichment skipped: ${e.message}`);
    console.warn('Continuing with TournamentSoftware/Vic Park publish and preserving previously stored SquashLevels values.');
  }
  const normalizedCanonicalPlayers=repairDuplicateSquashLevelsIdentity(canonicalPlayers.map(normalizePlayerIdentityRecord));
  const next={...existing,refreshedAt:new Date().toISOString(),players:normalizedCanonicalPlayers,matches};
  delete next.trackedNames;

  // Hard safety gate: this tournament only runs 30 Aug–6 Sep 2026.
  // Never replace the published dataset if the scraper has attached an
  // unrelated profile/history date to a match.
  const invalidMatchDates=(next.matches||[]).filter(m=>!isTournamentDate(String(m.date||'')));
  if(invalidMatchDates.length){
    const sample=invalidMatchDates.slice(0,10).map(m=>`${m.date||'(missing)'} ${m.player1||'?'} vs ${m.player2||'?'}`).join(' | ');
    throw new Error(`Date validation failed: ${invalidMatchDates.length} match(es) are outside ${TOURNAMENT_START_DATE}..${TOURNAMENT_END_DATE}. Existing published data was left unchanged. Sample: ${sample}`);
  }

  writeDataFiles(next);
  console.log('Data validation passed. Updated data.js plus summary-data.js, players-data.js, matches-data.js and vicpark-data.js. Design pages and vic-park-players.js were not changed.');
  stopTotalTiming();
})().catch(err=>{console.error('\nRefresh failed:',err.message);process.exit(1)});
