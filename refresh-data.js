/*
  World Squash Masters 2026 TournamentSoftware refresher - v8
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
const ID = '1d88743a-54e2-4073-bd30-a4f443a442f0';
const ORIGIN = 'https://wsf.tournamentsoftware.com';
const PLAYERS_URL = `${ORIGIN}/tournament/${ID}/Players`;
const MIN_MATCHES = 350; // confirmed player-v-player matches; later-round TBD slots are not on player profiles
const MIN_RAW_OBSERVATIONS = 850;
const CONCURRENCY = Number(process.env.CRAWL_WORKERS || 3);
const NAV_TIMEOUT = 60000;
const PROFILE_WAIT = Number(process.env.PROFILE_WAIT_MS || 700);

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
    const path=u.pathname.toLowerCase().replace(/\/+$/,'');
    // TournamentSoftware sometimes adds/removes query parameters between directory and profile links.
    const ids=[...path.matchAll(/[0-9a-f]{8,}(?:-[0-9a-f-]{8,})?/gi)].map(m=>m[0]);
    const qp=[...u.searchParams.values()].filter(v=>/^[0-9a-f-]{8,}$/i.test(v));
    return (ids.concat(qp).pop()||path);
  }catch{return clean(href).toLowerCase()}
}

function loadExisting(){
  const ctx={window:{}}; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(DIR,'data.js'),'utf8'),ctx);
  return ctx.window.TOURNAMENT_DATA;
}

function loadTrackedNames(){
  const out=[]; const add=v=>{const n=clean(typeof v==='string'?v:v&&v.name);if(n&&!out.some(x=>sameName(x,n)))out.push(n)};
  const jp=path.join(DIR,'vic-park-players.json');
  if(fs.existsSync(jp)){try{const x=JSON.parse(fs.readFileSync(jp,'utf8'));(Array.isArray(x)?x:(x.players||x.trackedPlayers||[])).forEach(add)}catch(e){console.warn('Could not read vic-park-players.json:',e.message)}}
  const tp=path.join(DIR,'vic-park-players.txt');
  if(fs.existsSync(tp)) for(const line of fs.readFileSync(tp,'utf8').split(/\r?\n/)){const s=line.replace(/^\s*[-*]\s*/,'').replace(/\s*#.*$/,'').trim();if(s)add(s)}
  return out;
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

async function launchBrowser(){
  const requested=process.env.BROWSER_CHANNEL;
  const channels=requested?[requested]:['chrome','msedge',null];
  let last;
  for(const channel of channels){
    try{
      const opts={headless:process.env.HEADLESS==='1'}; if(channel)opts.channel=channel;
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
  const byHref=new Map();
  for(const x of raw){
    const p=canonicalByKey.get(nameKey(x.text)); if(!p)continue;
    let href=x.href.split('#')[0]; if(!href.startsWith('http'))continue;
    if(!byHref.has(href))byHref.set(href,{name:p.name,href,country:p.country,gender:p.gender,ageGroup:p.ageGroup});
  }
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
  const byHref=new Map(), byHrefKey=new Map();
  for(const x of officialLinks){
    const href=x.href.split('#')[0];
    byHref.set(href,x.name);
    byHrefKey.set(hrefKey(href),x.name);
  }
  return {byName,byHref,byHrefKey};
}

function candidateToMatch(c,current,lookup){
  const whole=clean(`${c.context||''} ${c.text||''}`);
  const f=deriveFields(whole,`${current.gender==='Women'?"Women's":"Men's"} ${current.ageGroup}+`);
  if(!f.date)return null;
  let opponent='';

  for(const l of c.playerLinks||[]){
    const href=(l.href||'').split('#')[0];
    const rawName=lookup.byHref.get(href)||lookup.byHrefKey.get(hrefKey(href))||lookup.byName.get(nameKey(l.text))?.name||clean(l.text);
    if(!rawName||sameName(rawName,current.name))continue;
    const canonical=lookup.byName.get(nameKey(rawName))?.name;
    if(canonical){opponent=canonical;break}
    const visible=clean(rawName).replace(/\s*\([^)]*\)\s*$/,'').trim();
    if(/[A-Za-zÀ-ÿ]/.test(visible)&&visible.length>=3){opponent=visible;break}
  }

  if(!opponent){
    const hay=' '+norm(whole).replace(/[^a-z0-9]+/g,' ')+' ';
    for(const p of lookup.byName.values()){
      if(sameName(p.name,current.name))continue;
      const k=norm(p.name).replace(/[^a-z0-9]+/g,' ').trim();
      if(k.length>4&&hay.includes(' '+k+' ')){opponent=p.name;break}
    }
  }

  if(!opponent&&/\bTBD\b|to be determined|winner of|loser of|bye/i.test(whole))opponent=/bye/i.test(whole)?'Bye':'TBD';

  if(!opponent){
    const source=String(c.source||'');
    const matchish=!!f.time && (/(match|fixture|schedule|result)/i.test(source)||!!f.event||!!f.round||!!f.venue||!!f.court||(c.playerLinks||[]).length>0);
    if(matchish)opponent='TBD';
  }
  if(!opponent)return null;
  return {...f,player1:current.name,player2:opponent,rawText:whole,sourcePlayer:current.name,sourceUrl:current.href};
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
    while(stack.length){const o=stack.pop();if(!o||typeof o!=='object')continue;if(Array.isArray(o)){stack.push(...o);continue}const txt=clean(JSON.stringify(o));const f=deriveFields(txt,`${current.gender==='Women'?'Women\'s':'Men\'s'} ${current.ageGroup}+`);if(f.date){const currentToken=hrefKey(current.href); const currentHit=(' '+norm(txt).replace(/[^a-z0-9]+/g,' ')+' ').includes(' '+norm(current.name).replace(/[^a-z0-9]+/g,' ').trim()+' ') || (currentToken&&txt.toLowerCase().includes(String(currentToken).toLowerCase()));if(currentHit){let opp='';const hay=' '+norm(txt).replace(/[^a-z0-9]+/g,' ')+' ';for(const p of lookup.byName.values()){if(sameName(p.name,current.name))continue;const k=norm(p.name).replace(/[^a-z0-9]+/g,' ').trim();if(k.length>4&&hay.includes(' '+k+' ')){opp=p.name;break}}if(opp)matches.push({...f,player1:current.name,player2:opp,rawText:txt,sourcePlayer:current.name,sourceUrl:current.href})}}for(const v of Object.values(o))if(v&&typeof v==='object')stack.push(v)}
  }
  return {matches,error:'',candidates:candidates.length};
}

function matchKey(m){
  const a=[nameKey(m.player1),nameKey(m.player2)].sort().join('~');
  // Event/court are deliberately not required for identity because one player's profile
  // may expose more metadata than the opponent's profile for the same match.
  return [m.date,clean(m.time).toLowerCase(),a].join('|');
}
function mergeMatches(list){
  const out=[];
  const mergeInto=(x,m)=>{
    for(const fld of ['event','round','venue','court','result','status','rawText']){
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

function isGlass(m){return /\bAGC\b|Karrinyup/i.test([m.court,m.venue,m.rawText].join(' '))}
function hasPlayer(m,n){return sameName(m.player1,n)||sameName(m.player2,n)}

(async()=>{
  const existing=loadExisting(); const canonicalPlayers=existing.players||[]; const trackedNames=loadTrackedNames();
  if(canonicalPlayers.length<900)throw new Error(`Canonical player snapshot has only ${canonicalPlayers.length} players; refusing refresh.`);
  const browser=await launchBrowser();
  const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'en-AU',timezoneId:'Australia/Perth'});
  const seed=await context.newPage();
  console.log('Loading official player directory...');
  const links=await collectOfficialPlayerLinks(seed,canonicalPlayers);
  await seed.close();
  console.log(`Found ${links.length} official player profile links (expected about 911).`);
  if(links.length<850){await browser.close();throw new Error(`Only ${links.length} player profile links were found. Existing data.js was left unchanged.`)}
  const lookup=buildPlayerLookup(canonicalPlayers,links);
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

  const audit={refreshedAt:new Date().toISOString(),officialPlayerLinks:links.length,rawMatchObservations:all.length,uniqueMatches:matches.length,glassCourtMatches:glass.length,profileFailures:failed,tracked:trackedNames.map(n=>({name:n,matches:matches.filter(m=>hasPlayer(m,n)).length}))};
  fs.writeFileSync(path.join(DIR,'refresh-audit.json'),JSON.stringify(audit,null,2));
  fs.writeFileSync(path.join(DIR,'refresh-matches.json'),JSON.stringify(matches,null,2));

  if(matches.length<MIN_MATCHES || all.length<MIN_RAW_OBSERVATIONS || failed>Math.max(10,Math.floor(links.length*0.03))){
    throw new Error(`Refresh coverage looks incomplete: ${matches.length} unique confirmed matches, ${all.length} raw observations, ${failed} profile failures. Existing data.js was left unchanged. See refresh-audit.json and refresh-matches.json.`);
  }

  const next={...existing,refreshedAt:new Date().toISOString(),players:canonicalPlayers,matches,trackedNames};
  fs.writeFileSync(path.join(DIR,'data.js'),`window.TOURNAMENT_DATA = ${JSON.stringify(next,null,2)};\n`);
  console.log('Data validation passed. Rebuilding self-contained pages...');
  require('./build-static.js');
})().catch(err=>{console.error('\nRefresh failed:',err.message);process.exit(1)});
