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
const MIN_MATCHES = 350; // confirmed player-v-player matches; later-round TBD slots are not on player profiles
const MIN_RAW_OBSERVATIONS = 850;
const CONCURRENCY = Number(process.env.CRAWL_WORKERS || 3);
const NAV_TIMEOUT = 60000;
const PROFILE_WAIT = Number(process.env.PROFILE_WAIT_MS || 700);
const FULL_REBUILD = process.argv.includes(':full');
const SQUASHLEVELS_ONLY = process.argv.includes(':squashlevels');
const SQUASHLEVELS_LOGIN_SETUP = process.argv.includes(':squashlevels-login');
const SQUASHLEVELS_PLAYER_ONLY = (()=>{
  if(!SQUASHLEVELS_ONLY)return '';
  const modeArgs=new Set([':full',':squashlevels',':squashlevels-login']);
  const extra=process.argv.slice(2).filter(x=>!modeArgs.has(x));
  return String(extra.join(' ')||'').replace(/\s+/g,' ').trim();
})();
const SQUASHLEVELS_STORAGE_FILE = path.join(DIR,'squashlevels-storage-state.json');
const SQUASHLEVELS_SESSION_FILE = path.join(DIR,'squashlevels-session-storage.json');
const SQUASHLEVELS_STORAGE_B64_FILE = path.join(DIR,'squashlevels-storage-state.b64.txt');
const SQUASHLEVELS_SESSION_B64_FILE = path.join(DIR,'squashlevels-session-storage.b64.txt');
if([FULL_REBUILD,SQUASHLEVELS_ONLY,SQUASHLEVELS_LOGIN_SETUP].filter(Boolean).length>1){
  throw new Error('Use only one of :full, :squashlevels or :squashlevels-login.');
}

const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
const norm = s => clean(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[’‘]/g,"'").toLowerCase();
const nameKey = s => {
  let v=clean(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[’‘]/g,"'");
  if(v.includes(',')){const a=v.split(',').map(x=>x.trim()).filter(Boolean);if(a.length===2)v=a[1]+' '+a[0];}
  return v.toLowerCase().replace(/\b(?:aus|eng|sco|wal|sui|nzl|usa|can|fra|ger|deu|irl|rsa|ind|jpn|mas|sgp|hkg)\b/g,' ').replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/).filter(Boolean).sort().join(' ');
};
const sameName=(a,b)=>!!a&&!!b&&(norm(a)===norm(b)||nameKey(a)===nameKey(b));
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
  const legacy=evalWindowFile('data.js').TOURNAMENT_DATA;
  if(legacy)return legacy;
  const summary=evalWindowFile('summary-data.js').TOURNAMENT_SUMMARY||{};
  const players=evalWindowFile('players-data.js').TOURNAMENT_PLAYERS||[];
  const matches=evalWindowFile('matches-data.js').TOURNAMENT_MATCHES||[];
  if(players.length)return {...summary,players,matches};
  throw new Error('No tournament dataset found. Expected data.js or the split summary/players/matches data files.');
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

function parseDate(s){
  s=clean(s); let m;
  m=s.match(/\b(2026)[-\/.](\d{1,2})[-\/.](\d{1,2})\b/); if(m)return `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;
  m=s.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](2026)\b/); if(m)return `${m[3]}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
  m=s.match(/\b(\d{1,2})\s+(Aug(?:ust)?|Sep(?:tember)?)\s*(?:2026)?\b/i); if(m)return `2026-${/^sep/i.test(m[2])?'09':'08'}-${String(m[1]).padStart(2,'0')}`;
  m=s.match(/\b(Aug(?:ust)?|Sep(?:tember)?)\s+(\d{1,2})(?:,?\s*2026)?\b/i); if(m)return `2026-${/^sep/i.test(m[1])?'09':'08'}-${String(m[2]).padStart(2,'0')}`;
  return '';
}
function parseTime(s){const m=clean(s).match(/\b(\d{1,2}):([0-5]\d)\s*(am|pm)?\b/i);return m?clean(m[0]):''}
function deriveFields(text, fallbackEvent=''){
  text=clean(text);
  const event=(text.match(/(?:Men(?:'s)?|Women(?:'s)?)\s*(?:Over\s*)?(?:35|40|45|50|55|60|65|70|75|80|85)\+?/i)||[])[0]||fallbackEvent;
  const round=(text.match(/\b(?:Final|Semi[- ]?final|Quarter[- ]?final|Round\s+of\s+\d+|Round\s+\d+|Plate(?:\s+Final)?|Playoff|Position\s+\d+(?:-|–)\d+)\b/i)||[])[0]||'';
  let venue='';
  if(/Karrinyup/i.test(text)) venue='Karrinyup Shopping Centre';
  else if(/Mirrabooka/i.test(text)) venue='Squashworld Mirrabooka';
  else if(/Marmion/i.test(text)) venue='Marmion Squash Club';
  else if(/Belmont/i.test(text)) venue='Belmont Squash Centre';
  const court=(text.match(/\b(AGC|SC\s*\d+|Court\s*\d+|[A-Z]{2,5}\s*\d+)\b/i)||[])[1]||'';
  const score=(text.match(/\b\d{1,2}[-–]\d{1,2}(?:\s*,\s*\d{1,2}[-–]\d{1,2}){1,4}\b/)||[])[0]||'';
  return {date:parseDate(text),time:parseTime(text),event:clean(event),round:clean(round),venue,court:clean(court),result:score,status:score?'completed':'scheduled'};
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
async function dismissPopups(page){
  for(const rx of [/accept/i,/agree/i,/allow all/i,/got it/i]){try{const b=page.getByRole('button',{name:rx}).first();if(await b.count()&&await b.isVisible())await b.click({timeout:800})}catch{}}
}

async function collectOfficialPlayerLinks(page, canonicalPlayers){
  await safeGoto(page,PLAYERS_URL); await dismissPopups(page); await sleep(1500);
  // Force lazy player directory to expose every link.
  for(let i=0;i<30;i++){try{const old=await page.evaluate(()=>document.documentElement.scrollHeight);await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));await sleep(250);const now=await page.evaluate(()=>document.documentElement.scrollHeight);if(now===old&&i>4)break}catch{break}}
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
      const nm=clean(x.text);
      if(nm.length<3||nm.length>90||!/[A-Za-z]/.test(nm))continue;
      p={name:nm,gender:'',ageGroup:'',country:'',iso3:'',flagCode:'',officialPlayerId,officialProfileUrl:href};
      canonicalPlayers.push(p);canonicalByKey.set(nameKey(nm),p);canonicalById.set(String(officialPlayerId),p);added++;
    }
    if(!p)continue;
    if(FULL_REBUILD&&p.name!==clean(x.text)&&canonicalById.get(String(officialPlayerId))===p){
      console.log(`  Official name change: ${p.name} -> ${clean(x.text)}`);
      p.name=clean(x.text);renamed++;
    }
    p.officialPlayerId=officialPlayerId;p.officialProfileUrl=href;
    if(!byHref.has(href))byHref.set(href,{name:p.name,href,officialPlayerId,country:p.country,gender:p.gender,ageGroup:p.ageGroup});
  }
  if(FULL_REBUILD)console.log(`Full rebuild directory reconciliation: ${renamed} renamed player(s), ${added} newly discovered player(s).`);
  return [...byHref.values()];
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
        const dateRe=/(?:\b2026[-\/.]\d{1,2}[-\/.]\d{1,2}\b|\b\d{1,2}[\/.-]\d{1,2}[\/.-]2026\b|\b\d{1,2}\s+(?:Aug(?:ust)?|Sep(?:tember)?)\b|\b(?:Aug(?:ust)?|Sep(?:tember)?)\s+\d{1,2}\b)/i;
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
          const ctx=contextFor(el); const key=(text+'|'+ctx+'|'+players.map(x=>x.href).join('|')).slice(0,3500); if(seen.has(key))return;seen.add(key);
          out.push({source,text,context:ctx,links,playerLinks:players});
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
  const byName=new Map(canonicalPlayers.map(p=>[nameKey(p.name),p]));
  const byHref=new Map(), byHrefKey=new Map(), byId=new Map();
  for(const x of officialLinks){
    const href=x.href.split('#')[0];
    const id=x.officialPlayerId||hrefKey(href);
    const info={name:x.name,href,officialPlayerId:id};
    byHref.set(href,info);
    byHrefKey.set(hrefKey(href),info);
    byId.set(id,info);
    const p=byName.get(nameKey(x.name));
    if(p){p.officialPlayerId=id;p.officialProfileUrl=href;}
  }
  return {byName,byHref,byHrefKey,byId};
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
    const rawName=l.info?.name||lookup.byName.get(nameKey(l.text))?.name||l.text;
    if(!rawName||sameName(rawName,current.name))continue;
    const canonical=lookup.byName.get(nameKey(rawName));
    opponent=canonical?.name||clean(rawName).replace(/\s*\([^)]*\)\s*$/,'').trim();
    opponentId=l.info?.officialPlayerId||canonical?.officialPlayerId||l.id||'';
    if(opponent)break;
  }

  if(!opponent){
    const hay=' '+norm(whole).replace(/[^a-z0-9]+/g,' ')+' ';
    for(const p of lookup.byName.values()){
      if(sameName(p.name,current.name))continue;
      const k=norm(p.name).replace(/[^a-z0-9]+/g,' ').trim();
      if(k.length>4&&hay.includes(' '+k+' ')){opponent=p.name;opponentId=p.officialPlayerId||'';break}
    }
  }

  if(!opponent&&/\bTBD\b|to be determined|winner of|loser of|bye/i.test(whole))opponent=/bye/i.test(whole)?'Bye':'TBD';
  if(!opponent)return null;
  return {...f,player1:current.name,player1Id:currentId,player2:opponent,player2Id:opponentId,rawText:whole,sourcePlayer:current.name,sourcePlayerId:currentId,sourceUrl:current.href};
}
async function scrapeOneProfile(page,current,lookup,networkBucket){
  let candidates=[];
  try{
    await safeGoto(page,current.href,3); await dismissPopups(page); await openMatchesArea(page); await sleep(PROFILE_WAIT);
    // A little scrolling helps modern lazy profile lists.
    for(let i=0;i<6;i++){try{await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));await sleep(120)}catch{break}}
    candidates=await extractProfileCandidates(page);
  }catch(e){return {matches:[],error:e.message,candidates:0}}
  let pageDate=''; try{pageDate=await page.evaluate(()=>{const t=(document.body.innerText||'');const m=t.match(/(?:\b2026[-\/.]\d{1,2}[-\/.]\d{1,2}\b|\b\d{1,2}[\/.-]\d{1,2}[\/.-]2026\b|\b\d{1,2}\s+(?:Aug(?:ust)?|Sep(?:tember)?)\b|\b(?:Aug(?:ust)?|Sep(?:tember)?)\s+\d{1,2}\b)/i);return m?m[0]:''})}catch{}
  const matches=candidates.map(c=>{if(pageDate&&!parseDate(`${c.context||''} ${c.text||''}`))c.context=clean(`${pageDate} ${c.context||''}`);return candidateToMatch(c,current,lookup)}).filter(Boolean);
  // Parse JSON responses captured during this profile as a second source. We only accept
  // JSON records when both the current player and another canonical player are identifiable.
  for(const packet of networkBucket.splice(0)){
    const stack=[packet.body];
    while(stack.length){const o=stack.pop();if(!o||typeof o!=='object')continue;if(Array.isArray(o)){stack.push(...o);continue}const txt=clean(JSON.stringify(o));const f=deriveFields(txt,`${current.gender==='Women'?'Women\'s':'Men\'s'} ${current.ageGroup}+`);if(f.date){const currentToken=hrefKey(current.href); const currentHit=(' '+norm(txt).replace(/[^a-z0-9]+/g,' ')+' ').includes(' '+norm(current.name).replace(/[^a-z0-9]+/g,' ').trim()+' ') || (currentToken&&txt.toLowerCase().includes(String(currentToken).toLowerCase()));if(currentHit){let opp='';const hay=' '+norm(txt).replace(/[^a-z0-9]+/g,' ')+' ';for(const p of lookup.byName.values()){if(sameName(p.name,current.name))continue;const k=norm(p.name).replace(/[^a-z0-9]+/g,' ').trim();if(k.length>4&&hay.includes(' '+k+' ')){opp=p.name;break}}if(opp&&!explicitEventMismatch(f.event,current)){const op=lookup.byName.get(nameKey(opp));matches.push({...f,player1:current.name,player1Id:current.officialPlayerId||hrefKey(current.href),player2:opp,player2Id:op?.officialPlayerId||'',rawText:txt,sourcePlayer:current.name,sourcePlayerId:current.officialPlayerId||hrefKey(current.href),sourceUrl:current.href})}}}for(const v of Object.values(o))if(v&&typeof v==='object')stack.push(v)}
  }
  return {matches,error:'',candidates:candidates.length};
}

function matchKey(m){
  const identities=[m.player1Id||nameKey(m.player1),m.player2Id||nameKey(m.player2)].sort().join('~');
  return [m.date,clean(m.time).toLowerCase(),identities].join('|');
}
function mergeMatches(list){
  const out=[];
  const mergeInto=(x,m)=>{
    for(const fld of ['event','round','venue','court','result','status','rawText','player1Id','player2Id','sourcePlayerId']){
      if((!x[fld]||String(x[fld]).length<String(m[fld]||'').length)&&m[fld])x[fld]=m[fld];
    }
    if((x.player2==='TBD'||x.player2==='Bye')&&m.player2&&m.player2!=='TBD'&&m.player2!=='Bye')x.player2=m.player2;
    if((x.player1==='TBD'||x.player1==='Bye')&&m.player1&&m.player1!=='TBD'&&m.player1!=='Bye')x.player1=m.player1;
  };
  for(const m of list){
    let x=out.find(o=>matchKey(o)===matchKey(m));
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
const SQUASHLEVELS_CONCURRENCY=Number(process.env.SQUASHLEVELS_WORKERS||3);
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
    'south africa':['RSA','ZAF'],'singapore':['SIN','SGP'],'united arab emirates':['UAE','ARE'],
    'germany':['GER','DEU'],'netherlands':['NED','NLD'],'switzerland':['SUI','CHE'],
    'denmark':['DEN','DNK'],'greece':['GRE','GRC'],'croatia':['CRO','HRV'],'portugal':['POR','PRT'],
    'malaysia':['MAS','MYS'],'chile':['CHI','CHL']
  };
  return [...new Set((aliases[iso]||byName[country]||[iso]).filter(Boolean))];
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
  try{return await page.evaluate(({wantedName})=>{
    const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
    const rawLines=String(document.body?.innerText||'').split(/\r?\n/).map(clean).filter(Boolean);
    const dupIdx=rawLines.findIndex(x=>/possible\s+duplicates?/i.test(x));
    const mainLines=dupIdx>=0?rawLines.slice(0,dupIdx):rawLines;
    const mainText=mainLines.join('\n');
    let age=null; const ageMatch=mainText.match(/\bO\s*(\d{2})\b/i); if(ageMatch)age=Number(ageMatch[1]);
    let clubLocation='',countryCode='';
    const wanted=clean(wantedName).toLowerCase();
    const nameLine=mainLines.findIndex(x=>clean(x).toLowerCase()===wanted);
    const candidates=[]; if(nameLine>=0){for(let i=nameLine+1;i<Math.min(mainLines.length,nameLine+8);i++)candidates.push(mainLines[i]);}
    candidates.push(...mainLines.filter(x=>x.length<=180&&x.includes(',')));
    for(const t of candidates){if(!t||/SA ID:|ratings|confidence|following|follow|invite/i.test(t))continue;const cm=t.match(/(?:^|,\s*)([A-Z]{3})\s*$/);if(cm){clubLocation=t;countryCode=cm[1].toUpperCase();break;}}
    let level=null; const levelIdx=mainLines.findIndex(x=>/^LEVEL$/i.test(x)); if(levelIdx>=0){for(let i=levelIdx+1;i<Math.min(mainLines.length,levelIdx+4);i++){const m=mainLines[i].match(/([\d,]+)(?:\s*\(P\))?/i);if(m){level=Number(m[1].replace(/,/g,''));break;}}}
    const duplicateRows=[];
    for(const tr of document.querySelectorAll('tr')){let cur=tr.parentElement,inDup=false;for(let i=0;i<6&&cur;i++,cur=cur.parentElement){if(/possible\s+duplicates?|duplicate\s+players?\s+found/i.test(clean(cur.innerText||''))){inDup=true;break;}}if(!inDup)continue;const rowText=clean(tr.innerText||'');if(!rowText||/possible duplicate players found|last match|duplicate\?/i.test(rowText))continue;const a=tr.querySelector('a[href*="player"]');const href=a?.href||a?.getAttribute('href')||'';const id=(href.match(/[?&]player=(\d+)/i)||[])[1]||'';const cells=[...tr.querySelectorAll('td')].map(td=>clean(td.innerText||''));duplicateRows.push({id,href,rowText,cells});}
    return {age,clubLocation,countryCode,level,duplicateRows};
  },{wantedName:player?.name||''});}catch{return {age:null,clubLocation:'',countryCode:'',level:null,duplicateRows:[]};}
}
function squashLevelsDuplicateRowEvidence(row){
  const cells=Array.isArray(row?.cells)?row.cells:[]; const text=[...cells,row?.rowText||''].join(' | '); let level=null,lastMatch=null;
  for(const c of cells){const n=String(c||'').replace(/,/g,'').trim();if(!level&&/^\d{2,6}$/.test(n))level=Number(n);const ts=squashLevelsParseMonthYear(c);if(ts){lastMatch=ts;break;}}
  if(!lastMatch)lastMatch=squashLevelsParseMonthYear(text); return {level,lastMatch};
}
async function chooseSquashLevelsCandidate(page,candidates,player){
  const checked=[]; const crossEvidence=new Map();
  for(const c of candidates){
    try{
      await safeGoto(page,c.url,2); await page.waitForTimeout(700);
      const identity=await squashLevelsProfileIdentity(page,player,c.name||player.name);
      const evidence=await readSquashLevelsProfileEvidence(page,player);
      const countryCode=clean(identity.countryCode||evidence.countryCode).toUpperCase();
      const expectedCodes=squashLevelsExpectedCountryCodes(player);
      const countryMatch=countryCode?expectedCodes.includes(countryCode):identity.countryMatch;
      const age=identity.age??evidence.age??null; const expectedAge=Number(player.ageGroup)||null;
      const ageMatch=expectedAge&&age?Number(age)===expectedAge:identity.ageMatch;
      for(const row of evidence.duplicateRows||[]){const id=clean(row.id);if(!id)continue;const parsed=squashLevelsDuplicateRowEvidence(row);const prior=crossEvidence.get(id)||{};crossEvidence.set(id,{level:parsed.level??prior.level??null,lastMatch:Math.max(parsed.lastMatch||0,prior.lastMatch||0)||null});}
      const apiLastMatch=squashLevelsLastMatchFromApiCandidate(c); const profileLastMatch=await squashLevelsProfileLastMatch(page); const id=clean(c.playerId||squashLevelsPlayerIdFromUrl(c.url));
      checked.push({...c,identity:{...identity,countryCode,countryMatch,age,ageMatch},profileEvidence:evidence,playerId:id,lastMatch:Math.max(apiLastMatch||0,profileLastMatch||0)||null});
    }catch(e){console.log(`  Candidate profile check failed for ${player.name}: ${e.message}`);}
  }
  if(!checked.length)return null;
  for(const x of checked){const cross=crossEvidence.get(clean(x.playerId));if(cross){if(!x.lastMatch&&cross.lastMatch)x.lastMatch=cross.lastMatch;x.duplicateTableLevel=cross.level??null;}}
  let pool=checked.some(x=>x.identity.countryMatch===true)?checked.filter(x=>x.identity.countryMatch===true):checked.filter(x=>x.identity.countryMatch!==false); if(!pool.length)return null;
  if(pool.some(x=>x.identity.ageMatch===true))pool=pool.filter(x=>x.identity.ageMatch===true);else if(pool.some(x=>x.identity.ageMatch===false)){const unknownAge=pool.filter(x=>x.identity.ageMatch!==false);if(unknownAge.length)pool=unknownAge;}
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

        // searchSquashLevels has already applied the strict exact-name gate. If it returns
        // zero or one profile, there is no duplicate set to resolve and the cached mapping
        // is deliberately left untouched.
        if(fresh.length<=1){
          done++;
          if(done%40===0||queue.length===0){
            console.log(`  ${done} identity checks · ${verified} verified · ${duplicatesFound} duplicate set(s) · ${remapped} remapped · ${rejected} rejected · ${failed} failures`);
          }
          await sleep(100);
          continue;
        }

        duplicatesFound++;

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

        accepted=await chooseSquashLevelsCandidate(page,compare,p);

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
        }else{
          // A failed duplicate comparison must never destroy a previously verified mapping.
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

        accepted=await chooseSquashLevelsCandidate(page,candidates,p);
        if(!accepted&&candidates.length)rejected+=candidates.length;

        if(!accepted&&candidates.some(c=>c.existing)){
          p.squashLevelsUrl='';
          p.squashLevelsPlayerId='';
          p.squashLevelsIdentityVerified=false;
          delete p.squashLevelsLevel;
          p.squashLevelsWorldRank=null;

          const fresh=await searchSquashLevels(p);
          p.squashLevelsSearchCheckedAt=new Date().toISOString();
          accepted=await chooseSquashLevelsCandidate(page,fresh,p);
          if(!accepted&&fresh.length)rejected+=fresh.length;
        }

        if(!accepted&&!p.squashLevelsUrl){
          const variants=nicknameVariants(splitPersonName(p.name).first);
          if(variants.length){
            const fallback=await searchSquashLevelsNicknameFallback(p);
            const nicknameAccepted=await chooseSquashLevelsNicknameCandidate(page,fallback,p);
            if(nicknameAccepted){
              accepted=nicknameAccepted;
              console.log(`  Nickname match: ${p.name} -> ${nicknameAccepted.name} (${nicknameAccepted.identity.countryCode}, O${nicknameAccepted.identity.age})`);
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
  return clean(evidence?.clubLocation||'');
}

async function refreshSquashLevelsProfileMetrics(players,sharedContext=null,sharedPage=null){
  const queue=players.filter(p=>p.squashLevelsUrl&&p.squashLevelsIdentityVerified);
  if(!queue.length)return {ranked:0,leveled:0,failed:0};
  console.log(`SquashLevels: reading current World ranking + Level from all ${queue.length} resolved profile page(s) in the SAME authenticated tab...`);
  const ownsBrowser=!sharedContext;
  const browser=ownsBrowser?await launchBrowser():null;
  const context=sharedContext||await browser.newContext({viewport:{width:1280,height:900},locale:'en-AU',timezoneId:'Australia/Perth'});
  const page=sharedPage||(ownsBrowser?await loginSquashLevels(context,players):await context.newPage());
  let done=0,ranked=0,leveled=0,failed=0;
  while(queue.length){
    const p=queue.shift();
    try{
      const profileUrl=canonicalSquashLevelsProfileUrl(p.squashLevelsUrl);
      if(profileUrl!==p.squashLevelsUrl)p.squashLevelsUrl=profileUrl;
      await safeGoto(page,profileUrl,2);
      await page.waitForTimeout(900);
      if(done<3){
        const st=await squashLevelsProfileAuthState(page);
        console.log(`  Same-tab check ${p.name}: auth=${st.compareWithMe?'YES':'NO'}, headline=${st.headlineLevel||'(missing)'}, current=${st.currentLevel||'(missing)'}`);
      }
      const world=await readSquashLevelsWorld(page);
      const level=await readSquashLevelsLevel(page);
      const clubLocation=await readSquashLevelsClubLocation(page,p);
      if(done<3)console.log(`    Club/location: ${clubLocation||'(missing)'}`);
      p.squashLevelsProfileCheckedAt=new Date().toISOString();
      p.squashLevelsWorldRank=world??null;
      p.squashLevelsLevel=level?.value??null;
      p.squashLevelsLevelProvisional=!!level?.provisional;
      p.squashLevelsClubLocation=clubLocation||p.squashLevelsClubLocation||'';
      if(world!==null&&world!==undefined&&String(world).trim()!=='')ranked++;
      if(level?.value)leveled++;
    }catch(e){
      failed++;p.squashLevelsProfileCheckedAt=new Date().toISOString();
      console.log(`  SquashLevels profile failed for ${p.name}: ${e.message}`);
    }
    done++;if(done%40===0||queue.length===0)console.log(`  ${done} profiles · ${ranked} World rankings · ${leveled} Levels · ${failed} failures`);
    await sleep(100);
  }
  if(!sharedPage)await page.close().catch(()=>{});
  if(ownsBrowser)await browser.close();
  return {ranked,leveled,failed};
}

async function enrichSquashLevels(players){
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
    const linkResult=await resolveSquashLevelsLinks(players,context,page);
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
  }
}

function isGlass(m){return /\bAGC\b|Karrinyup/i.test([m.court,m.venue,m.rawText].join(' '))}
function hasPlayer(m,n){return sameName(m.player1,n)||sameName(m.player2,n)}

(async()=>{
  const existing=loadExisting(); const canonicalPlayers=(existing.players||[]).map(p=>({...p})); const trackedNames=loadTrackedNames();
  if(FULL_REBUILD)console.log('\n=== FULL REBUILD (:full) ===\nIgnoring player-links.json, rediscovering the official directory, reconciling names by TournamentSoftware ID, and rebuilding SquashLevels identity mappings.\n');
  if(SQUASHLEVELS_ONLY)console.log('\n=== SQUASHLEVELS ONLY (:squashlevels) ===\nSkipping TournamentSoftware player discovery, schedule crawling and match rebuilding. Using the players/matches already stored in the local dataset.\n');
  if(canonicalPlayers.length<900)throw new Error(`Canonical player snapshot has only ${canonicalPlayers.length} players; refusing refresh.`);

  if(SQUASHLEVELS_LOGIN_SETUP){
    await setupInteractiveSquashLevelsLogin(canonicalPlayers);
    return;
  }

  if(SQUASHLEVELS_ONLY){
    let squashPlayers=canonicalPlayers;
    if(SQUASHLEVELS_PLAYER_ONLY){
      squashPlayers=canonicalPlayers.filter(p=>sameName(p.name,SQUASHLEVELS_PLAYER_ONLY));
      if(squashPlayers.length!==1){
        const names=canonicalPlayers.filter(p=>norm(p.name).includes(norm(SQUASHLEVELS_PLAYER_ONLY))).slice(0,10).map(p=>p.name);
        throw new Error(`SquashLevels single-player test could not resolve exactly one player for "${SQUASHLEVELS_PLAYER_ONLY}". Matches: ${names.join(', ')||'(none)'}`);
      }
      console.log(`\n=== SQUASHLEVELS SINGLE PLAYER TEST ===\nOnly checking: ${squashPlayers[0].name}\n`);
    }
    await enrichSquashLevels(squashPlayers);
    const next={...existing,squashLevelsRefreshedAt:new Date().toISOString(),players:canonicalPlayers};
    delete next.trackedNames;
    writeDataFiles(next);
    console.log(SQUASHLEVELS_PLAYER_ONLY
      ? `SquashLevels single-player refresh complete for ${squashPlayers[0].name}. All other player mappings were left unchanged.`
      : 'SquashLevels-only refresh complete. Updated split player/summary/Vic Park data; tournament matches and main refreshedAt timestamp were left unchanged.');
    return;
  }

  const browser=await launchBrowser();
  const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'en-AU',timezoneId:'Australia/Perth'});
  let links=loadCachedPlayerLinks(canonicalPlayers);
  if(links.length>=850){
    console.log(`Using ${links.length} cached official player profile links.`);
  }else{
    const seed=await context.newPage();
    console.log('Loading official player directory to build player-link cache...');
    links=await collectOfficialPlayerLinks(seed,canonicalPlayers);
    await seed.close();
    console.log(`Found ${links.length} official player profile links (expected about 911).`);
    if(links.length<850){await browser.close();throw new Error(`Only ${links.length} player profile links were found. Existing data.js was left unchanged.`)}
    fs.writeFileSync(path.join(DIR,'player-links.json'),JSON.stringify(links,null,2));
    console.log('Saved player-links.json for faster future refreshes.');
  }
  const distinctOfficialIds=new Set(links.map(x=>hrefKey(x.href)).filter(Boolean));
  console.log(`Distinct official player identities: ${distinctOfficialIds.size}/${links.length}`);
  if(distinctOfficialIds.size<Math.min(850,Math.floor(links.length*0.90))){
    throw new Error(`Official player identity extraction is invalid: only ${distinctOfficialIds.size} distinct identities from ${links.length} profile links. Refusing to crawl/dedupe.`);
  }
  // Rewrite cached links with freshly calculated identities so an older cache containing
  // the tournament UUID as every player's ID repairs itself on a normal refresh.
  try{
    fs.writeFileSync(path.join(DIR,'player-links.json'),JSON.stringify(links.map(x=>({...x,officialPlayerId:hrefKey(x.href)})),null,2));
  }catch(e){console.warn('Could not rewrite player-links.json identities:',e.message)}
  for(const x of links)x.officialPlayerId=hrefKey(x.href);
  const lookup=buildPlayerLookup(canonicalPlayers,links);
  console.log(`Official TournamentSoftware IDs attached: ${canonicalPlayers.filter(p=>p.officialPlayerId).length}/${canonicalPlayers.length}`);
  const all=[]; let done=0, failed=0, candidateTotal=0;
  const queue=[...links];
  console.log(`Crawling player schedules with ${CONCURRENCY} browser workers...`);
  async function worker(workerNo){
    const page=await context.newPage(); const bucket=[];
    page.on('response',async r=>{const ct=(r.headers()['content-type']||'').toLowerCase();if(!(ct.includes('json')||/api|graphql|match|schedule|result/i.test(r.url())))return;try{const t=(await r.text()).trim();if(t.startsWith('{')||t.startsWith('['))bucket.push({url:r.url(),body:JSON.parse(t)})}catch{}});
    while(queue.length){const current=queue.shift();bucket.length=0;const r=await scrapeOneProfile(page,current,lookup,bucket);all.push(...r.matches);candidateTotal+=r.candidates;if(r.error)failed++;done++;if(done%25===0||done===links.length)console.log(`  ${done}/${links.length} players · ${all.length} raw match observations · ${failed} profile failures`)}
    await page.close();
  }
  await Promise.all(Array.from({length:CONCURRENCY},(_,i)=>worker(i+1)));
  await browser.close();

  const matches=mergeMatches(all);
  const glass=matches.filter(isGlass);
  console.log(`\nUnique matches: ${matches.length}`);
  console.log(`Glass Court matches: ${glass.length}`);
  console.log(`Candidate match containers inspected: ${candidateTotal}`);
  console.log(`Vic Park watchlist (${trackedNames.length}): ${trackedNames.join(', ')}`);
  for(const n of trackedNames)console.log(`  ${n}: ${matches.filter(m=>hasPlayer(m,n)).length} match(es)`);

  const audit={refreshedAt:new Date().toISOString(),officialPlayerLinks:links.length,officialPlayerIds:canonicalPlayers.filter(p=>p.officialPlayerId).length,rawMatchObservations:all.length,uniqueMatches:matches.length,glassCourtMatches:glass.length,profileFailures:failed,tracked:trackedNames.map(n=>({name:n,matches:matches.filter(m=>hasPlayer(m,n)).length}))};
  fs.writeFileSync(path.join(DIR,'refresh-audit.json'),JSON.stringify(audit,null,2));
  fs.writeFileSync(path.join(DIR,'refresh-matches.json'),JSON.stringify(matches,null,2));

  if(matches.length<MIN_MATCHES || all.length<MIN_RAW_OBSERVATIONS || failed>Math.max(10,Math.floor(links.length*0.03))){
    throw new Error(`Refresh coverage looks incomplete: ${matches.length} unique confirmed matches, ${all.length} raw observations, ${failed} profile failures. Existing data.js was left unchanged. See refresh-audit.json and refresh-matches.json.`);
  }

  if(FULL_REBUILD){
    console.log('Full rebuild: clearing cached SquashLevels identity mappings before re-resolution...');
    for(const p of canonicalPlayers){
      delete p.squashLevelsPlayerId;delete p.squashLevelsUrl;delete p.squashLevelsIdentityVerified;delete p.squashLevelsIdentityVerifiedAt;delete p.squashLevelsMatchedCountry;delete p.squashLevelsMatchedAge;delete p.squashLevelsSearchCheckedAt;delete p.squashLevelsProfileCheckedAt;delete p.squashLevelsWorldRank;delete p.squashLevelsLevel;delete p.squashLevelsLevelProvisional;
    }
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
  const next={...existing,refreshedAt:new Date().toISOString(),players:canonicalPlayers,matches};
  delete next.trackedNames;
  writeDataFiles(next);
  console.log('Data validation passed. Updated data.js plus summary-data.js, players-data.js, matches-data.js and vicpark-data.js. Design pages and vic-park-players.js were not changed.');
})().catch(err=>{console.error('\nRefresh failed:',err.message);process.exit(1)});
