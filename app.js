
function removeTournamentSoftwareFooter(){
  document.querySelectorAll('footer').forEach(footer=>{
    const text=String(footer.textContent||'');
    const hasTsLink=[...footer.querySelectorAll('a[href]')].some(a=>
      /tournamentsoftware\.com/i.test(String(a.href||''))
    );
    if(hasTsLink||/TournamentSoftware/i.test(text)){
      footer.remove();
    }
  });
}
if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded',removeTournamentSoftwareFooter,{once:true});
}else{
  removeTournamentSoftwareFooter();
}

const data = {
  ...(window.TOURNAMENT_SUMMARY||{}),
  players:[],
  matches:[]
};
const loadedScripts=new Map();
function loadScriptOnce(src){
  if(loadedScripts.has(src))return loadedScripts.get(src);
  const promise=new Promise((resolve,reject)=>{
    const el=document.createElement('script');el.src=src;el.defer=true;
    el.onload=()=>resolve();el.onerror=()=>reject(new Error(`Could not load ${src}`));
    document.head.appendChild(el);
  });
  loadedScripts.set(src,promise);return promise;
}
async function ensureLegacyData(){
  if(window.TOURNAMENT_DATA)return window.TOURNAMENT_DATA;
  await loadScriptOnce('data.js');
  return window.TOURNAMENT_DATA||null;
}
let playersReady=false,matchesReady=false,vicParkDataReady=false;
let favoriteMatchIndex=null;







function rebuildFavoriteMatchIndex(){
  const index=new Map();
  for(const m of (data.matches||[])){
    const keys=[nameKey(m.player1||''),nameKey(m.player2||'')].filter(Boolean);
    for(const key of new Set(keys)){
      if(!index.has(key))index.set(key,[]);
      index.get(key).push(m);
    }
  }
  favoriteMatchIndex=index;
}

let vicParkPlayers=[],vicParkMatches=[];
async function ensurePlayersData(){
  if(playersReady)return;
  try{
    await loadScriptOnce('players-data.js');
    if(!Array.isArray(window.TOURNAMENT_PLAYERS))throw new Error('players-data.js did not define TOURNAMENT_PLAYERS');
    data.players=window.TOURNAMENT_PLAYERS;
  }catch(e){
    const legacy=await ensureLegacyData();
    data.players=legacy?.players||[];
  }
  rebuildPlayerNeedles();
  playerIdentityIndexSourceCount=-1;
  cachedPlayerLevelRank=null;
  cachedPlayerLevelRankCount=-1;
  playersReady=true;
}

function normalizeSelfMatchAsBye(m){
  if(!m||!sameName(m.player1,m.player2))return m;
  const p1Id=String(m.player1Id||''),p2Id=String(m.player2Id||'');
  if(p1Id&&p2Id&&p1Id!==p2Id)return m;
  const sameNamePlayers=(data.players||[]).filter(p=>sameName(p.name,m.player1));
  if((p1Id&&p2Id&&p1Id===p2Id)||sameNamePlayers.length<=1){
    return {...m,player2:'Bye',player2Id:'',status:String(m.status||'').toLowerCase()==='completed'?m.status:'bye'};
  }
  return m;
}

async function ensureMatchesData(){
  if(matchesReady)return;
  await ensurePlayersData();
  try{
    await loadScriptOnce('matches-data.js');
    if(!Array.isArray(window.TOURNAMENT_MATCHES))throw new Error('matches-data.js did not define TOURNAMENT_MATCHES');
    data.matches=window.TOURNAMENT_MATCHES;
  }catch(e){
    const legacy=await ensureLegacyData();
    data.matches=legacy?.matches||[];
  }
  data.matches=(data.matches||[]).map(normaliseMatch).map(normalizeSelfMatchAsBye);
  data.baseMatches=data.matches.map(m=>({...m}));
  rebuildFavoriteMatchIndex();
  matchesReady=true;
}

async function ensureVicParkData(){
  if(vicParkDataReady)return;

  // Prefer the small Vic Park file for speed, but never allow a stale/empty
  // compact file to hide fixtures that exist in the authoritative match data.
  let pack=null;
  try{
    await loadScriptOnce('vicpark-data.js');
    pack=window.VIC_PARK_DATA;
  }catch{}

  if(pack&&Array.isArray(pack.players)&&Array.isArray(pack.matches)&&pack.matches.length){
    vicParkPlayers=pack.players;
    playerIdentityIndexVicCount=-1;
    vicParkMatches=pack.matches.map(normaliseMatch).map(normalizeSelfMatchAsBye);
    window.__vicParkBaseMatches=vicParkMatches.map(m=>({...m}));
  }else{
    await ensureMatchesData();
    vicParkPlayers=data.players;

    const trackedNames=VIC_PARK_PLAYERS;
    const trackedPlayers=(data.players||[]).filter(p=>trackedNames.some(n=>sameName(p.name,n)));
    const trackedIds=new Set(trackedPlayers.map(p=>String(p.officialPlayerId||'')).filter(Boolean));

    vicParkMatches=(data.matches||[]).filter(m=>
      trackedNames.some(n=>sameName(m.player1,n)||sameName(m.player2,n)) ||
      (m.player1Id&&trackedIds.has(String(m.player1Id))) ||
      (m.player2Id&&trackedIds.has(String(m.player2Id)))
    );

    window.__vicParkBaseMatches=vicParkMatches.map(m=>({...m}));
  }

  vicParkDataReady=true;
}

function renderHeaderRefresh(){
  const el=document.querySelector('#headerRefresh');
  if(!el)return;
  const official='https://wsf.tournamentsoftware.com/tournament/1d88743a-54e2-4073-bd30-a4f443a442f0/Matches';
  let when='Not yet refreshed';
  if(data?.refreshedAt){
    const d=new Date(data.refreshedAt);
    if(!Number.isNaN(d.getTime())) when=d.toLocaleString('en-AU',{day:'numeric',month:'short',year:'numeric',hour:'numeric',minute:'2-digit',hour12:true,timeZone:'Australia/Perth'});
  }
  el.innerHTML=`Last refresh: ${when} · from <a class="header-meta-link" href="${official}" target="_blank" rel="noopener noreferrer">Official Tournament Website</a>`;
}
const VIC_PARK_PLAYERS = Array.isArray(window.VIC_PARK_PLAYERS) ? window.VIC_PARK_PLAYERS : [];
function canonicalDate(v){
  if(!v)return '';
  const s=String(v).trim();
  let m=s.match(/^(\d{4})-(\d{2})-(\d{2})/); if(m)return `${m[1]}-${m[2]}-${m[3]}`;
  m=s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/); if(m)return `${m[3]}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
  const d=new Date(s); if(!Number.isNaN(d.getTime())){const y=d.getFullYear(),mo=String(d.getMonth()+1).padStart(2,'0'),da=String(d.getDate()).padStart(2,'0');return `${y}-${mo}-${da}`;}
  return s;
}

const SQUASH_SCORES_LIVE_URL='https://squashscores.com/overview.html?categoryId=19';
const SQUASH_SCORES_API_URL='https://squashscores.com/api/overview/public/?categoryId=19';
const SQUASH_SCORES_POLL_MS=5000;

function ssNorm(s){
  return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[’‘]/g,"'").toLowerCase().replace(/[^a-z0-9']+/g,' ').trim();
}
function ssDate(text){
  const s=String(text||'');
  let m=s.match(/\b(\d{1,2})\/(\d{1,2})\/(2026)\b/);
  if(m)return `${m[3]}-${String(+m[2]).padStart(2,'0')}-${String(+m[1]).padStart(2,'0')}`;
  m=s.match(/\b(2026)-(\d{1,2})-(\d{1,2})\b/);
  return m?`${m[1]}-${String(+m[2]).padStart(2,'0')}-${String(+m[3]).padStart(2,'0')}`:'';
}
function ssTime(text){
  const m=String(text||'').match(/\b(\d{1,2}):([0-5]\d)\b/);
  return m?`${String(+m[1]).padStart(2,'0')}:${m[2]}`:'';
}
function ssScorePairs(text){
  const s=String(text||'').replace(/[–—]/g,'-');
  const run=s.match(/\b\d{1,2}\s*-\s*\d{1,2}(?:(?:\s*,\s*|\s+)\d{1,2}\s*-\s*\d{1,2}){2,4}\b/);
  if(!run)return '';
  return [...run[0].matchAll(/(\d{1,2})\s*-\s*(\d{1,2})/g)]
    .map(x=>`${+x[1]}-${+x[2]}`).join(', ');
}
function ssValidGame(a,b){
  if(!Number.isInteger(a)||!Number.isInteger(b)||a===b||a<0||b<0||a>30||b>30)return false;
  const hi=Math.max(a,b),lo=Math.min(a,b);
  return hi>=11&&(hi===11?lo<=9:hi-lo===2);
}
function ssKnownNames(text,players){
  const hay=` ${ssNorm(text)} `;
  const found=[];
  for(const p of players||[]){
    const k=ssNorm(p?.name);
    if(k.length>=5&&hay.includes(` ${k} `)){
      found.push(p.name);
      if(found.length===3)break;
    }
  }
  return found;
}
function ssSeparateScore(container,p1,p2){
  const rows=[...container.querySelectorAll('tr,[role="row"],li,[class*="row"],[class*="player"]')];
  const getRow=n=>rows.find(r=>` ${ssNorm(r.textContent)} `.includes(` ${ssNorm(n)} `));
  const a=getRow(p1),b=getRow(p2);
  if(!a||!b||a===b)return '';
  const values=row=>{
    const raw=String(row.textContent||'').replace(/\s+/g,' ').trim();
    const vals=(raw.match(/(?:^|\s)\d{1,2}(?=\s|$)/g)||[]).map(x=>+x.trim()).filter(x=>x<=30);
    for(let n=5;n>=3;n--)if(vals.length>=n)return vals.slice(-n);
    return [];
  };
  const av=values(a),bv=values(b);
  if(av.length<3||av.length!==bv.length||!av.every((x,i)=>ssValidGame(x,bv[i])))return '';
  return av.map((x,i)=>`${x}-${bv[i]}`).join(', ');
}
function ssVenue(text){
  const s=String(text||'').replace(/\s+/g,' ').trim();
  for(const v of ['Squashworld Mirrabooka','Belmont Saints Squash Centre','Karrinyup Shopping Centre']){
    if(s.toLowerCase().includes(v.toLowerCase()))return v;
  }
  const m=s.match(/\b(?:Mirrabooka|Belmont|Karrinyup)\b[^|]{0,80}/i);
  return m?m[0].trim():'';
}

function parseSquashScoresApi(payload,players){
  const rows=[];
  const locations=Array.isArray(payload?.locations)?payload.locations:[];
  const playerList=players||[];

  const canonicalPlayerName=raw=>{
    const wanted=ssNorm(raw);
    if(!wanted)return String(raw||'').trim();
    const p=playerList.find(x=>ssNorm(x?.name)===wanted);
    return p?.name||String(raw||'').trim();
  };

  const gamesScore=(match,p1Side=true)=>{
    const games=Array.isArray(match?.games)?match.games:[];
    const pairs=[];
    for(const g of games){
      const a=Number(g?.player1Score);
      const b=Number(g?.player2Score);
      if(!Number.isFinite(a)||!Number.isFinite(b))continue;
      if(a===0&&b===0)continue;
      pairs.push(p1Side?`${a}-${b}`:`${b}-${a}`);
    }
    return pairs.join(', ');
  };

  const gamesWon=match=>{
    const p1=Number(match?.player1GamesWon);
    const p2=Number(match?.player2GamesWon);
    if(Number.isFinite(p1)&&Number.isFinite(p2))return [p1,p2];
    let a=0,b=0;
    for(const g of Array.isArray(match?.games)?match.games:[]){
      const x=Number(g?.player1Score),y=Number(g?.player2Score);
      if(!Number.isFinite(x)||!Number.isFinite(y)||x===y)continue;
      if(x>y)a++; else b++;
    }
    return [a,b];
  };

  for(const location of locations){
    for(const m of Array.isArray(location?.matches)?location.matches:[]){
      const player1=canonicalPlayerName(m?.player1Name);
      const player2=canonicalPlayerName(m?.player2Name);
      if(!player1||!player2)continue;

      const rawDate=String(m?.matchDate||m?.date||'');
      let date=canonicalDate(rawDate);
      if(!date){
        const dm=rawDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if(dm)date=`${dm[1]}-${dm[2]}-${dm[3]}`;
      }

      let time='';
      const description=String(m?.description||'').replace(/\s+/g,' ').trim();
      const tm=description.match(/\b(\d{1,2}):([0-5]\d)\b/);
      if(tm)time=`${String(+tm[1]).padStart(2,'0')}:${tm[2]}`;
      if(!time){
        const dt=rawDate.match(/[T\s](\d{1,2}):([0-5]\d)/);
        if(dt)time=`${String(+dt[1]).padStart(2,'0')}:${dt[2]}`;
      }

      const [p1Won,p2Won]=gamesWon(m);
      const score=gamesScore(m,true);
      const completed=p1Won>=3||p2Won>=3;
      const hasStarted=score.length>0||p1Won>0||p2Won>0;

      let status='scheduled';
      if(completed)status='completed';
      else if(hasStarted)status='live';

      rows.push({
        date,
        time,
        player1,
        player2,
        result:score,
        status,
        venue:String(location?.name||location?.locationName||'').trim(),
        court:String(m?.courtName||m?.court||'').trim(),
        event:String(m?.categoryName||m?.category||'').trim(),
        round:description,
        liveSource:'SquashScores',
        squashScoresMatchId:m?.id||m?.matchId||null
      });
    }
  }

  console.log(`SquashScores API: ${locations.length} location(s) · ${rows.length} match(es)`);
  const rogerRows=rows.filter(m=>ssNorm(m.player1)==='roger schmidlin'||ssNorm(m.player2)==='roger schmidlin');
  if(rogerRows.length)console.log('SquashScores Roger rows:',rogerRows);

  return rows;
}

function parseSquashScoresHtml(html,players){
  const doc=new DOMParser().parseFromString(html,'text/html');
  const found=new Map();
  const allPlayers=(players||[]).filter(p=>p?.name&&ssNorm(p.name).length>=5);

  function scoreFromTextAroundNames(text,p1,p2){
    const clean=String(text||'').replace(/\s+/g,' ').trim();
    const low=clean.toLowerCase();
    const i1=low.indexOf(String(p1).toLowerCase());
    const i2=low.indexOf(String(p2).toLowerCase());
    if(i1<0||i2<0)return '';

    const first=i1<i2?{name:p1,pos:i1}:{name:p2,pos:i2};
    const second=i1<i2?{name:p2,pos:i2}:{name:p1,pos:i1};
    const firstStart=first.pos+first.name.length;
    const secondStart=second.pos+second.name.length;

    const between=clean.slice(firstStart,second.pos);
    const after=clean.slice(secondStart);

    const getNums=s=>(String(s).match(/(?:^|\s)(\d{1,2})(?=\s|$)/g)||[])
      .map(x=>+x.trim()).filter(x=>x>=0&&x<=30);

    // Try the straightforward rendered-text order first.
    let a=getNums(between).slice(0,5);
    let b=getNums(after).slice(0,5);

    // Ignore obvious non-score values like age-group 60/65 etc.
    a=a.filter(x=>x<=30); b=b.filter(x=>x<=30);

    const n=Math.min(a.length,b.length,5);
    if(n>=3){
      a=a.slice(0,n); b=b.slice(0,n);
      if(a.every((x,i)=>ssValidGame(x,b[i]))){
        const pair=a.map((x,i)=>`${x}-${b[i]}`).join(', ');
        return first.name===p1?pair:b.map((x,i)=>`${x}-${a[i]}`).join(', ');
      }
    }
    return '';
  }

  function addCandidate(el){
    const text=String(el.textContent||'').replace(/\s+/g,' ').trim();
    if(text.length<20||text.length>2600)return;

    const date=ssDate(text),time=ssTime(text);
    if(!date||!time)return;

    const names=ssKnownNames(text,allPlayers);
    if(names.length<2)return;

    // Prefer the smallest DOM element containing this match. If a child already
    // contains the same two players/date/time, the parent is too broad.
    for(const child of el.children||[]){
      const ct=String(child.textContent||'').replace(/\s+/g,' ').trim();
      if(!ct||ct===text)continue;
      if(ssDate(ct)===date&&ssTime(ct)===time){
        const cn=ssKnownNames(ct,allPlayers);
        if(cn.length>=2)return;
      }
    }

    const p1=names[0],p2=names[1];
    let result=ssScorePairs(text);
    if(!result)result=ssSeparateScore(el,p1,p2);
    if(!result)result=scoreFromTextAroundNames(text,p1,p2);

    const lower=text.toLowerCase();
    const completed=!!result||/\b(?:finished|completed|won|lost)\b/i.test(text);
    const live=/\b(?:live|playing|in progress|on court)\b/i.test(text);

    const key=`${date}|${[ssNorm(p1),ssNorm(p2)].sort().join('|')}`;
    const row={
      date,time,player1:p1,player2:p2,result,
      status:completed?'completed':(live?'live':'scheduled'),
      venue:ssVenue(text),liveSource:'SquashScores',
      liveRawText:text
    };

    const prev=found.get(key);
    const richness=x=>(x?.result?1000+String(x.result).length:0)+String(x?.liveRawText||'').length;
    if(!prev||richness(row)>richness(prev))found.set(key,row);
  }

  // The SquashScores overview is small. Scan all structural elements rather than
  // depending on site-specific CSS class names.
  for(const el of doc.querySelectorAll('tr,tbody,table,article,li,section,div'))addCandidate(el);

  // Final safety pass over BODY: useful if their page has a very flat structure.
  addCandidate(doc.body);

  const rows=[...found.values()];

  // Visible diagnostics for local testing.
  const rogerText=String(doc.body?.textContent||'').toLowerCase().includes('roger schmidlin');
  console.log(`SquashScores parser: HTML ${html.length} chars · ${rows.length} match(es) parsed · Roger present: ${rogerText?'YES':'NO'}`);
  if(rogerText){
    const rogerRows=rows.filter(m=>ssNorm(m.player1).includes('roger schmidlin')||ssNorm(m.player2).includes('roger schmidlin'));
    console.log('SquashScores Roger rows:',rogerRows);
    if(!rogerRows.length){
      const body=String(doc.body?.textContent||'').replace(/\s+/g,' ').trim();
      const ix=body.toLowerCase().indexOf('roger schmidlin');
      if(ix>=0)console.log('SquashScores Roger source snippet:',body.slice(Math.max(0,ix-350),ix+700));
    }
  }

  return rows;
}
function orientLiveResultToExisting(existing,live){
  const result=String(live?.result||'').trim();
  if(!result)return '';

  const reversed=
    ssNorm(existing?.player1)===ssNorm(live?.player2) &&
    ssNorm(existing?.player2)===ssNorm(live?.player1);

  if(!reversed)return result;

  return [...result.matchAll(/(\d{1,2})\s*[-–—]\s*(\d{1,2})/g)]
    .map(x=>`${Number(x[2])}-${Number(x[1])}`)
    .join(', ');
}

function ssOverlay(base,live){
  const out=(base||[]).map(m=>({...m}));
  const pairKey=m=>[ssNorm(m.player1),ssNorm(m.player2)].sort().join('|');
  const dateKey=m=>canonicalDate(m.date||'');
  const timeKey=m=>displayTime24(m.time||'');
  const today=perthTodayIso();

  for(const l of live||[]){
    if(String(l.status||'').toLowerCase()!=='live')continue;
    if(dateKey(l)!==today)continue;

    const candidates=out.filter(m=>
      dateKey(m)===today &&
      timeKey(m)===timeKey(l) &&
      pairKey(m)===pairKey(l)
    );

    if(candidates.length!==1)continue;

    const existing=candidates[0];
    if(l.result)existing.result=orientLiveResultToExisting(existing,l);
    existing.status='live';
    existing.liveSource='SquashScores';
  }

  return out;
}
async function fetchSquashScoresApi(){
  const sep=SQUASH_SCORES_API_URL.includes('?')?'&':'?';
  const r=await fetch(`${SQUASH_SCORES_API_URL}${sep}_=${Date.now()}`,{cache:'no-store',mode:'cors'});
  if(!r.ok)throw new Error(`SquashScores API HTTP ${r.status}`);
  return r.json();
}

const flatText=v=>{try{return typeof v==='string'?v:JSON.stringify(v)}catch{return String(v||'')}};
const basicNorm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[’‘]/g,"'").toLowerCase().replace(/[^a-z0-9']+/g,' ').trim();
let playerNeedles=[];
function rebuildPlayerNeedles(){playerNeedles=(data.players||[]).map(p=>({p,key:basicNorm(p.name)})).sort((a,b)=>b.key.length-a.key.length);}
function namesFromRecord(m){
  const text=' '+basicNorm(flatText(m))+' ';
  const found=[];
  for(const x of playerNeedles){if(x.key.length>4 && text.includes(' '+x.key+' ')){found.push(x.p.name);if(found.length===2)break;}}
  return found;
}
function canonicalVenue(v){
  const s=String(v||'').replace(/\s+/g,' ').trim();
  if(/\bKarrinyup\b/i.test(s))return 'Karrinyup Shopping Centre';
  if(/\bMirrabooka\b/i.test(s))return 'Squashworld Mirrabooka';
  if(/\bBelmont\b/i.test(s))return 'Belmont Saints Squash Centre';
  return '';
}
function deriveVenueCourt(m,raw){
  let venue=m.venue||m.venueName||m.location||m.locationName||m.site||m.facility||'';
  let court=m.court||m.courtName||m.resource||m.resourceName||m.field||m.fieldName||'';
  if(typeof venue==='object')venue=venue.name||venue.title||venue.label||'';
  if(typeof court==='object')court=court.name||court.title||court.label||'';

  venue=canonicalVenue(venue)||canonicalVenue(raw);

  if(typeof court!=='string')court='';
  court=String(court||'').replace(/\s+/g,' ').trim();
  if(court.length>40)court='';

  if(!court){
    const cm=String(raw||'').match(/\b(AGC(?:\s*\d+)?|SC\s*\d+|Court\s*\d+)\b/i);
    if(cm)court=cm[1].replace(/\s+/g,' ').trim();
  }

  return {venue,court};
}
function cleanMatchMeta(v){
  const s=String(v||'').replace(/\s+/g,' ').trim();
  if(!s)return '';
  if(s.length>70)return '';
  if((s.match(/\|/g)||[]).length>1)return '';
  if((s.match(/\b[A-Z][A-Za-z'-]+\s+[A-Z][A-Za-z'-]+\b/g)||[]).length>2)return '';
  return s;
}
function normaliseMatch(m){
  const raw=flatText(m.rawText||m.text||m.description||m);
  let p1=m.player1||m.playerOne||m.homePlayer||m.home||m.participant1||m.team1||m.entry1||'';
  let p2=m.player2||m.playerTwo||m.awayPlayer||m.away||m.participant2||m.team2||m.entry2||'';
  const getName=v=>typeof v==='object'&&v?(v.name||v.displayName||v.fullName||v.title||v.label||''):String(v||'');
  p1=getName(p1);p2=getName(p2);
  if(!p1||!p2){const f=namesFromRecord(m);if(!p1)p1=f[0]||'';if(!p2)p2=f.find(n=>basicNorm(n)!==basicNorm(p1))||f[1]||'';}
  const vc=deriveVenueCourt(m,raw);
  let date=canonicalDate(m.date||m.matchDate||m.startDate||m.start||m.datetime||m.dateTime||m.scheduledDate||'');
  let time=m.time||m.matchTime||m.startTime||m.scheduledTime||'';
  if(!time){const tm=raw.match(/\b(\d{1,2}:[0-5]\d\s*(?:am|pm)?)\b/i);if(tm)time=tm[1];}
  return {...m,date,time,event:cleanMatchMeta(m.event||m.eventName||m.draw||m.category||m.disciplineName||''),round:cleanMatchMeta(m.round||m.roundName||''),player1:p1,player2:p2,venue:vc.venue,court:vc.court,rawText:''};
}
data.matches=(data.matches||[]).map(normaliseMatch);
const qs=s=>document.querySelector(s), qsa=s=>[...document.querySelectorAll(s)];
const norm=s=>(s||'').trim().toLowerCase();
const nameKey=s=>{
  let v=String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[’‘]/g,"'").trim();
  v=v.replace(/\[[^\]]*\]/g,' ').replace(/\((?:[A-Z]{2,3}|\d+)\)/g,' ').replace(/\b(?:AUS|ENG|SCO|WAL|SUI|NZL|USA|CAN|FRA|GER|DEU|IRL|RSA|IND|JPN|MAS|SGP|HKG)\b/gi,' ');
  if(v.includes(',')){ const parts=v.split(',').map(x=>x.trim()).filter(Boolean); if(parts.length===2) v=parts[1]+' '+parts[0]; }
  return v.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/).filter(Boolean).sort().join(' ');
};
const sameName=(a,b)=>!!a&&!!b&&(norm(a)===norm(b)||nameKey(a)===nameKey(b));
let playerIdentityIndexSourceCount=-1;
let playerIdentityIndexVicCount=-1;
let playerIdentityById=new Map();
let playerIdentityByNameKey=new Map();

function ensurePlayerIdentityIndexes(){
  const dataCount=(data.players||[]).length;
  const vicCount=(vicParkPlayers||[]).length;

  if(
    playerIdentityIndexSourceCount===dataCount &&
    playerIdentityIndexVicCount===vicCount
  )return;

  playerIdentityById=new Map();
  playerIdentityByNameKey=new Map();

  const all=[...(data.players||[]),...(vicParkPlayers||[])];
  const seenObjects=new Set();

  for(const p of all){
    if(!p||seenObjects.has(p))continue;
    seenObjects.add(p);

    const id=String(p.officialPlayerId||'');
    if(id&&!playerIdentityById.has(id))playerIdentityById.set(id,p);

    const k=nameKey(p.name);
    if(!k)continue;
    if(!playerIdentityByNameKey.has(k))playerIdentityByNameKey.set(k,[]);

    const bucket=playerIdentityByNameKey.get(k);
    const identityKey=id||`${k}|${p.ageGroup||''}|${p.gender||''}`;
    if(!bucket.some(x=>(String(x.officialPlayerId||'')||`${nameKey(x.name)}|${x.ageGroup||''}|${x.gender||''}`)===identityKey)){
      bucket.push(p);
    }
  }

  playerIdentityIndexSourceCount=dataCount;
  playerIdentityIndexVicCount=vicCount;
}

function playersForName(name){
  ensurePlayerIdentityIndexes();
  return playerIdentityByNameKey.get(nameKey(name))||[];
}

const playerByName=name=>{
  const matches=playersForName(name);
  return matches.length===1?matches[0]:null;
};

const playerById=id=>{
  if(!id)return null;
  ensurePlayerIdentityIndexes();
  return playerIdentityById.get(String(id))||null;
};

function matchContextAgeGender(m){
  const raw=String(m?.event||m?.eventName||m?.draw||m?.category||'');
  const age=(raw.match(/\b(35|40|45|50|55|60|65|70|75|80|85)\+?\b/)||[])[1]||'';
  const gender=/women/i.test(raw)?'women':(/\bmen/i.test(raw)?'men':'');
  return {age,gender};
}

function playerGenderKey(v){
  const s=String(v||'').toLowerCase();
  if(/female|women|woman|\bf\b/.test(s))return 'women';
  if(/male|men|man|\bm\b/.test(s))return 'men';
  return '';
}

function playerForMatchSide(m,side){
  const name=side===2?m?.player2:m?.player1;
  const id=side===2?m?.player2Id:m?.player1Id;

  const byId=playerById(id);
  if(byId&&sameName(byId.name,name))return byId;

  const candidates=playersForName(name);
  if(candidates.length===1)return candidates[0];

  if(candidates.length>1){
    const ctx=matchContextAgeGender(m);
    let pool=candidates;

    if(ctx.age){
      const ageMatches=pool.filter(p=>String(p.ageGroup??'').match(/\d{2}/)?.[0]===ctx.age);
      if(ageMatches.length)pool=ageMatches;
    }

    if(ctx.gender){
      const genderMatches=pool.filter(p=>playerGenderKey(p.gender)===ctx.gender);
      if(genderMatches.length)pool=genderMatches;
    }

    if(pool.length===1)return pool[0];
  }

  // Only use name-only fallback when the displayed name is unique.
  return candidates.length===1?candidates[0]:null;
}

const playerPageUrl=(name,id='')=>{
  const byId=playerById(id);
  const sameNamePlayers=playersForName(name);

  let p=null;
  if(byId&&sameName(byId.name,name)){
    p=byId;
  }else if(sameNamePlayers.length===1){
    p=sameNamePlayers[0];
  }

  const q=new URLSearchParams();
  if(p?.officialPlayerId)q.set('id',p.officialPlayerId);
  q.set('name',p?.name||name||'');
  return `player.html?${q.toString()}`;
};
const flagUrl=p=>p?.flagCode?`https://flagcdn.com/w80/${p.flagCode}.png`:'';
const flagImg=(p,cls='inline-flag')=>p?.flagCode?`<img class="${cls}" src="${flagUrl(p)}" alt="${p.country||''} flag">`:'<span class="flag-fallback">🌐</span>';
const flagForName=name=>flagImg(playerByName(name));
const squashMetric=v=>{const n=Number(String(v??'').replace(/,/g,''));return Number.isFinite(n)&&n>0?n.toLocaleString('en-AU'):esc(v)};
const rankBadge=p=>{
  if(!p)return '';
  const raw=p.squashLevelsWorldRank;
  if(raw===null||raw===undefined||String(raw).trim()==='')return '';
  const text=/^tbd$/i.test(String(raw).trim())?'TBD':squashMetric(raw);
  return `<span class="world-rank" title="SquashLevels world ranking">World ${text}</span>`;
};
const levelBadge=p=>{
  if(!p||!p.squashLevelsLevel)return '';
  return `<span class="squash-level" title="SquashLevels level">Level ${squashMetric(p.squashLevelsLevel)}${p.squashLevelsLevelProvisional?' (P)':''}</span>`;
};
const squashBadges=p=>`<span class="squash-metrics">${rankBadge(p)}${levelBadge(p)}</span>`;
const playerNameStack=(p,name,tracked=false)=>`<span class="player-name-stack"><b class="${tracked?'vic-tracked-name':''}">${esc(name||'TBD')}</b>${squashBadges(p)}</span>`;
const isTbdName=name=>/^TBD$/i.test(String(name||'').trim());
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const fmtDate=iso=>{const d=new Date(iso+'T12:00:00');return{day:d.toLocaleDateString('en-AU',{weekday:'short'}),date:d.toLocaleDateString('en-AU',{day:'numeric',month:'short'}),long:d.toLocaleDateString('en-AU',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}};
const tournamentDates=()=>{const a=[], d=new Date(data.tournament.startDate+'T12:00:00'), end=new Date(data.tournament.endDate+'T12:00:00');for(;d<=end;d.setDate(d.getDate()+1))a.push(d.toISOString().slice(0,10));return a;};
const isGlass=m=>/Karrinyup|\bAGC\b/i.test([m.venue,m.court].join(' '));
const LIVE_MATCH_WINDOW_MINUTES=90;

function perthNowParts(){
  const parts=new Intl.DateTimeFormat('en-CA',{
    timeZone:'Australia/Perth',year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',hourCycle:'h23'
  }).formatToParts(new Date());
  const get=t=>Number(parts.find(p=>p.type===t)?.value||0);
  return {year:get('year'),month:get('month'),day:get('day'),hour:get('hour'),minute:get('minute')};
}

function matchLocalMinuteValue(m){
  const d=canonicalDate(m?.date||'');
  const dm=d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const tm=String(displayTime24(m?.time||'')).match(/^(\d{2}):(\d{2})$/);
  if(!dm||!tm)return null;
  return Math.floor(Date.UTC(+dm[1],+dm[2]-1,+dm[3],+tm[1],+tm[2])/60000);
}

function perthNowMinuteValue(){
  const n=perthNowParts();
  return Math.floor(Date.UTC(n.year,n.month-1,n.day,n.hour,n.minute)/60000);
}

function isMatchCurrent(m){
  const status=String(m?.status||'').toLowerCase();
  if(status==='live')return true;
  if(status==='completed'||status==='played'||m?.result||m?.winner)return false;
  const start=matchLocalMinuteValue(m);
  if(start===null)return false;
  const now=perthNowMinuteValue();
  return now>=start&&now<start+LIVE_MATCH_WINDOW_MINUTES;
}


function canShowPublishedResult(m){
  const d=canonicalDate(m?.date||'');
  const today=(()=>{
    const p=new Intl.DateTimeFormat('en-CA',{
      timeZone:'Australia/Perth',year:'numeric',month:'2-digit',day:'2-digit'
    }).formatToParts(new Date());
    const get=t=>p.find(x=>x.type===t)?.value||'';
    return `${get('year')}-${get('month')}-${get('day')}`;
  })();

  const status=String(m?.status||'').toLowerCase();
  if(status==='live')return true;
  if(d&&d>today)return false;

  return status==='completed'||status==='played'||!!m?.result||!!m?.winner;
}

const isPast=m=>{
  const status=String(m?.status||'').toLowerCase();
  if(status==='completed'||status==='played')return true;
  if(status!=='live'&&(!!m?.result||!!m?.winner))return true;
  const start=matchLocalMinuteValue(m);
  return start!==null&&perthNowMinuteValue()>=start+LIVE_MATCH_WINDOW_MINUTES;
};
const matchHas=(m,name)=>{const p=playerByName(name);return !!(p?.officialPlayerId&&(String(m.player1Id||'')===String(p.officialPlayerId)||String(m.player2Id||'')===String(p.officialPlayerId)))||sameName(m.player1,name)||sameName(m.player2,name);};
const opponentFor=(m,name)=>sameName(m.player1,name)?m.player2:m.player1;
const FAVORITES_STORAGE_KEY='wsm2026FavouritePlayers';
let favoriteNamesCache=null;
function getFavoriteNames(){
  if(favoriteNamesCache)return favoriteNamesCache.slice();
  try{
    const r=JSON.parse(localStorage.getItem(FAVORITES_STORAGE_KEY)||'[]');
    favoriteNamesCache=Array.isArray(r)
      ? r.filter(x=>typeof x==='string'&&x.trim()).map(x=>x.trim())
      : [];
  }catch{
    favoriteNamesCache=[];
  }
  return favoriteNamesCache.slice();
}
function saveFavoriteNames(names){
  const out=[];
  for(const n of names||[])if(n&&!out.some(x=>sameName(x,n)))out.push(n);
  favoriteNamesCache=out.slice();
  try{localStorage.setItem(FAVORITES_STORAGE_KEY,JSON.stringify(out))}catch{}
  return out;
}
function isFavoritePlayer(n){
  return getFavoriteNames().some(x=>sameName(x,n));
}
function favoriteButton(n,cls=''){const on=isFavoritePlayer(n);return `<button type="button" class="favorite-player-btn ${on?'is-favorite':''} ${cls}" data-favourite-player="${esc(n)}" aria-pressed="${on?'true':'false'}" title="${on?'Remove from':'Add to'} Fav Players"><span aria-hidden="true">${on?'★':'☆'}</span><span class="favorite-player-btn-text">${on?'Faved':'Fav'}</span></button>`}
function toggleFavoritePlayer(n){const r=getFavoriteNames(),i=r.findIndex(x=>sameName(x,n));if(i>=0)r.splice(i,1);else r.push(n);saveFavoriteNames(r);return i<0}
function refreshFavoriteButtons(){qsa('[data-favourite-player]').forEach(btn=>{const on=isFavoritePlayer(btn.dataset.favouritePlayer||'');btn.classList.toggle('is-favorite',on);btn.setAttribute('aria-pressed',on?'true':'false');btn.title=`${on?'Remove from':'Add to'} Fav Players`;const s=btn.querySelector('span[aria-hidden="true"]');if(s)s.textContent=on?'★':'☆';const t=btn.querySelector('.favorite-player-btn-text');if(t)t.textContent=on?'Faved':'Fav';})}

let playersRendered=false,glassReady=false,vicParkReady=false,favoritesReady=false;
function showLoading(id){
  const target=id==='players'?qs('#playerGrid'):id==='glass'?qs('#glassMatches'):id==='vicpark'?qs('#trackedPlayers'):id==='favorites'?qs('#favoriteMatches'):null;
  if(target&&!target.innerHTML.trim())target.innerHTML='<div class="schedule-empty">Loading…</div>';
}
async function setPage(id){
  qsa('.page').forEach(p=>p.classList.toggle('active-page',p.id===id));
  qsa('[data-page]').forEach(a=>a.classList.toggle('active',a.dataset.page===id));
  history.replaceState(null,'','#'+id);
  scrollTo({top:0,behavior:'smooth'});
  try{
    if(['glass','vicpark','favorites'].includes(id))startSquashScoresPolling();
    if(id==='players'&&!playersRendered){showLoading(id);await ensurePlayersData();renderPlayers();playersRendered=true;}
    if(id==='glass'&&!glassReady){showLoading(id);await ensureMatchesData();setupGlass();glassReady=true;}
    if(id==='vicpark'&&!vicParkReady){showLoading(id);await ensureVicParkData();setupVicPark();vicParkReady=true;}
    if(id==='favorites'){showLoading(id);await ensureMatchesData();renderFavoritePlayers();favoritesReady=true;}
  }catch(e){console.error(e);showDataError(id,e);}
}
function showDataError(id,e){
  const target=id==='players'?qs('#playerGrid'):id==='glass'?qs('#glassMatches'):id==='favorites'?qs('#favoriteMatches'):qs('#trackedPlayers');
  if(target)target.innerHTML=`<div class="schedule-empty"><strong>Could not load tournament data.</strong><br>${esc(e?.message||e)}</div>`;
}
qsa('[data-page]').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();setPage(a.dataset.page)}));


function playerListDisplayName(name){
  return String(name||'')
    .replace(/\s*\[[^\]]+\]\s*$/,'')
    .replace(/\s+/g,' ')
    .trim();
}

function playerListAge(p){
  const raw=String(p?.ageGroup??'').trim();
  if(!raw)return '';
  return /\+$/.test(raw)?raw:`${raw}+`;
}

let cachedPlayerLevelRank=null;
let cachedPlayerLevelRankCount=-1;

function playerLevelRankMap(){
  const count=(data.players||[]).length;
  if(cachedPlayerLevelRank&&cachedPlayerLevelRankCount===count)return cachedPlayerLevelRank;

  const numeric=v=>{
    const raw=String(v??'').trim();
    if(!raw||!/[0-9]/.test(raw))return null;
    const n=Number(raw.replace(/,/g,'').replace(/[^0-9.-]/g,''));
    return Number.isFinite(n)?n:null;
  };
  const compareText=(a,b)=>String(a||'').localeCompare(
    String(b||''),undefined,{sensitivity:'base',numeric:true}
  );

  const rank=new Map();
  data.players.slice().sort((a,b)=>{
    const ar=numeric(a.squashLevelsLevel),br=numeric(b.squashLevelsLevel);
    if(ar==null&&br==null)return compareText(a.name,b.name);
    if(ar==null)return 1;
    if(br==null)return -1;
    const c=br-ar;
    return c===0?compareText(a.name,b.name):c;
  }).forEach((p,index)=>rank.set(p,index+1));

  cachedPlayerLevelRank=rank;
  cachedPlayerLevelRankCount=count;
  return rank;
}

function renderPlayers(){
  const term=norm(qs('#playerSearch').value), country=qs('#countryFilter').value, gender=qs('#genderFilter').value, age=qs('#ageFilter').value;
  const sortBy=qs('#playerSort')?.value||'name', sortOrder=qs('#playerSortOrder')?.value||'asc';
  const numeric=v=>{const raw=String(v??'').trim();if(!raw||!/[0-9]/.test(raw))return null;const n=Number(raw.replace(/,/g,'').replace(/[^0-9.-]/g,''));return Number.isFinite(n)?n:null};
  const compareText=(a,b)=>String(a||'').localeCompare(String(b||''),undefined,{sensitivity:'base',numeric:true});

  // Level rank is fixed against the complete player list and cached.
  const levelRank=playerLevelRankMap();

  const rows=data.players
    .filter(p=>(!term||norm(p.name).includes(term))&&(country==='all'||p.country===country)&&(gender==='all'||p.gender===gender)&&(age==='all'||String(p.ageGroup)===age))
    .sort((a,b)=>{
      // Players without a SquashLevels Level always stay at the bottom for Level sorts.
      if(sortBy==='level'){
        const ar=numeric(a.squashLevelsLevel), br=numeric(b.squashLevelsLevel);
        if(ar==null&&br==null)return compareText(a.name,b.name);
        if(ar==null)return 1;if(br==null)return -1;
        const c=ar-br; return c===0?compareText(a.name,b.name):(sortOrder==='desc'?-c:c);
      }
      let c=0;
      if(sortBy==='country')c=compareText(a.country,b.country)||compareText(a.name,b.name);
      else if(sortBy==='age')c=(numeric(a.ageGroup)??999)-(numeric(b.ageGroup)??999)||compareText(a.name,b.name);
      else c=compareText(a.name,b.name);
      return sortOrder==='desc'?-c:c;
    });
  qs('#playerCount').textContent=rows.length;
  qsa('.country-chip').forEach(ch=>ch.classList.toggle('active',ch.dataset.country===country));
  qs('#playerGrid').innerHTML=rows.map(p=>{
    const profileUrl=playerPageUrl(p.name,p.officialPlayerId);
    const displayName=playerListDisplayName(p.name);
    const displayAge=playerListAge(p);
    const metrics=squashBadges(p);
    const fav=favoriteButton(p.name,'favorite-list-btn');
    const rankPrefix=sortBy==='level'?`${levelRank.get(p)} - `:'';

    return `<div class="player-card">
    <div class="player-card-desktop-layout">
      <a class="player-card-flag-link" href="${profileUrl}"><div class="flag-avatar">${flagImg(p,'flag-img')}</div></a>
      <div class="player-card-copy"><div class="player-card-name-line"><div class="player-name-stack"><div class="player-name-meta-line"><a class="player-card-name-link" href="${profileUrl}"><b>${rankPrefix}${esc(displayName)}</b></a><small class="player-inline-meta">${esc(p.country)}${displayAge?` · ${esc(displayAge)}`:''}</small></div><div class="player-level-line">${metrics}${p.squashLevelsUrl?`<a class="squashlevels-btn squashlevels-list-btn" href="${esc(p.squashLevelsUrl)}" target="_blank" rel="noopener noreferrer" title="Open ${esc(displayName)} on SquashLevels">SquashLevels</a>`:''}${fav}</div></div></div></div>
    </div>
    <div class="mobile-player-layout">
      <a class="mobile-player-name" href="${profileUrl}">${rankPrefix}${esc(displayName)}</a>
      <div class="mobile-player-info">
        <a class="mobile-player-flag" href="${profileUrl}">${flagImg(p,'flag-img')}</a>
        <div class="mobile-player-details">
          <div class="mobile-player-country">${esc(p.country||'')}${displayAge?` · ${esc(displayAge)}`:''}</div>
          <div class="mobile-player-metrics">${metrics}${p.squashLevelsUrl?`<a class="squashlevels-btn squashlevels-list-btn" href="${esc(p.squashLevelsUrl)}" target="_blank" rel="noopener noreferrer" title="Open ${esc(displayName)} on SquashLevels">SquashLevels</a>`:''}${fav}</div>
        </div>
      </div>
    </div>
  </div>`;
  }).join('');
}
function summaryCountries(){
  if(Array.isArray(data.countries)&&data.countries.length)return data.countries;
  const map=new Map();
  for(const p of (data.players||[])){const key=p.country||'Unknown';if(!map.has(key))map.set(key,{country:key,count:0,flagCode:p.flagCode||'',iso3:p.iso3||''});map.get(key).count++;}
  return [...map.values()].sort((a,b)=>b.count-a.count||a.country.localeCompare(b.country));
}
function flagImgSummary(c,cls='inline-flag'){return c?.flagCode?`<img class="${cls}" src="https://flagcdn.com/w80/${c.flagCode}.png" alt="${esc(c.country||'')} flag">`:'<span class="flag-fallback">🌐</span>';}
function setupPlayersShell(){
  const countries=summaryCountries();
  const countryFilter=qs('#countryFilter');
  countries.slice().sort((a,b)=>a.country.localeCompare(b.country)).forEach(c=>countryFilter.insertAdjacentHTML('beforeend',`<option value="${esc(c.country)}">${esc(c.country)} (${c.count})</option>`));
  const strip=qs('#countryStrip');
  if(strip){
    strip.innerHTML=`<button class="country-chip active" data-country="all">All <span class="chip-count">${Number(data.playerCount||0).toLocaleString('en-AU')}</span></button>`+countries.map(c=>`<button class="country-chip" data-country="${esc(c.country)}">${flagImgSummary(c)}<span>${esc(c.country)}</span><span class="chip-count">${c.count}</span></button>`).join('');
    qsa('.country-chip').forEach(ch=>ch.addEventListener('click',async()=>{countryFilter.value=ch.dataset.country;await setPage('players');renderPlayers();}));
  }
  const ages=Array.isArray(data.ageGroups)?data.ageGroups:[];
  ages.forEach(a=>qs('#ageFilter').insertAdjacentHTML('beforeend',`<option value="${a}">${a}+</option>`));
  ['#playerSearch','#countryFilter','#genderFilter','#ageFilter','#playerSortOrder'].forEach(sel=>qs(sel).addEventListener(sel==='#playerSearch'?'input':'change',()=>{if(playersReady)renderPlayers()}));
  qs('#playerSort').addEventListener('change',()=>{
    // Highest Level first whenever the user switches to Level sorting.
    if(qs('#playerSort').value==='level')qs('#playerSortOrder').value='desc';
    if(playersReady)renderPlayers();
  });
  qs('#countryCount').textContent=countries.length;
  const counts=Object.fromEntries(countries.map(c=>[c.country,c.count]));
  const startMap=()=>setupParticipationMap(counts);
  if('requestIdleCallback' in window)requestIdleCallback(startMap,{timeout:1200});else setTimeout(startMap,50);
}
async function setupParticipationMap(counts){
  if(!window.Plotly){
    try{await loadScriptOnce('https://cdn.plot.ly/plotly-2.35.2.min.js');}catch(e){console.warn('Participation map library could not be loaded:',e.message);return;}
  }
  // TournamentSoftware uses some sporting country codes that differ from ISO-3166 alpha-3.
  // Plotly's world map requires ISO-3166 alpha-3 (e.g. South Africa is ZAF, not RSA).
  const mapIso3 = code => ({ RSA:'ZAF' }[String(code||'').toUpperCase()] || String(code||'').toUpperCase());
  const grouped={}; summaryCountries().forEach(c=>{const iso=mapIso3(c.iso3);if(!iso)return;grouped[iso]={name:c.country,count:c.count};});
  const locations=Object.keys(grouped), z=locations.map(()=>1), text=locations.map(k=>`${grouped[k].name}: ${grouped[k].count} player${grouped[k].count===1?'':'s'}`);
  Plotly.newPlot('participationMap',[{type:'choropleth',locationmode:'ISO-3',locations,z,text,hovertemplate:'%{text}<extra></extra>',colorscale:[[0,'#f5c84c'],[1,'#f5c84c']],showscale:false,marker:{line:{color:'#071427',width:.7}}}],{margin:{l:0,r:0,t:0,b:0},paper_bgcolor:'rgba(0,0,0,0)',geo:{projection:{type:'natural earth'},showframe:false,showcoastlines:false,showcountries:true,countrycolor:'#294462',showland:true,landcolor:'#152b45',showocean:true,oceancolor:'rgba(5,19,35,.35)',bgcolor:'rgba(0,0,0,0)'}},{displayModeBar:false,responsive:true});
  addOfficialTournamentTiles();
  updateDataAttribution();
}
function venueCode(m){
  const place=[m.venue,m.court].filter(Boolean).join(' · ');
  if(/Karrinyup|\bAGC\b|Glass/i.test(place)) return 'G';
  if(/Mirrabooka|Squashworld/i.test(place)) return 'M';
  if(/Belmont|WA\s*State\s*Squash/i.test(place)) return 'B';
  return '';
}
function venueBadge(m){const code=venueCode(m);return code?`<span class="venue-letter venue-${code.toLowerCase()}" aria-label="${code==='G'?'Glass Court':code==='M'?'Mirrabooka':'Belmont'}">${code}</span>`:'';}
function stripLocationDate(value,{keepStandaloneNumber=false}={}){
  let s=String(value||'')
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g,'')
    .replace(/\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/g,'')
    .replace(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\b[,]?\s*/gi,'')
    .replace(/\b\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:\s+\d{4})?\b/gi,'');
  if(!keepStandaloneNumber)s=s.replace(/^\s*\d{1,2}\s*$/g,'');
  return s
    .replace(/\s*[·|,\-–—]\s*$/g,'')
    .replace(/\s{2,}/g,' ')
    .trim();
}
function actualCourt(m){
  const raw=String(m?.rawText||'');

  // Prefer only explicit court tokens. Never accept a plain number because
  // TournamentSoftware round labels such as "Round of 64" otherwise leak into
  // the location column.
  const explicit=(raw.match(/\b(AGC(?:\s*\d+)?|SC\s*\d+|Court\s*\d+)\b/i)||[])[1]||'';
  if(explicit){
    const c=String(explicit).replace(/\s+/g,' ').trim();
    if(/^SC\s*\d+$/i.test(c))return c.replace(/\s+/g,'').toUpperCase();
    if(/^AGC(?:\s*\d+)?$/i.test(c))return c.replace(/\s+/g,'').toUpperCase();
    return c;
  }

  let current=String(m?.court||'').replace(/\s+/g,' ').trim();

  // Strip round/bracket text accidentally stored as court metadata.
  current=current
    .replace(/\b(?:Round\s+of|Round|Quarter\s*Final|Quarter[- ]?final|Semi[- ]?final|Final)\s*\d*\b/ig,' ')
    .replace(/\s+/g,' ')
    .trim();

  // Only whitelist actual supported court formats.
  if(!/^(?:AGC(?:\s*\d+)?|SC\s*\d+|Court\s*\d+)$/i.test(current))return '';

  if(/^SC\s*\d+$/i.test(current))return current.replace(/\s+/g,'').toUpperCase();
  if(/^AGC(?:\s*\d+)?$/i.test(current))return current.replace(/\s+/g,'').toUpperCase();
  return current;
}
function cleanVenuePlace(m){
  const venue=stripLocationDate(m.venue);
  const court=actualCourt(m);
  const bits=[venue,court].filter(Boolean);
  return bits.join(' · ')||'Venue / court TBD';
}

function matchCardPlayer(name,p,id,right=false){
  if(isTbdName(name)||!name){
    return `<div class="player-side${right?' right':''}"><span class="player-name-stack"><b>TBD</b></span></div>`;
  }
  const link=`<a class="match-player-link" href="${playerPageUrl(name,p?.officialPlayerId||id)}"><span class="player-name-stack"><b>${esc(name)}</b>${squashBadges(p)}</span></a>`;
  return right
    ? `<div class="player-side right">${link}${flagImg(p)}</div>`
    : `<div class="player-side">${flagImg(p)}${link}</div>`;
}
function matchCard(m){
  const p1=playerForMatchSide(m,1), p2=playerForMatchSide(m,2);
  return `<article class="match-card"><div class="match-time">${esc(displayTime24(m.time))}</div><div class="event-badge">${esc([m.event,m.round].filter(Boolean).join(' · '))}</div><div class="fixture">${matchCardPlayer(m.player1,p1,m.player1Id,false)}<div class="vs">VS</div>${matchCardPlayer(m.player2,p2,m.player2Id,true)}</div><div class="court-tag">${venueBadge(m)}<span>${esc(cleanVenuePlace(m))}</span></div></article>`;
}

function scoreWinnerInfo(m){
  const games=[...String(m?.result||'').matchAll(/(\d{1,2})\s*[-–—]\s*(\d{1,2})/g)]
    .map(x=>[Number(x[1]),Number(x[2])]);

  if(!games.length){
    return {name:String(m?.winner||''),games:''};
  }
  let p1=0,p2=0;
  for(const [a,b] of games){
    if(a>b)p1++;
    else if(b>a)p2++;
  }
  if(p1===p2)return {name:'',games:''};
  return {
    name:p1>p2?String(m?.player1||''):String(m?.player2||''),
    games:`${Math.max(p1,p2)}:${Math.min(p1,p2)}`
  };
}

function scoreWinnerName(m){
  return scoreWinnerInfo(m).name;
}

function matchScoreSummary(m){
  if(!canShowPublishedResult(m))return '';
  if(!m?.result&&!m?.winner)return '';
  const winner=scoreWinnerInfo(m);

  return `<div class="match-history-score has-score">
    ${m.result?`<span class="match-history-score-label">Score</span><strong>${esc(m.result)}</strong>`:''}
    ${winner.name?`<span class="match-winner-label">Winner: <strong>${esc(winner.name)}${winner.games?` ${esc(winner.games)}`:''}</strong></span>`:''}
  </div>`;
}


function matchAgeGroupLabel(m,p1=null,p2=null){
  const raw=String(m?.event||'').replace(/\s+/g,' ').trim();

  if(raw){
    // Normalize TournamentSoftware forms such as "Women's +35" to "WOMEN'S 35+".
    const x=raw.match(/(Men(?:'s)?|Women(?:'s)?)\s*(?:Over\s*)?\+?\s*(35|40|45|50|55|60|65|70|75|80|85)/i);
    if(x){
      const gender=/women/i.test(x[1])?"WOMEN'S":"MEN'S";
      return `${gender} ${x[2]}+`;
    }
    return raw.toUpperCase();
  }

  const players=[p1,p2].filter(Boolean);
  const ages=players
    .map(p=>String(p?.ageGroup??'').match(/\d{2}/)?.[0]||'')
    .filter(Boolean);
  const age=ages.find(a=>ages.every(b=>b===a)) || ages[0] || '';

  const genders=players
    .map(p=>String(p?.gender||'').toLowerCase())
    .filter(Boolean);

  let gender='';
  const g=genders[0]||'';
  if(/female|women|woman|\bf\b/.test(g))gender="WOMEN'S";
  else if(/male|men|man|\bm\b/.test(g))gender="MEN'S";

  return [gender,age?`${age}+`:''].filter(Boolean).join(' ');
}

function compactScheduleRow(m,trackedNames=[]){
  const p1=playerForMatchSide(m,1), p2=playerForMatchSide(m,2);
  const ageGroupLabel=matchAgeGroupLabel(m,p1,p2);
  const p1Tracked=trackedNames.some(n=>sameName(n,m.player1));
  const p2Tracked=trackedNames.some(n=>sameName(n,m.player2));
  const v=venueVisual(m);
  const live=isMatchCurrent(m);
  return `<article class="vic-match-row ${isPast(m)?'past':''} ${live?'match-live':''}">
    <div class="vic-time"><span class="vic-time-value">${live?'<span class="live-match-dot" title="Match currently in progress" aria-label="Live"></span>':''}${esc(displayTime24(m.time))}</span><span class="vic-time-age">${esc(ageGroupLabel)}</span></div>
    <div class="vic-match-main">
      <div class="vic-event"><span class="vic-mobile-meta"><span class="vic-mobile-time">${live?'<span class="live-match-dot" title="Match currently in progress" aria-label="Live"></span>':''}${esc(displayTime24(m.time))}</span><span class="vic-mobile-location">${venueBadge(m)}<span class="vic-mobile-location-text">${esc(cleanVenuePlace(m))}</span></span><span class="vic-mobile-age">${esc(ageGroupLabel)}</span></span><span class="vic-desktop-event"><span class="vic-event-category">${esc(ageGroupLabel)}</span>${m.round?`<span class="vic-event-round"> · ${esc(m.round)}</span>`:''}</span></div>
      <div class="vic-fixture-line">
        <a class="${p1Tracked?'vic-tracked-player':''}" href="${playerPageUrl(m.player1,m.player1Id)}">
          <span class="fixture-player-desktop">${flagImg(p1)}<span class="vic-player-name-wrap"><span class="vic-player-name-meta-line">${playerNameStack(p1,playerListDisplayName(m.player1),p1Tracked)}${p1?.country?`<small class="vic-player-inline-meta">${esc(p1.country)}</small>`:''}</span></span></span>
          <span class="fixture-player-mobile">
            <span class="fixture-mobile-name">${esc(playerListDisplayName(m.player1))}</span>
            <span class="fixture-mobile-info">
              <span class="fixture-mobile-flag">${flagImg(p1)}</span>
              <span class="fixture-mobile-details">
                <span class="fixture-mobile-country">${esc(p1?.country||'')}</span>
                <span class="fixture-mobile-metrics">${squashBadges(p1)}</span>
              </span>
            </span>
          </span>
        </a>
        <span class="vic-vs">vs</span>
        <a class="${p2Tracked?'vic-tracked-player':''}" href="${playerPageUrl(m.player2,m.player2Id)}">
          <span class="fixture-player-desktop">${flagImg(p2)}<span class="vic-player-name-wrap"><span class="vic-player-name-meta-line">${playerNameStack(p2,playerListDisplayName(m.player2),p2Tracked)}${p2?.country?`<small class="vic-player-inline-meta">${esc(p2.country)}</small>`:''}</span></span></span>
          <span class="fixture-player-mobile">
            <span class="fixture-mobile-name">${esc(playerListDisplayName(m.player2))}</span>
            <span class="fixture-mobile-info">
              <span class="fixture-mobile-flag">${flagImg(p2)}</span>
              <span class="fixture-mobile-details">
                <span class="fixture-mobile-country">${esc(p2?.country||'')}</span>
                <span class="fixture-mobile-metrics">${squashBadges(p2)}</span>
              </span>
            </span>
          </span>
        </a>
      </div>
      ${matchScoreSummary(m)}
    </div>
    <div class="vic-location" title="${esc(v.place)}">${v.code?`<span class="venue-letter venue-${v.code.toLowerCase()}" aria-hidden="true">${v.code}</span>`:''}<span>${esc(v.place)}</span></div>
  </article>`;
}
function featureVenueKey(m){
  return canonicalVenue(m?.venue)||canonicalVenue(cleanVenuePlace(m))||'';
}
function featureVenueOptions(){
  return [
    'Karrinyup Shopping Centre',
    'Squashworld Mirrabooka',
    'Belmont Saints Squash Centre'
  ];
}
let selectedFeatureVenue='';
let selectedFeatureDate='';
function featureMatchesForVenue(){
  return (data.matches||[]).filter(m=>featureVenueKey(m)===selectedFeatureVenue);
}


function renderFeatureCourt(date=selectedFeatureDate){
  selectedFeatureDate=date;
  qsa('.date-tab').forEach(x=>x.classList.toggle('active',x.dataset.date===date));

  const venueBase=(data.baseMatches||data.matches||[])
    .filter(m=>featureVenueKey(m)===selectedFeatureVenue);

  const selectedBase=venueBase.filter(m=>canonicalDate(m.date)===date);
  const selectedMatches=ssOverlay(selectedBase,squashScoresLatestLive)
    .map(normaliseMatch)
    .map(normalizeSelfMatchAsBye)
    .sort((a,b)=>to24(a.time||'').localeCompare(to24(b.time||'')));

  const today=perthTodayIso();
  const history=venueBase
    .filter(m=>{
      const d=canonicalDate(m.date);
      return d&&d<today;
    })
    .map(normaliseMatch)
    .map(normalizeSelfMatchAsBye)
    .sort((a,b)=>{
      const ad=canonicalDate(a.date),bd=canonicalDate(b.date);
      if(ad!==bd)return bd.localeCompare(ad);
      return to24(a.time||'').localeCompare(to24(b.time||''));
    });

  const highlightedPlayers=[];
  for(const playerName of [...VIC_PARK_PLAYERS,...getFavoriteNames()]){
    if(playerName&&!highlightedPlayers.some(n=>sameName(n,playerName)))highlightedPlayers.push(playerName);
  }

  const title=qs('#featureCourtTitle');
  if(title)title.textContent='Courts';

  let html='';
  if(selectedMatches.length){
    html+=selectedMatches.map(m=>compactScheduleRow(m,highlightedPlayers)).join('');
  }else{
    html+=`<div class="schedule-empty"><strong>No matches found for this venue on ${esc(fmtDate(date).long)}.</strong></div>`;
  }

  // Keep the Courts view current: historical matches are shown below the
  // current/upcoming selection, exactly like the Vic Park page.
  if(history.length){
    html+=`<div class="vic-day-heading history-heading"><span>History</span><strong>Past matches</strong></div>`;
    let lastDate='';
    for(const m of history){
      const d=canonicalDate(m.date);
      if(d!==lastDate){
        lastDate=d;
        const f=fmtDate(d);
        html+=`<div class="vic-day-heading history-day-heading"><span>${esc(f.day)}</span><strong>${esc(f.date)}</strong></div>`;
      }
      html+=compactScheduleRow(m,highlightedPlayers);
    }
  }

  qs('#glassMatches').innerHTML=html;
  qs('#glassDayCount').textContent=selectedMatches.length;
}

function perthTodayIso(){
  try{const p=Object.fromEntries(new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Perth',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`;}catch{return new Date().toISOString().slice(0,10)}
}
function preferredExistingCourtDate(dates){
  if(!dates.length)return '';
  const today=perthTodayIso();
  if(dates.includes(today))return today;
  return dates.find(d=>d>today)||dates[dates.length-1];
}
function rebuildFeatureDates(){
  const venueMatches=featureMatchesForVenue();
  const dates=[...new Set(venueMatches.map(m=>canonicalDate(m.date)).filter(Boolean))].sort();
  const useDates=dates.length?dates:tournamentDates();
  selectedFeatureDate=preferredExistingCourtDate(useDates);
  qs('#dateTabs').innerHTML=useDates.map(d=>{const f=fmtDate(d);return `<button class="date-tab ${d===selectedFeatureDate?'active':''}" data-date="${d}"><strong>${f.day}</strong><small>${f.date}</small></button>`}).join('');
  qsa('.date-tab').forEach(b=>b.addEventListener('click',()=>renderFeatureCourt(b.dataset.date)));
  if(selectedFeatureDate)renderFeatureCourt(selectedFeatureDate);
}
function setupGlass(){
  const venues=featureVenueOptions();
  selectedFeatureVenue=venues[0]||'';
  const sel=qs('#featureVenue');
  if(sel){
    sel.innerHTML=venues.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join('');
    sel.value=selectedFeatureVenue;
    sel.addEventListener('change',()=>{selectedFeatureVenue=sel.value;rebuildFeatureDates();});
  }
  rebuildFeatureDates();
}


function splitUpcomingAndHistoryRows(rows,getMatch){
  const today=perthTodayIso();
  const upcoming=[],history=[];

  for(const row of rows||[]){
    const m=getMatch(row);
    const d=canonicalDate(m?.date||'');
    if(d&&d<today)history.push(row);
    else upcoming.push(row);
  }

  const asc=(a,b)=>{
    const am=getMatch(a),bm=getMatch(b);
    return `${canonicalDate(am.date)} ${to24(am.time||'')}`.localeCompare(`${canonicalDate(bm.date)} ${to24(bm.time||'')}`);
  };
  const historyOrder=(a,b)=>{
    const am=getMatch(a),bm=getMatch(b);
    const ad=canonicalDate(am.date),bd=canonicalDate(bm.date);

    // Newest past day first...
    if(ad!==bd)return bd.localeCompare(ad);

    // ...but within each past day, first match first.
    return to24(am.time||'').localeCompare(to24(bm.time||''));
  };

  upcoming.sort(asc);
  history.sort(historyOrder);
  return {upcoming,history};
}

function renderGroupedMatchRows(rows,getMatch,renderRow){
  const {upcoming,history}=splitUpcomingAndHistoryRows(rows,getMatch);
  let html='',day='';

  const renderGroup=(group,isHistory=false)=>{
    if(isHistory&&group.length){
      html+=`<div class="vic-day-heading history-heading"><span>History</span><strong>Past matches</strong></div>`;
    }
    day='';
    for(const row of group){
      const m=getMatch(row);
      const d=canonicalDate(m.date);
      if(d!==day){
        day=d;
        const f=fmtDate(d);
        html+=`<div class="vic-day-heading ${isHistory?'history-day-heading':''}"><span>${esc(f.day)}</span><strong>${esc(f.date)}</strong></div>`;
      }
      html+=renderRow(row);
    }
  };

  // Always keep History at the BOTTOM of the list.
  renderGroup(upcoming,false);
  renderGroup(history,true);
  return html;
}

function renderFavoritePlayers(){
  const favourites=getFavoriteNames().map(n=>playerByName(n)).filter(Boolean);
  const names=saveFavoriteNames(favourites.map(p=>p.name));
  const count=qs('#favoriteCount'),label=qs('#favoriteCountLabel');if(count)count.textContent=names.length;if(label)label.textContent=names.length===1?'player selected':'players selected';
  const list=qs('#favoritePlayerList'),matchesEl=qs('#favoriteMatches');if(!list||!matchesEl)return;
  if(!names.length){list.innerHTML='';matchesEl.innerHTML='<div class="schedule-empty"><strong>No favourite players yet.</strong><br><span>Open Players and tap ☆ Fav next to anyone you want to follow.</span></div>';return;}
  list.innerHTML=favourites.map(p=>`<div class="fav-player-card"><a class="fav-player-main" href="${playerPageUrl(p.name,p.officialPlayerId)}">${flagImg(p,'flag-img')}<span class="player-name-stack"><b>${esc(p.name)}</b>${squashBadges(p)}<small>${esc(p.country)} · ${p.ageGroup}+</small></span></a>${favoriteButton(p.name,'fav-remove-btn')}</div>`).join('');
  const stableBase=(data.baseMatches||data.matches||[]);
  const favBase=stableBase.filter(m=>names.some(n=>sameName(m.player1,n)||sameName(m.player2,n)));
  const favMatches=ssOverlay(favBase,squashScoresLatestLive)
    .map(normaliseMatch)
    .map(normalizeSelfMatchAsBye);

  const map=new Map();
  for(const m of favMatches){
    const tracked=names.filter(n=>sameName(m.player1,n)||sameName(m.player2,n));
    if(!tracked.length)continue;

    const players=[nameKey(m.player1||''),nameKey(m.player2||'')].filter(Boolean).sort().join('|');
    const key=`${canonicalDate(m.date)}||${to24(m.time||'')}||${players}`;

    if(!map.has(key))map.set(key,{m,tracked:[...tracked]});
    else{
      const row=map.get(key);
      for(const favName of tracked){
        if(!row.tracked.some(x=>sameName(x,favName)))row.tracked.push(favName);
      }
      if(!row.m.result&&m.result)row.m=m;
    }
  }
  const rows=[...map.values()];
  const html=renderGroupedMatchRows(
    rows,
    row=>row.m,
    row=>compactScheduleRow(row.m,row.tracked)
  );
  matchesEl.innerHTML=html||'<div class="schedule-empty"><strong>No published matches found for your favourite players.</strong></div>';refreshFavoriteButtons();
}
document.addEventListener('click',e=>{const btn=e.target.closest?.('[data-favourite-player]');if(!btn)return;e.preventDefault();e.stopPropagation();const n=btn.dataset.favouritePlayer||'';if(!n)return;toggleFavoritePlayer(n);refreshFavoriteButtons();if(location.hash==='#favorites')renderFavoritePlayers();});

function trackedMatchCard(m,name){
  const tracked=playerByName(name)||{name}, opp=opponentFor(m,name), op=playerByName(opp);
  return `<article class="tracked-match"><div class="tracked-match-top"><div><b>${fmtDate(m.date).long}</b><span>${esc([m.event,m.round].filter(Boolean).join(' · '))}</span></div><strong>${esc(displayTime24(m.time))}</strong></div><div class="tracked-fixture"><div class="tracked-side">${flagImg(tracked,'match-flag')}<div><small>TRACKED</small><a href="${playerPageUrl(name,tracked?.officialPlayerId)}"><span class="player-name-stack"><b>${esc(name)}</b>${squashBadges(tracked)}</span></a></div></div><div class="versus-badge">VS</div><div class="tracked-side right"><div><small>OPPONENT</small>${isTbdName(opp)||!opp?`<span class="player-name-stack"><b>TBD</b></span>`:`<a href="${playerPageUrl(opp,op?.officialPlayerId)}"><span class="player-name-stack"><b>${esc(opp)}</b>${squashBadges(op)}</span></a>`}</div>${isTbdName(opp)||!opp?'':flagImg(op,'match-flag')}</div></div><div class="roger-meta"><span>${esc(cleanVenuePlace(m))}</span>${m.result?`<span>${esc(m.result)}</span>`:''}</div></article>`;
}
function venueVisual(m){
  return {place:cleanVenuePlace(m),code:venueCode(m)};
}
function setupVicPark(){
  const names=VIC_PARK_PLAYERS;
  qs('#trackedCount').textContent=names.length;
  qs('#trackedCountLabel').textContent=names.length===1?'player tracked':'players tracked';

  const trackedPlayers=(vicParkPlayers||[])
    .filter(p=>names.some(n=>sameName(p.name,n)));
  const trackedIds=new Set(
    trackedPlayers.map(p=>String(p.officialPlayerId||'')).filter(Boolean)
  );

  const rows=[];
  for(const m of (vicParkMatches||[])){
    const idMatch=
      (m.player1Id&&trackedIds.has(String(m.player1Id))) ||
      (m.player2Id&&trackedIds.has(String(m.player2Id)));

    const trackedByName=names.filter(name=>matchHas(m,name));
    if(!idMatch&&!trackedByName.length)continue;

    const tracked=[];
    for(const p of trackedPlayers){
      const pid=String(p.officialPlayerId||'');
      if(
        (pid&&(String(m.player1Id||'')===pid||String(m.player2Id||'')===pid)) ||
        sameName(m.player1,p.name) ||
        sameName(m.player2,p.name)
      ){
        if(!tracked.some(n=>sameName(n,p.name)))tracked.push(p.name);
      }
    }
    for(const n of trackedByName){
      if(!tracked.some(x=>sameName(x,n)))tracked.push(n);
    }

    rows.push({m,tracked});
  }

  const container=qs('#trackedPlayers');
  if(!rows.length){
    container.innerHTML=`<div class="schedule-empty"><strong>No Vic Park matches found in the refreshed match data.</strong><br><span>${names.length?`Tracking: ${names.map(esc).join(', ')}`:'Add players to vic-park-players.js.'}</span></div>`;
    return;
  }

  container.innerHTML=renderGroupedMatchRows(
    rows,
    row=>row.m,
    row=>compactScheduleRow(row.m,row.tracked)
  );
}

function to24(t){
  const s=String(t||'').trim(); const m=s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i); if(!m)return s.padStart(8,'9');
  let h=+m[1]; const ap=(m[3]||'').toLowerCase(); if(ap==='pm'&&h<12)h+=12; if(ap==='am'&&h===12)h=0; return `${String(h).padStart(2,'0')}:${m[2]}`;
}
function displayTime24(t){
  const raw=String(t||'').trim();if(!raw)return 'TBD';
  let m=raw.match(/\b(\d{1,2})(?::(\d{2}))?\s*([AP]M)\b/i);
  if(m){let h=Number(m[1])%12;if(/^p/i.test(m[3]))h+=12;return `${String(h).padStart(2,'0')}:${m[2]||'00'}`;}
  m=raw.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);if(m)return `${String(Number(m[1])).padStart(2,'0')}:${m[2]}`;
  return raw;
}
function stamp(){const el=qs('#refreshStamp'); if(!el)return; el.textContent=data.refreshedAt?`Tournament data refreshed ${new Date(data.refreshedAt).toLocaleString('en-AU')}`:'Bundled snapshot — run npm run refresh to pull the latest TournamentSoftware data.';}
function makeHomeSummary(source){
  const players=Array.isArray(source?.players)?source.players:[];
  const matches=Array.isArray(source?.matches)?source.matches:[];
  const countries=new Map();
  for(const p of players){
    const country=String(p.country||'Unknown').trim()||'Unknown';
    if(!countries.has(country))countries.set(country,{country,count:0,flagCode:p.flagCode||'',iso3:p.iso3||''});
    const c=countries.get(country);c.count++;
    if(!c.flagCode&&p.flagCode)c.flagCode=p.flagCode;
    if(!c.iso3&&p.iso3)c.iso3=p.iso3;
  }
  return {
    tournament:source?.tournament||{},
    refreshedAt:source?.refreshedAt||null,
    squashLevelsRefreshedAt:source?.squashLevelsRefreshedAt||null,
    playerCount:players.length,
    matchCount:matches.length,
    countries:[...countries.values()].sort((a,b)=>b.count-a.count||a.country.localeCompare(b.country)),
    ageGroups:[...new Set(players.map(p=>p.ageGroup).filter(x=>x!==null&&x!==undefined&&String(x)!==''))].sort((a,b)=>Number(a)-Number(b))
  };
}


let squashScoresPollTimer=null;
let squashScoresLatestLive=[];
let squashScoresLatestFingerprint='';
let squashScoresLastVicParkFingerprint='';
function squashScoresFingerprint(rows){
  return JSON.stringify((rows||[]).map(m=>[
    canonicalDate(m.date||''),displayTime24(m.time||''),
    ssNorm(m.player1),ssNorm(m.player2),String(m.status||''),
    String(m.result||''),String(m.venue||''),String(m.court||'')
  ]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

async function updateSquashScoresLive(){
  try{
    const payload=await fetchSquashScoresApi();
    const known=[...(data.players||[]),...(vicParkPlayers||[])];
    const uniq=[];const seen=new Set();
    for(const p of known){
      const k=ssNorm(p?.name);
      if(k&&!seen.has(k)){seen.add(k);uniq.push(p)}
    }

    const parsed=parseSquashScoresApi(payload,uniq);
    const live=parsed.filter(m=>String(m.status||'').toLowerCase()==='live');
    const fingerprint=squashScoresFingerprint(live);
    if(fingerprint===squashScoresLastFingerprint)return;
    squashScoresLastFingerprint=fingerprint;

    if(matchesReady){
      data.matches=ssOverlay(data.baseMatches||data.matches,live)
        .map(normaliseMatch)
        .map(normalizeSelfMatchAsBye);
      rebuildFavoriteMatchIndex();
    }

    if(vicParkDataReady){
      vicParkMatches=ssOverlay(window.__vicParkBaseMatches||vicParkMatches,live)
        .map(normaliseMatch)
        .map(normalizeSelfMatchAsBye);
    }

    const page=location.hash.slice(1)||'home';
    if(page==='glass'&&glassReady)renderFeatureCourt(selectedFeatureDate);
    else if(page==='favorites')renderFavoritePlayers();
    else if(page==='vicpark'&&vicParkReady)setupVicPark();
  }catch(e){
    console.warn('SquashScores live unavailable:',e?.message||e);
  }
}
function startSquashScoresPolling(){
  if(squashScoresPollTimer)return;
  const tick=()=>{if(document.visibilityState==='visible')updateSquashScoresLive()};
  tick();
  squashScoresPollTimer=setInterval(tick,SQUASH_SCORES_POLL_MS);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')tick()});
}

const AUTO_REFRESH_CHECK_MS=60*1000;
let autoRefreshLoadedToken='';

function syncTokenFromSummary(summary){
  const a=String(summary?.refreshedAt||'');
  const b=String(summary?.squashLevelsRefreshedAt||'');
  return `${a}|${b}`;
}

async function fetchLatestSyncToken(){
  // Local file:// pages cannot fetch another local file because of browser CORS,
  // but they can load JavaScript files normally. Use a temporary script tag
  // locally and regular no-cache fetch on http/https.
  if(location.protocol==='file:'){
    return new Promise(resolve=>{
      const previous=window.TOURNAMENT_SUMMARY;
      const script=document.createElement('script');
      script.src=`summary-data.js?synccheck=${Date.now()}`;
      script.async=true;
      script.onload=()=>{
        const token=syncTokenFromSummary(window.TOURNAMENT_SUMMARY||{});
        script.remove();
        // Keep the newly loaded summary object; it is harmless and lets the
        // next local check compare against the newest timestamps.
        resolve(token);
      };
      script.onerror=()=>{
        window.TOURNAMENT_SUMMARY=previous;
        script.remove();
        resolve('');
      };
      document.head.appendChild(script);
    });
  }

  try{
    const response=await fetch(`summary-data.js?synccheck=${Date.now()}`,{cache:'no-store'});
    if(!response.ok)return '';
    const source=await response.text();
    const refreshed=(source.match(/["']?refreshedAt["']?\s*:\s*["']([^"']+)["']/i)||[])[1]||'';
    const squash=(source.match(/["']?squashLevelsRefreshedAt["']?\s*:\s*["']([^"']+)["']/i)||[])[1]||'';
    return `${refreshed}|${squash}`;
  }catch{
    return '';
  }
}

function startAutomaticSyncRefresh(){
  autoRefreshLoadedToken=syncTokenFromSummary(window.TOURNAMENT_SUMMARY||data||{});

  const check=async()=>{
    if(document.visibilityState==='hidden')return;
    const latest=await fetchLatestSyncToken();
    if(!latest||latest==='|')return;

    if(!autoRefreshLoadedToken||autoRefreshLoadedToken==='|'){
      autoRefreshLoadedToken=latest;
      return;
    }

    if(latest!==autoRefreshLoadedToken){
      try{localStorage.setItem('wsm2026LastSeenSync',latest)}catch{}
      location.reload();
    }
  };

  setInterval(check,AUTO_REFRESH_CHECK_MS);
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='visible')check();
  });
}




function addOfficialTournamentTiles(){
  if(document.querySelector('#officialTournamentLinks'))return;

  // #countryStrip is the actual country list used by this site.
  const countryList=document.querySelector('#countryStrip');
  const map=document.querySelector('#participationMap');
  const home=document.querySelector('#home');
  if(!home)return;

  const wrap=document.createElement('div');
  wrap.id='officialTournamentLinks';

  Object.assign(wrap.style,{
    display:'grid',
    gridTemplateColumns:'repeat(3,minmax(0,1fr))',
    gap:'12px',
    margin:'18px 0 8px'
  });

  const makeTile=(href,icon,title,subtitle)=>{
    const a=document.createElement('a');
    a.href=href;
    a.target='_blank';
    a.rel='noopener noreferrer';
    a.innerHTML=`
      <span style="
        width:42px;height:42px;display:grid;place-items:center;
        border-radius:11px;background:rgba(245,200,76,.12);
        font-size:1.35rem;flex:0 0 auto
      " aria-hidden="true">${icon}</span>
      <span style="display:flex;flex-direction:column;gap:3px;min-width:0">
        <strong style="font-size:.95rem;line-height:1.2">${title}</strong>
        <small style="font-size:.76rem;opacity:.72;line-height:1.25">${subtitle} ↗</small>
      </span>
    `;

    Object.assign(a.style,{
      display:'flex',
      alignItems:'center',
      gap:'12px',
      minHeight:'64px',
      padding:'12px 14px',
      border:'1px solid rgba(245,200,76,.30)',
      borderRadius:'14px',
      background:'rgba(245,200,76,.055)',
      color:'inherit',
      textDecoration:'none',
      boxShadow:'0 6px 18px rgba(0,0,0,.10)',
      transition:'transform .16s ease, background .16s ease, border-color .16s ease'
    });

    a.addEventListener('mouseenter',()=>{
      a.style.background='rgba(245,200,76,.11)';
      a.style.borderColor='rgba(245,200,76,.48)';
      a.style.transform='translateY(-2px)';
    });

    a.addEventListener('mouseleave',()=>{
      a.style.background='rgba(245,200,76,.055)';
      a.style.borderColor='rgba(245,200,76,.30)';
      a.style.transform='';
    });

    return a;
  };

  wrap.append(
    makeTile(
      'https://www.worldsquashmasters.com/information',
      '🌐',
      'Official Tournament Home',
      'Event information, news and visitor details'
    ),
    makeTile(
      'https://wsf.tournamentsoftware.com/tournament/1d88743a-54e2-4073-bd30-a4f443a442f0',
      '🏆',
      'Official Live Tournament',
      'Draws, matches, players and results'
    ),
    makeTile(
      'https://worldsquash.tv/sportitemset/69cfa93e66fddb2162f01615',
      '▶️',
      'Live Stream',
      'Watch the World Squash Masters live'
    )
  );

  // Put the tiles AFTER the top-level Home section that contains the country
  // list. This guarantees they sit outside the world-map/card frame even when
  // #countryStrip itself is nested inside that frame.
  const topLevelHomeChild=el=>{
    let cur=el;
    while(cur?.parentElement&&cur.parentElement!==home)cur=cur.parentElement;
    return cur?.parentElement===home?cur:null;
  };

  const outsideAnchor=
    topLevelHomeChild(countryList) ||
    topLevelHomeChild(map);

  if(outsideAnchor?.parentNode){
    outsideAnchor.insertAdjacentElement('afterend',wrap);
  }else{
    home.appendChild(wrap);
  }

  const makeResponsive=()=>{
    wrap.style.gridTemplateColumns=window.innerWidth<640
      ? '1fr'
      : window.innerWidth<980
        ? 'repeat(2,minmax(0,1fr))'
        : 'repeat(3,minmax(0,1fr))';
  };
  makeResponsive();
  window.addEventListener('resize',makeResponsive,{passive:true});
}

function updateDataAttribution(){
  const home=document.querySelector('#home');
  if(!home)return;

  const intro="Vic Park Squash Club's Tailored website to make it easier to follow our club members.";

  // IMPORTANT: change only the subtitle paragraph. Never replace a containing
  // div/hero element, otherwise the World Squash Masters 2026 heading disappears.
  const paragraphs=[...home.querySelectorAll('p')];
  let target=paragraphs.find(el=>
    /Vic Park Squash Club's Tailored website/i.test(String(el.textContent||'')) ||
    /The data is taken from the official site/i.test(String(el.textContent||'')) ||
    /The data on this site is taken from/i.test(String(el.textContent||''))
  );

  if(!target){
    const hero=home.querySelector('.hero')||home.querySelector('.home-hero')||home.firstElementChild;
    target=document.createElement('p');
    target.id='dataAttribution';

    if(hero){
      const heading=hero.querySelector?.('h1,h2');
      if(heading)heading.insertAdjacentElement('afterend',target);
      else hero.appendChild(target);
    }else{
      home.prepend(target);
    }
  }

  target.innerHTML=
    `${intro} ` +
    `The data is taken from the ` +
    `<a href="https://wsf.tournamentsoftware.com/tournament/1d88743a-54e2-4073-bd30-a4f443a442f0/Matches" target="_blank" rel="noopener noreferrer"><strong>official site</strong></a>, ` +
    `<a href="https://www.squashlevels.com/" target="_blank" rel="noopener noreferrer"><strong>SquashLevels</strong></a> and ` +
    `<a href="https://squashscores.com/" target="_blank" rel="noopener noreferrer"><strong>SquashScores</strong></a>.`;
}

async function bootstrap(){
  // Home normally needs only summary-data.js. Load it dynamically so a missing file cannot
  // block page startup, then fall back safely to legacy data.js during migration/deployment.
  if(!window.TOURNAMENT_SUMMARY){
    try{await loadScriptOnce('summary-data.js')}catch(e){console.warn('summary-data.js not available; deriving Home summary from data.js.');}
  }
  if(window.TOURNAMENT_SUMMARY){
    Object.assign(data,window.TOURNAMENT_SUMMARY,{players:[],matches:[]});
  }else{
    try{
      const legacy=await ensureLegacyData();
      if(legacy)Object.assign(data,makeHomeSummary(legacy),{players:[],matches:[]});
    }catch(e){console.error('Could not load tournament summary:',e)}
  }
  renderHeaderRefresh();setupPlayersShell();stamp();addOfficialTournamentTiles();updateDataAttribution();
  const initial=location.hash.slice(1);
  if(['players','glass','vicpark','favorites'].includes(initial))await setPage(initial);
  startAutomaticSyncRefresh();

  // Warm the full match dataset in the background so Fav Players opens quickly.
  // Other lightweight pages can remain interactive while this loads.
  if(!matchesReady){
    const warmMatches=()=>ensureMatchesData().catch(()=>{});
    if('requestIdleCallback' in window)requestIdleCallback(warmMatches,{timeout:2500});
    else setTimeout(warmMatches,900);
  }
}
bootstrap();
