
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



function applyVerifiedBracketFixtures(matches){
  const rows=(matches||[]).map(m=>({...m}));
  const verified=[
    {
      date:'2026-09-03',time:'11:20',player:'Leigh-Anne Kaye',opponent:'Jane Kennedy',
      venue:'Karrinyup Shopping Centre',court:'AGC',event:"Women's +50",
      source:'TournamentSoftware Draw Verified'
    },
    {
      date:'2026-09-04',time:'12:30',player:'Julian Buczek',opponent:'TBD',
      venue:'Belmont Saints Squash Centre',court:'SC8',event:"Men's +40",
      source:'TournamentSoftware Draw Verified TBD'
    }
  ];
  const isTbd=n=>/^TBD$/i.test(String(n||'').trim());
  const isReal=n=>!!String(n||'').trim()&&!isTbd(n)&&!/^Bye$/i.test(String(n||'').trim());
  const t24=v=>{
    const s=String(v||'').trim();
    const m=s.match(/^(\d{1,2}):([0-5]\d)\s*(am|pm)?$/i);
    if(!m)return s.toLowerCase();
    let h=Number(m[1]);
    const ap=String(m[3]||'').toLowerCase();
    if(ap==='pm'&&h<12)h+=12;
    if(ap==='am'&&h===12)h=0;
    return `${String(h).padStart(2,'0')}:${m[2]}`;
  };
  const sameSlot=(m,v)=>canonicalDate(m?.date||'')===v.date&&t24(m?.time)===t24(v.time);
  const samePlace=(m,v)=>{
    const venue=String(m?.venue||'').toLowerCase();
    const court=String(m?.court||'').replace(/\s+/g,'').toLowerCase();
    return venue===String(v.venue||'').toLowerCase()&&court===String(v.court||'').replace(/\s+/g,'').toLowerCase();
  };
  const today=typeof perthTodayIso==='function'?perthTodayIso():'';
  const playerId=n=>{
    const p=(data.players||[]).find(x=>sameName(x?.name,n));
    return p?.officialPlayerId||'';
  };

  for(const v of verified){
    if(today&&v.date<today)continue;
    // Keep compact datasets compact: only add a verified continuation when
    // this player is already represented in the dataset being repaired.
    const playerAlreadyInScope=rows.some(m=>sameName(m?.player1,v.player)||sameName(m?.player2,v.player));
    if(!playerAlreadyInScope)continue;
    let row=rows.find(m=>sameSlot(m,v)&&(sameName(m?.player1,v.player)||sameName(m?.player2,v.player)));

    if(row){
      // Never overwrite a newer concrete opponent. Only repair a missing/TBD side.
      if(v.opponent&&isReal(v.opponent)){
        if(sameName(row.player1,v.player)&&isTbd(row.player2)){
          row.player2=v.opponent;
          if(!row.player2Id)row.player2Id=playerId(v.opponent);
        }else if(sameName(row.player2,v.player)&&isTbd(row.player1)){
          row.player1=v.opponent;
          if(!row.player1Id)row.player1Id=playerId(v.opponent);
        }
      }
      if(!row.venue)row.venue=v.venue;
      if(!row.court)row.court=v.court;
      if(!row.event)row.event=v.event;
      if(!row.source)row.source=v.source;
      row.verifiedBracketFixture=true;
      continue;
    }

    // Do not create a second match if this exact court slot is already occupied
    // by a concrete published fixture that does not involve the verified player.
    const occupied=rows.some(m=>sameSlot(m,v)&&samePlace(m,v)&&isReal(m?.player1)&&isReal(m?.player2));
    if(occupied)continue;

    rows.push({
      date:v.date,time:v.time,
      player1:v.player,player2:v.opponent||'TBD',
      player1Id:playerId(v.player),player2Id:isReal(v.opponent)?playerId(v.opponent):'',
      venue:v.venue,court:v.court,event:v.event,round:'',
      result:'',winner:'',status:'scheduled',source:v.source,
      verifiedBracketFixture:true
    });
  }
  return rows;
}

function resolveKnownOpponentsFromTbdSlots(matches){
  const rows=(matches||[]).map(m=>({...m}));
  const isTbd=n=>/^TBD$/i.test(String(n||'').trim());
  const isReal=n=>!!String(n||'').trim()&&!isTbd(n)&&!/^Bye$/i.test(String(n||'').trim());
  const eventIdentityKey=m=>{
    const s=String(m?.event||'').toLowerCase();
    const age=(s.match(/\b(35|40|45|50|55|60|65|70|75|80|85)\+?\b/)||[])[1]||'';
    const gender=/women/.test(s)?'women':(/\bmen/.test(s)?'men':'');
    return `${gender}|${age}`;
  };
  const compactVenue=v=>String(v||'').replace(/\s+/g,' ').trim().toLowerCase();
  const compactCourt=v=>String(v||'').replace(/\s+/g,'').trim().toLowerCase();
  const slotKey=m=>{
    const d=canonicalDate(m?.date||'');
    const t=String(m?.time||'').replace(/\s+/g,' ').trim().toLowerCase();
    const venue=compactVenue(m?.venue);
    const court=compactCourt(m?.court);
    // Never infer across an unknown venue/court. A real court can host only one
    // match at a given time, which makes this pairing deterministic.
    if(!d||!t||!venue||!court)return '';
    return `${d}|${t}|${venue}|${court}|${eventIdentityKey(m)}`;
  };
  const groups=new Map();
  rows.forEach((m,i)=>{
    const key=slotKey(m);
    if(!key)return;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(i);
  });
  const playerIdForName=n=>{
    const p=(data.players||[]).find(x=>sameName(x?.name,n));
    return p?.officialPlayerId||'';
  };
  const pairKey=(a,b)=>[nameKey(a),nameKey(b)].sort().join('~');
  const today=typeof perthTodayIso==='function'?perthTodayIso():'';

  for(const indexes of groups.values()){
    if(indexes.length<2)continue;
    const sample=rows[indexes[0]];
    const d=canonicalDate(sample?.date||'');
    if(today&&d&&d<today)continue;

    const tbdRows=indexes.filter(i=>{
      const m=rows[i];
      return (isReal(m.player1)&&isTbd(m.player2))||(isTbd(m.player1)&&isReal(m.player2));
    });
    if(!tbdRows.length)continue;

    const concretePairs=new Map();
    for(const i of indexes){
      const m=rows[i];
      if(!isReal(m.player1)||!isReal(m.player2))continue;
      const k=pairKey(m.player1,m.player2);
      if(!concretePairs.has(k))concretePairs.set(k,[m.player1,m.player2]);
    }

    let pair=null;
    if(concretePairs.size===1){
      pair=[...concretePairs.values()][0];
    }else if(concretePairs.size===0){
      const realByKey=new Map();
      for(const i of tbdRows){
        const m=rows[i];
        const n=isReal(m.player1)?m.player1:m.player2;
        const k=nameKey(n);
        if(k&&!realByKey.has(k))realByKey.set(k,n);
      }
      if(realByKey.size===2)pair=[...realByKey.values()];
    }
    if(!pair)continue;

    const pairKeys=new Set(pair.map(nameKey));
    for(const i of tbdRows){
      const m=rows[i];
      const real=isReal(m.player1)?m.player1:m.player2;
      const realKey=nameKey(real);
      if(!pairKeys.has(realKey))continue;
      const opponent=pair.find(n=>nameKey(n)!==realKey);
      if(!opponent)continue;

      if(isTbd(m.player2)){
        m.player2=opponent;
        if(!m.player2Id)m.player2Id=playerIdForName(opponent);
      }else if(isTbd(m.player1)){
        m.player1=opponent;
        if(!m.player1Id)m.player1Id=playerIdForName(opponent);
      }
      m.opponentResolvedFromOfficialSlot=true;
    }
  }

  // Pairing two reciprocal "Player vs TBD" observations can create two
  // identical rows. Collapse only duplicates involving a row repaired above.
  const out=[];
  const exactKey=m=>{
    const key=slotKey(m);
    if(!key||!isReal(m.player1)||!isReal(m.player2))return '';
    return `${key}|${pairKey(m.player1,m.player2)}`;
  };
  for(const m of rows){
    const k=exactKey(m);
    const existingIndex=k?out.findIndex(x=>exactKey(x)===k):-1;
    if(existingIndex<0){out.push(m);continue;}
    const x=out[existingIndex];
    if(!m.opponentResolvedFromOfficialSlot&&!x.opponentResolvedFromOfficialSlot){
      out.push(m);continue;
    }

    const preferred=(m.result&&!x.result)?m:x;
    const other=preferred===m?x:m;
    for(const field of ['event','round','venue','court','source','sourceUrl','resultSource','winner','winnerId']){
      if(!preferred[field]&&other[field])preferred[field]=other[field];
    }
    if(!preferred.result&&other.result)preferred.result=other.result;
    if(String(other.status||'').toLowerCase()==='completed')preferred.status='completed';
    preferred.opponentResolvedFromOfficialSlot=true;
    out[existingIndex]=preferred;
  }

  return out;
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
  data.matches=(data.matches||[])
    .filter(m=>!m?.playerDetailOnly)
    .map(normaliseMatch)
    .map(normalizeSelfMatchAsBye);
  data.matches=resolveKnownOpponentsFromTbdSlots(applyVerifiedBracketFixtures(data.matches));
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
    vicParkMatches=resolveKnownOpponentsFromTbdSlots(applyVerifiedBracketFixtures(pack.matches.map(normaliseMatch).map(normalizeSelfMatchAsBye)));
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
  el.innerHTML=`<a class="header-meta-link" href="${official}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">Official Tournament Website</a>`;
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

const SQUASH_SCORES_LIVE_URL='https://www.squashscores.com/inprogress.php?categoryId=19&hideControls=1&tourname=World+Squash+Masters+2026';
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
  // Live SquashScores rows may contain only one or two game columns. The old
  // parser required at least three games, which meant early live scores were
  // silently discarded. Accept 1-5 score pairs and keep only plausible point
  // values. Completion is decided separately from the player-name bold state.
  const runs=[...s.matchAll(/\b\d{1,2}\s*-\s*\d{1,2}(?:(?:\s*,\s*|\s+)\d{1,2}\s*-\s*\d{1,2}){0,4}\b/g)];
  for(const run of runs){
    const pairs=[...run[0].matchAll(/(\d{1,2})\s*-\s*(\d{1,2})/g)]
      .map(x=>[+x[1],+x[2]])
      .filter(([a,b])=>a>=0&&b>=0&&a<=30&&b<=30&&!(a===0&&b===0));
    if(pairs.length)return pairs.map(([a,b])=>`${a}-${b}`).join(', ');
  }
  return '';
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
    const vals=(raw.match(/(?:^|\s)\d{1,2}(?=\s|$)/g)||[])
      .map(x=>+x.trim()).filter(x=>x>=0&&x<=30);
    // Score rows can legitimately contain 1-5 games while the match is live.
    return vals.slice(-Math.min(5,vals.length));
  };
  const av=values(a),bv=values(b);
  if(!av.length||av.length!==bv.length)return '';
  if(av.every((x,i)=>x===0&&bv[i]===0))return '';
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

// SquashScores sometimes labels a court as just "4" / "7" rather than
// "SC4" / "SC7".  Only treat a bare number as a court when it comes
// from an explicit SquashScores court/location field; never infer a court
// number from arbitrary match text (where numbers can be round/seed values).
function squashScoresCourtToken(value,{allowBareNumber=false}={}){
  let raw=value;
  if(raw&&typeof raw==='object'){
    raw=raw.courtName||raw.resourceName||raw.fieldName||raw.name||raw.title||raw.label||'';
  }
  const s=String(raw??'').replace(/\s+/g,' ').trim();
  if(!s)return '';

  let m=s.match(/\bSC\s*(\d{1,2})\b/i);
  if(m)return `SC${Number(m[1])}`;

  m=s.match(/\bAGC\s*(\d{1,2})?\b/i);
  if(m)return m[1]?`AGC${Number(m[1])}`:'AGC';

  m=s.match(/\bCourt\s*(\d{1,2})\b/i);
  if(m)return `SC${Number(m[1])}`;

  if(allowBareNumber&&/^\d{1,2}$/.test(s)){
    const n=Number(s);
    if(n>=1&&n<=30)return `SC${n}`;
  }

  return '';
}



// SquashScores can finish a match before either player reaches three games
// (for example a retirement).  The public JSON has used several different
// fields/labels for that state, so detect terminal signals recursively rather
// than relying on one status property.
function squashScoresTerminalReason(node){
  if(!node||typeof node!=='object')return '';

  const longTerminal=/\b(?:retired|retirement|withdrawn|withdrawal|walkover|walk-over|defaulted|abandoned|cancelled|canceled)\b/i;
  const statusTerminal=/\b(?:finished|completed|complete|ended|closed|retired|retirement|withdrawn|withdrawal|walkover|walk-over|defaulted|abandoned|cancelled|canceled)\b/i;
  const shortTerminal=/^(?:ret|rtd|ret\.|rtd\.|w\/?o|wo|wd|w\/?d|def)$/i;
  const statusKey=/(?:status|state|result|outcome|reason|decision|note|comment|retir|withdraw|walkover|default|finish|complete|ended|closed|abandon|cancel|winner)/i;
  const terminalFlagKey=/(?:retir|withdraw|walkover|default|finish|complete|ended|closed|abandon|cancel)/i;
  const terminalTimeKey=/(?:finishedAt|completedAt|endedAt|closedAt|retiredAt|withdrawnAt)$/i;
  // SquashScores also uses winner fields to mark terminal states (including
  // retirements).  Match any winner/winning/victor field rather than only a
  // small fixed list of property names.
  const winnerKey=/(?:winner|winning|wonBy|victor)/i;

  const seen=new WeakSet();
  let inspected=0;
  let found='';

  const walk=(value,key='',depth=0)=>{
    if(found||value===null||value===undefined||depth>7||inspected++>800)return;

    if(typeof value==='boolean'){
      if(value&&terminalFlagKey.test(key))found=key;
      return;
    }

    if(typeof value==='number'){
      if(value!==0&&terminalFlagKey.test(key))found=`${key}:${value}`;
      if(Number.isFinite(value)&&winnerKey.test(key)&&value>0)found=`${key}:${value}`;
      return;
    }

    if(typeof value==='string'){
      const text=value.replace(/\s+/g,' ').trim();
      if(!text)return;
      if(longTerminal.test(text)){found=text;return;}
      if(statusKey.test(key)&&statusTerminal.test(text)){found=text;return;}
      if(statusKey.test(key)&&shortTerminal.test(text.replace(/\s+/g,''))){found=text;return;}
      if(terminalTimeKey.test(key)&&!/^0+$/.test(text)){found=`${key}:${text}`;return;}
      if(winnerKey.test(key)&&!/^(?:0|none|null|undefined|tbd)$/i.test(text)){found=`${key}:${text}`;return;}
      return;
    }

    if(typeof value!=='object')return;
    if(seen.has(value))return;
    seen.add(value);

    if(Array.isArray(value)){
      for(const item of value)walk(item,key,depth+1);
      return;
    }

    for(const [childKey,child] of Object.entries(value))walk(child,childKey,depth+1);
  };

  walk(node);
  return found;
}

function squashScoresExplicitlyNotLive(node){
  if(!node||typeof node!=='object')return false;

  const falseLike=v=>v===false||v===0||/^(?:false|0|no|off)$/i.test(String(v??'').trim());
  const trueLike=v=>v===true||v===1||/^(?:true|1|yes|on)$/i.test(String(v??'').trim());

  // Direct live/in-progress flags.  If SquashScores explicitly says false,
  // a partial score is historical/stale and must never be inferred as LIVE.
  const liveFlags=[node.isLive,node.live,node.inProgress,node.isInProgress,node.playing,node.isPlaying];
  if(liveFlags.some(v=>v!==undefined&&v!==null&&falseLike(v)))return true;

  // SquashScores' match-management screen has a "Hide" action. Hidden or
  // inactive matches can remain in the overview JSON with their last partial
  // score even though the public In Progress page no longer shows them.
  // Treat those visibility/activity fields as explicitly not live.
  const hiddenFlags=[
    node.hidden,node.isHidden,node.hide,node.isHiddenFromOverview,
    node.archived,node.isArchived,node.deleted,node.isDeleted,
    node.inactive,node.isInactive
  ];
  if(hiddenFlags.some(v=>v!==undefined&&v!==null&&trueLike(v)))return true;

  const visibleFlags=[
    node.visible,node.isVisible,node.show,node.isShown,node.display,
    node.enabled,node.isEnabled,node.active,node.isActive
  ];
  if(visibleFlags.some(v=>v!==undefined&&v!==null&&falseLike(v)))return true;

  return false;
}

function squashScoresExplicitlyLive(node){
  if(!node||typeof node!=='object')return false;
  const trueLike=v=>v===true||v===1||/^(?:true|1|yes|on)$/i.test(String(v??'').trim());
  const flags=[node.isLive,node.live,node.inProgress,node.isInProgress,node.playing,node.isPlaying];
  if(flags.some(v=>v!==undefined&&v!==null&&trueLike(v)))return true;

  const text=[node.status,node.matchStatus,node.state,node.matchState,node.statusName,node.stateName]
    .filter(v=>typeof v==='string').join(' ');
  return /\b(?:live|playing|in progress|in-progress|on court|started|running)\b/i.test(text);
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
    const raw1=match?.player1GamesWon;
    const raw2=match?.player2GamesWon;
    const p1=raw1===null||raw1===undefined||raw1===''?null:Number(raw1);
    const p2=raw2===null||raw2===undefined||raw2===''?null:Number(raw2);

    if(Number.isFinite(p1)&&Number.isFinite(p2))return [p1,p2];

    let a=0,b=0;
    for(const g of Array.isArray(match?.games)?match.games:[]){
      const x=Number(g?.player1Score),y=Number(g?.player2Score);
      if(!Number.isFinite(x)||!Number.isFinite(y)||x===y)continue;
      if(x>y)a++; else b++;
    }
    return [a,b];
  };

  // First keep the original known-working SquashScores structure.
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
      const hasStarted=score.length>0||p1Won>0||p2Won>0;
      const terminalReason=squashScoresTerminalReason(m);
      const completed=!!terminalReason||p1Won>=3||p2Won>=3||
        (hasStarted&&squashScoresExplicitlyNotLive(m));

      rows.push({
        date,
        time,
        player1,
        player2,
        result:score,
        status:completed?'completed':(hasStarted?'live':'scheduled'),
        squashScoresTerminalReason:terminalReason,
        squashScoresExplicitLive:squashScoresExplicitlyLive(m),
        // A location can be a venue OR a court in SquashScores.  Keep only
        // recognised venue text here; a label such as "4" belongs in court.
        venue:canonicalVenue(
          location?.venueName||location?.locationName||location?.facilityName||
          location?.siteName||location?.name||''
        ),
        court:squashScoresCourtToken(
          m?.courtName||m?.court||m?.resourceName||m?.resource||
          location?.courtName||location?.court||location?.resourceName||
          location?.resource||location?.name||'',
          {allowBareNumber:true}
        ),
        event:String(m?.categoryName||m?.category||'').trim(),
        round:description,
        liveSource:'SquashScores',
        squashScoresMatchId:m?.id||m?.matchId||null
      });
    }
  }

  // Generic fallback.
  //
  // SquashScores has changed its JSON shape before. Instead of guessing the
  // collection/property names, find the SMALLEST JSON objects that contain
  // exactly two known tournament players and a plausible game-score array.
  // This is score extraction only; ssOverlay still requires an existing
  // TournamentSoftware fixture before anything can be displayed.
  const knownPlayers=playerList
    .filter(p=>p?.name&&ssNorm(p.name).length>=5)
    .map(p=>({name:p.name,key:ssNorm(p.name)}))
    .sort((a,b)=>b.key.length-a.key.length);

  const namesInText=text=>{
    const hay=` ${ssNorm(text)} `;
    const found=[];
    for(const p of knownPlayers){
      if(hay.includes(` ${p.key} `)&&!found.some(x=>ssNorm(x)===p.key)){
        found.push(p.name);
        if(found.length===3)break;
      }
    }
    return found;
  };

  const objectDisplayName=v=>{
    if(v===null||v===undefined)return '';
    if(typeof v==='string')return v.trim();
    if(typeof v==='object'){
      return String(
        v.name||v.displayName||v.fullName||v.playerName||
        v.participantName||v.title||v.label||''
      ).trim();
    }
    return '';
  };

  const numericScore=v=>{
    if(v===null||v===undefined||v==='')return null;
    const n=Number(v);
    return Number.isFinite(n)&&n>=0&&n<=40?n:null;
  };

  const scorePairFromGame=g=>{
    if(!g||typeof g!=='object')return null;

    // SquashScores has used both object and compact-array game formats.
    if(Array.isArray(g)){
      if(g.length>=2){
        const a=numericScore(g[0]),b=numericScore(g[1]);
        if(a!==null&&b!==null&&!(a===0&&b===0))return [a,b];
      }
      return null;
    }

    const keyPairs=[
      ['player1Score','player2Score'],
      ['playerOneScore','playerTwoScore'],
      ['player1Points','player2Points'],
      ['playerOnePoints','playerTwoPoints'],
      ['homeScore','awayScore'],
      ['homePoints','awayPoints'],
      ['score1','score2'],
      ['points1','points2'],
      ['team1Score','team2Score'],
      ['p1Score','p2Score'],
      ['p1','p2'],
      ['home','away'],
      ['player1','player2']
    ];

    for(const [aKey,bKey] of keyPairs){
      if(!(aKey in g)||!(bKey in g))continue;
      const a=numericScore(g[aKey]),b=numericScore(g[bKey]);
      if(a===null||b===null||(a===0&&b===0))continue;
      return [a,b];
    }

    for(const key of ['score','scores','points']){
      const value=g[key];
      if(!Array.isArray(value)||value.length<2)continue;
      const a=numericScore(value[0]),b=numericScore(value[1]);
      if(a!==null&&b!==null&&!(a===0&&b===0))return [a,b];
    }

    return null;
  };

  const bestGamePairs=node=>{
    let best=[];

    const walk=(v,depth=0)=>{
      if(v===null||v===undefined||depth>7)return;

      if(Array.isArray(v)){
        const direct=[];
        for(const item of v){
          const pair=scorePairFromGame(item);
          if(pair)direct.push(pair);
        }

        // A squash match has at most five games. Prefer the richest plausible
        // game array.
        if(direct.length&&direct.length<=5&&direct.length>best.length){
          best=direct;
        }

        for(const item of v)walk(item,depth+1);
        return;
      }

      if(typeof v!=='object')return;
      for(const child of Object.values(v))walk(child,depth+1);
    };

    walk(node);
    return best;
  };

  const ownDate=node=>{
    if(!node||typeof node!=='object'||Array.isArray(node))return '';

    for(const key of [
      'matchDate','date','scheduledDate','startDate','dateTime',
      'datetime','scheduledAt','start'
    ]){
      const raw=node[key];
      if(raw===null||raw===undefined||typeof raw==='object')continue;
      const d=canonicalDate(String(raw));
      if(/^\d{4}-\d{2}-\d{2}$/.test(d))return d;
    }

    try{
      const flat=JSON.stringify(node);
      const m=flat.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
      if(m)return `${m[1]}-${m[2]}-${m[3]}`;
    }catch{}

    return '';
  };

  const ownTime=node=>{
    if(!node||typeof node!=='object'||Array.isArray(node))return '';

    for(const key of [
      'matchTime','time','scheduledTime','startTime','description',
      'roundName','round','matchDate','date','scheduledDate','startDate',
      'dateTime','datetime','scheduledAt','start'
    ]){
      const raw=node[key];
      if(raw===null||raw===undefined||typeof raw==='object')continue;
      const m=String(raw).match(/(?:^|[T\s])(\d{1,2}):([0-5]\d)\b/);
      if(m)return `${String(+m[1]).padStart(2,'0')}:${m[2]}`;
    }

    return '';
  };

  const directPlayers=node=>{
    const pairs=[
      ['player1Name','player2Name'],
      ['playerOneName','playerTwoName'],
      ['homePlayerName','awayPlayerName'],
      ['homeName','awayName'],
      ['player1','player2'],
      ['participant1','participant2'],
      ['homePlayer','awayPlayer']
    ];

    for(const [aKey,bKey] of pairs){
      const a=objectDisplayName(node?.[aKey]);
      const b=objectDisplayName(node?.[bKey]);
      if(a&&b)return [canonicalPlayerName(a),canonicalPlayerName(b)];
    }

    for(const key of ['players','participants','competitors']){
      const arr=node?.[key];
      if(!Array.isArray(arr)||arr.length!==2)continue;
      const a=objectDisplayName(arr[0]),b=objectDisplayName(arr[1]);
      if(a&&b)return [canonicalPlayerName(a),canonicalPlayerName(b)];
    }

    return [];
  };

  const fallbackCandidates=[];
  const seenObjects=new WeakSet();

  const normalVenue=value=>{
    const s=objectDisplayName(value)||String(value??'').trim();
    if(/Karrinyup/i.test(s))return 'Karrinyup Shopping Centre';
    if(/Mirrabooka/i.test(s))return 'Squashworld Mirrabooka';
    if(/Belmont/i.test(s))return 'Belmont Saints Squash Centre';
    return '';
  };

  const ownVenue=node=>{
    if(!node||typeof node!=='object'||Array.isArray(node))return '';
    for(const key of ['venueName','locationName','siteName','facilityName','venue','location','site','facility']){
      const value=node[key];
      const v=normalVenue(value);
      if(v)return v;
    }
    // Location wrappers commonly expose only a generic "name" field.
    return normalVenue(node.name||node.title||'');
  };

  const ownCourt=node=>{
    if(!node||typeof node!=='object'||Array.isArray(node))return '';

    // Explicit court/resource fields are allowed to be a bare number because
    // SquashScores uses labels such as 4, 5, 7 for SC4, SC5, SC7.
    for(const key of ['courtName','court','resourceName','resource','fieldName','field']){
      const value=node[key];
      if(value===null||value===undefined)continue;
      const court=squashScoresCourtToken(
        objectDisplayName(value)||String(value),
        {allowBareNumber:true}
      );
      if(court)return court;
    }

    // A SquashScores location wrapper can itself be the court and expose only
    // name: "4".  Parse that label, but still never scan arbitrary match text.
    return squashScoresCourtToken(node.name||node.title||'',{allowBareNumber:true});
  };

  const statusFromNode=(node,games,inheritedTerminal='',inheritedNotLive=false)=>{
    if(inheritedTerminal||squashScoresTerminalReason(node))return 'completed';

    const text=[
      node?.status,node?.matchStatus,node?.state,node?.matchState,
      node?.statusName,node?.stateName
    ].filter(v=>typeof v==='string').join(' ').toLowerCase();

    if(/\b(finished|completed|complete|ended|closed|retired|retirement|withdrawn|withdrawal|walkover|walk-over|defaulted|abandoned|cancelled|canceled)\b/.test(text))return 'completed';
    if(/\b(live|playing|in progress|in-progress|on court|started|running)\b/.test(text))return 'live';
    if(/\b(scheduled|pending|upcoming|not started|not-started|waiting)\b/.test(text))return 'scheduled';

    if(node?.isFinished===true||node?.finished===true||node?.completed===true||node?.isCompleted===true)return 'completed';
    if(node?.isLive===true||node?.inProgress===true||node?.isInProgress===true||node?.started===true)return 'live';

    let p1Games=0,p2Games=0;
    for(const [a,b] of games||[]){
      if(a>b)p1Games++; else if(b>a)p2Games++;
    }
    if(p1Games>=3||p2Games>=3)return 'completed';
    if((games||[]).length&&(inheritedNotLive||squashScoresExplicitlyNotLive(node)))return 'completed';
    if((games||[]).length)return 'live';
    return 'scheduled';
  };

  const scan=(node,inherited={},depth=0)=>{
    if(node===null||node===undefined||depth>14)return;

    if(Array.isArray(node)){
      for(const item of node)scan(item,inherited,depth+1);
      return;
    }

    if(typeof node!=='object')return;
    if(seenObjects.has(node))return;
    seenObjects.add(node);

    const date=ownDate(node)||inherited.date||'';
    const time=ownTime(node)||inherited.time||'';
    const venue=ownVenue(node)||inherited.venue||'';
    const court=ownCourt(node)||inherited.court||'';
    const event=String(node?.categoryName||node?.eventName||node?.category||inherited.event||'').trim();
    const round=String(node?.description||node?.roundName||node?.round||inherited.round||'').replace(/\s+/g,' ').trim();

    let flat='';
    try{flat=JSON.stringify(node)}catch{}

    const direct=directPlayers(node);
    let names=direct;
    const games=bestGamePairs(node);

    // Important for retirements: in some SquashScores payload shapes the
    // terminal/winner flag sits on a match wrapper while the players/games sit
    // in a child object.  The old generic fallback dropped that wrapper state,
    // then saw the child's partial score and recreated the retired match as
    // LIVE.  Carry match-specific terminal state down to its child objects.
    const ownTerminal=squashScoresTerminalReason(node);
    const ownNotLive=squashScoresExplicitlyNotLive(node);
    const ownExplicitLive=squashScoresExplicitlyLive(node);
    const inheritedTerminal=String(inherited?.terminalReason||'');
    const inheritedNotLive=!!inherited?.explicitlyNotLive;
    const inheritedExplicitLive=!!inherited?.explicitlyLive;
    const terminalReason=ownTerminal||inheritedTerminal;
    const explicitlyNotLive=ownNotLive||inheritedNotLive;
    const explicitlyLive=!explicitlyNotLive&&(ownExplicitLive||inheritedExplicitLive);

    // Older/newer API shapes may place the two player objects one level below
    // the score array. Fall back to the tournament-name scan only when the
    // object itself does not expose a direct player pair.
    if(names.length!==2&&flat&&flat.length<=20000){
      names=namesInText(flat);
    }

    const hasMatchIdentity=!!(
      node?.id||node?.matchId||node?.fixtureId||node?.matchDate||node?.date||
      node?.time||node?.matchTime||node?.description||games.length
    );

    if(names.length===2&&(direct.length===2||games.length)&&hasMatchIdentity){
      let ordered=direct.length===2?direct:names.slice();

      if(direct.length!==2&&flat){
        const normFlat=ssNorm(flat);
        ordered=names.slice().sort((a,b)=>
          normFlat.indexOf(ssNorm(a))-normFlat.indexOf(ssNorm(b))
        );
      }

      const p1=ordered[0],p2=ordered[1];
      const result=games.map(([a,b])=>`${a}-${b}`).join(', ');
      const status=statusFromNode(node,games,terminalReason,explicitlyNotLive);

      fallbackCandidates.push({
        date:date||perthTodayIso(),
        time,
        player1:p1,
        player2:p2,
        result,
        status,
        squashScoresTerminalReason:terminalReason,
        squashScoresExplicitLive:explicitlyLive,
        venue,
        court,
        event,
        round,
        liveSource:'SquashScores',
        squashScoresMatchId:node?.id||node?.matchId||node?.fixtureId||null,
        squashScoresGenericFallback:true,
        _rawSize:flat.length||999999
      });
    }

    // Only propagate this node's terminal state when this node looks like a
    // match wrapper.  This avoids a location/category-level flag accidentally
    // being applied to every match below it.
    const matchSpecific=!!(
      direct.length===2||games.length||node?.matchId||node?.fixtureId||
      node?.player1Name||node?.player2Name||node?.playerOneName||node?.playerTwoName
    );
    const childMeta={
      date,time,venue,court,event,round,
      terminalReason:matchSpecific?terminalReason:inheritedTerminal,
      explicitlyNotLive:matchSpecific?explicitlyNotLive:inheritedNotLive,
      explicitlyLive:matchSpecific?explicitlyLive:inheritedExplicitLive
    };
    for(const child of Object.values(node))scan(child,childMeta,depth+1);
  };

  scan(payload);

  // Keep the smallest/richest fallback object for each pair/date/time. Parent
  // containers can contain the same match data as their child match object.
  fallbackCandidates.sort((a,b)=>
    (a._rawSize||999999)-(b._rawSize||999999) ||
    String(b.result||'').length-String(a.result||'').length
  );

  const fallbackMap=new Map();
  for(const row of fallbackCandidates){
    const key=[
      canonicalDate(row.date||''),
      [ssNorm(row.player1),ssNorm(row.player2)].sort().join('|'),
      displayTime24(row.time||'')
    ].join('|');

    if(!fallbackMap.has(key))fallbackMap.set(key,row);
  }

  const genericRows=[...fallbackMap.values()].map(({_rawSize,...x})=>x);

  // Merge generic fallback into the original parser, preferring whichever row
  // actually has score data.
  const merged=new Map();

  const mergeKey=m=>[
    canonicalDate(m.date||''),
    [ssNorm(m.player1),ssNorm(m.player2)].sort().join('|'),
    displayTime24(m.time||'')
  ].join('|');

  for(const row of [...rows,...genericRows]){
    const key=mergeKey(row);
    const prev=merged.get(key);

    if(!prev){
      merged.set(key,row);
      continue;
    }

    const prevRank=(prev.result?1000+String(prev.result).length:0)+
      (prev.status==='completed'?100:prev.status==='live'?50:0);
    const rowRank=(row.result?1000+String(row.result).length:0)+
      (row.status==='completed'?100:row.status==='live'?50:0);

    // Merge the two views instead of discarding terminal metadata from the
    // lower-ranked row. A completed/retired signal must always win over a
    // partial-score LIVE inference.
    const preferred=rowRank>prevRank?{...prev,...row}:{...row,...prev};
    const terminalReason=String(
      row?.squashScoresTerminalReason||prev?.squashScoresTerminalReason||''
    ).trim();
    if(terminalReason){
      preferred.status='completed';
      preferred.squashScoresTerminalReason=terminalReason;
      preferred.squashScoresExplicitLive=false;
    }else if(row?.status==='completed'||prev?.status==='completed'){
      preferred.status='completed';
      preferred.squashScoresExplicitLive=false;
    }else{
      preferred.squashScoresExplicitLive=!!(row?.squashScoresExplicitLive||prev?.squashScoresExplicitLive);
    }
    merged.set(key,preferred);
  }

  const output=[...merged.values()];

  console.log(
    `SquashScores API parser: ${locations.length} location(s) · `+
    `${rows.length} standard row(s) · ${genericRows.length} generic score row(s) · `+
    `${output.filter(m=>m.result).length} scored row(s).`
  );

  return output;
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
    if(n>=1){
      a=a.slice(0,n); b=b.slice(0,n);
      if(!a.every((x,i)=>x===0&&b[i]===0)){
        const pair=a.map((x,i)=>`${x}-${b[i]}`).join(', ');
        return first.name===p1?pair:b.map((x,i)=>`${x}-${a[i]}`).join(', ');
      }
    }
    return '';
  }

  function squashScoresNameIsBold(container,name){
    const wanted=ssNorm(name);
    if(!wanted)return false;

    // SquashScores marks a finished match by bolding a player name. Inspect
    // semantic bold tags plus the common class/style variants used by the site.
    const candidates=container.querySelectorAll(
      'b,strong,[class*="bold" i],[class*="winner" i],[style*="font-weight" i]'
    );
    for(const node of candidates){
      const text=ssNorm(node.textContent||'');
      if(!text||!(` ${text} `).includes(` ${wanted} `))continue;
      const tag=String(node.tagName||'').toLowerCase();
      const cls=String(node.getAttribute?.('class')||'');
      const style=String(node.getAttribute?.('style')||'');
      if(tag==='b'||tag==='strong'||/bold|winner/i.test(cls))return true;
      const weight=(style.match(/font-weight\s*:\s*([^;]+)/i)||[])[1]||'';
      if(/bold/i.test(weight))return true;
      const n=Number(weight);
      if(Number.isFinite(n)&&n>=600)return true;
    }
    return false;
  }

  function addCandidate(el){
    const text=String(el.textContent||'').replace(/\s+/g,' ').trim();
    if(text.length<20||text.length>2600)return;

    // The dedicated SquashScores in-progress page represents the current Perth day
    // and does not always repeat the date/time inside every match container.
    // Use today when the date is omitted; time is optional because the API can
    // enrich it and ssOverlay can still match a unique player pair/day.
    const date=ssDate(text)||perthTodayIso();
    const time=ssTime(text);
    if(!date)return;

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

    const explicitCompleted=/\b(?:finished|completed|won|lost|retired|retirement|withdrawn|withdrawal)\b/i.test(text);
    const boldCompleted=squashScoresNameIsBold(el,p1)||squashScoresNameIsBold(el,p2);
    const explicitLive=/\b(?:live|playing|in progress|on court)\b/i.test(text);

    // SquashScores behaviour: while a match is in progress the player names
    // are not bold and scoring is available. Once a player name becomes bold,
    // the match is complete. Do not treat the mere presence of a score as
    // completion; that was the regression that hid live scoring.
    const completed=explicitCompleted||boldCompleted;
    const live=!completed&&(!!result||explicitLive);

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
  const pair=m=>[ssNorm(m.player1),ssNorm(m.player2)].sort().join('|');
  const date=m=>canonicalDate(m.date||'');
  const time=m=>displayTime24(m.time||'');
  const timeMinutes=v=>{
    const x=String(v||'').match(/^(\d{1,2}):(\d{2})$/);
    return x?Number(x[1])*60+Number(x[2]):null;
  };

  for(const l of live||[]){
    const ld=date(l);if(!ld)continue;
    const same=out.filter(m=>date(m)===ld&&pair(m)===pair(l));
    if(!same.length)continue;

    const lt=timeMinutes(time(l));
    const timed=same.filter(m=>time(m)===time(l));
    let targets=[];

    if(same.length===1){
      targets=[same[0]];
    }else if(lt!==null){
      // TournamentSoftware can leave both the old slot and the moved slot for
      // the same pair/day. Put the SquashScores result on every nearby copy so
      // whichever row the UI de-duplicates/keeps still carries the score.
      // This fixes moved matches such as 12:00 -> 10:10 without allowing a
      // completely unrelated same-pair row many hours away to inherit it.
      targets=same.filter(m=>{
        const mt=timeMinutes(time(m));
        return mt!==null&&Math.abs(mt-lt)<=180;
      });
      if(!targets.length&&timed.length===1)targets=[timed[0]];
    }else if(timed.length===1){
      targets=[timed[0]];
    }

    if(!targets.length)continue;

    for(const existing of targets){
      // TournamentSoftware remains schedule authority. SquashScores only adds
      // live/completed state and scoring to matching official fixtures.
      if(l.result){
        const oriented=orientLiveResultToExisting(existing,l);
        const oldPairs=(String(existing.result||'').match(/\d{1,2}\s*[-–—]\s*\d{1,2}/g)||[]).length;
        const newPairs=(String(oriented||'').match(/\d{1,2}\s*[-–—]\s*\d{1,2}/g)||[]).length;
        if(!existing.result||String(l.status||'').toLowerCase()==='live'||newPairs>=oldPairs){
          existing.result=oriented;
        }
      }
      if(l.status==='completed'||l.status==='live')existing.status=l.status;
      existing.liveSource='SquashScores';
      existing.resultSource='SquashScores';
    }
  }
  return out;
}

async function fetchSquashScoresRequest(url,label){
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),8000);
  try{
    const sep=url.includes('?')?'&':'?';
    const r=await fetch(`${url}${sep}_=${Date.now()}`,{
      cache:'no-store',
      mode:'cors',
      signal:controller.signal
    });
    if(!r.ok)throw new Error(`${label} HTTP ${r.status}`);
    return r;
  }catch(e){
    if(e?.name==='AbortError')throw new Error(`${label} timed out`);
    throw e;
  }finally{
    clearTimeout(timeout);
  }
}

async function fetchSquashScoresHtml(){
  const r=await fetchSquashScoresRequest(SQUASH_SCORES_LIVE_URL,'SquashScores live page');
  return r.text();
}

async function fetchSquashScoresApi(){
  const r=await fetchSquashScoresRequest(SQUASH_SCORES_API_URL,'SquashScores API');
  return r.json();
}

function squashScoresPairDayKey(m){
  return `${canonicalDate(m?.date||'')}|${[ssNorm(m?.player1),ssNorm(m?.player2)].sort().join('|')}`;
}

function enrichSquashScoresHtmlRows(htmlRows,apiRows){
  const apiByPair=new Map();
  for(const row of apiRows||[]){
    const key=squashScoresPairDayKey(row);
    if(!key||key.startsWith('|'))continue;
    if(!apiByPair.has(key))apiByPair.set(key,[]);
    apiByPair.get(key).push(row);
  }

  return (htmlRows||[]).map(htmlRow=>{
    const key=squashScoresPairDayKey(htmlRow);
    const candidates=apiByPair.get(key)||[];
    let apiRow=null;

    if(candidates.length===1){
      apiRow=candidates[0];
    }else if(candidates.length>1&&htmlRow.time){
      const wanted=displayTime24(htmlRow.time||'');
      apiRow=candidates.find(x=>displayTime24(x.time||'')===wanted)||null;
    }

    const result=String(htmlRow.result||apiRow?.result||'').trim();
    const htmlStatus=String(htmlRow.status||'').toLowerCase();

    // The rendered in-progress page is the authority for live/completed state:
    // non-bold player names + scoring = live; bold player name = completed.
    // The API is used only to fill missing score/time/location fields.
    const status=htmlStatus==='completed'?'completed':(result?'live':htmlStatus||'scheduled');

    return {
      ...(apiRow||{}),
      ...htmlRow,
      date:htmlRow.date||apiRow?.date||perthTodayIso(),
      time:htmlRow.time||apiRow?.time||'',
      result,
      status,
      venue:htmlRow.venue||apiRow?.venue||'',
      court:htmlRow.court||apiRow?.court||'',
      event:htmlRow.event||apiRow?.event||'',
      round:htmlRow.round||apiRow?.round||'',
      liveSource:'SquashScores'
    };
  });
}

async function readSquashScoresCurrentFeed(players){
  // Use SquashScores' public overview API as the browser data source.
  // It is the structured data behind the SquashScores overview and contains
  // player names, current game scores and match state. Do not scrape the
  // rendered inprogress.php page from GitHub Pages: cross-origin HTML fetching
  // is fragile and was the reason the previous change could return no rows.
  const payload=await fetchSquashScoresApi();
  return parseSquashScoresApi(payload,players||[]);
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

  const out={
    ...m,
    date,time,
    event:cleanMatchMeta(m.event||m.eventName||m.draw||m.category||m.disciplineName||''),
    round:cleanMatchMeta(m.round||m.roundName||''),
    player1:p1,player2:p2,
    venue:vc.venue,court:vc.court,
    rawText:''
  };

  // A schedule row saying only "Walkover" is not enough evidence that the
  // walkover actually happened. Result authority must come from a result
  // source (TournamentSoftware/SquashScores) or an explicit winner.
  //
  // Apply this safeguard only to today/future so genuine historical records
  // are not rewritten merely because an older snapshot lacks resultSource.
  const today=perthTodayIso();
  const resultText=String(out.result||'').trim();
  const resultSource=String(out.resultSource||'').trim();
  const untrustedWalkover=
    /^walkover$/i.test(resultText) &&
    !out.winner &&
    !/^(?:TournamentSoftware|SquashScores)/i.test(resultSource) &&
    date && date>=today;

  if(untrustedWalkover){
    out.result='';
    out.winner='';
    out.resultSource='';
    if(String(out.status||'').toLowerCase()==='completed')out.status='scheduled';
    out.untrustedResultSuppressed=true;
  }

  return out;
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
  // Live state comes from SquashScores, not from the scheduled clock time.
  // A match becomes live when SquashScores supplies scoring while the match
  // is still in progress. Once SquashScores marks it completed, it is no
  // longer live. This is the same state used by every match view.
  const status=String(m?.status||'').toLowerCase();
  return status==='live';
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
  const start=matchLocalMinuteValue(m);
  const now=perthNowMinuteValue();

  // A fixture whose scheduled start is still in the future can never be a
  // past match, even if stale result/status metadata survived from an older
  // schedule slot.
  if(start!==null&&now<start)return false;

  const status=String(m?.status||'').toLowerCase();
  if(status==='completed'||status==='played')return true;
  if(status!=='live'&&(!!m?.result||!!m?.winner))return true;
  return start!==null&&now>=start+LIVE_MATCH_WINDOW_MINUTES;
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


let livePageReady=false;

function ensureLivePageShell(){
  const nav=document.querySelector('.nav');
  if(nav){
    let link=nav.querySelector('[data-page="live"]');
    if(!link){
      link=document.createElement('a');
      link.href='#live';
      link.dataset.page='live';
      link.className='nav-link';
      link.textContent='Live';
    }

    // Keep Live immediately after Home, even when an older HTML file already
    // contains the Live tab in a different position. insertAdjacentElement
    // moves an existing node, so this also repairs the order without duplicates.
    const home=nav.querySelector('[data-page="home"]');
    if(home)home.insertAdjacentElement('afterend',link);
    else if(!link.isConnected)nav.insertBefore(link,nav.firstChild);
  }

  if(!document.getElementById('live')){
    const main=document.querySelector('main');
    if(main){
      const section=document.createElement('section');
      section.id='live';
      section.className='page';
      section.innerHTML=`
        <div class="compact-page-tools">
          <div class="watch-count">
            <span id="liveMatchCount">0</span>
            <small id="liveMatchCountLabel">matches live</small>
          </div>
        </div>
        <div id="liveMatches" class="tracked-players live-match-list"></div>
      `;

      const courts=document.getElementById('glass');
      if(courts)main.insertBefore(section,courts);
      else main.appendChild(section);
    }
  }
}

function bindPageNavigation(){
  qsa('[data-page]').forEach(a=>{
    if(a.dataset.pageBound==='1')return;
    a.dataset.pageBound='1';
    a.addEventListener('click',e=>{
      e.preventDefault();
      setPage(a.dataset.page);
    });
  });
}

function liveVenueGroup(m){
  const code=venueCode(m);

  if(code==='G')return {
    key:'karrinyup',
    name:'Karrinyup Shopping Centre',
    order:0
  };
  if(code==='B')return {
    key:'belmont',
    name:'Belmont Saints Squash Centre',
    order:1
  };
  if(code==='M')return {
    key:'mirrabooka',
    name:'Squashworld Mirrabooka',
    order:2
  };

  const name=canonicalVenue(m?.venue) ||
    String(m?.venue||'').trim() ||
    'Other venue';

  return {
    key:`other:${name}`,
    name,
    order:99
  };
}

function liveVenueStreamUrl(venueName){
  const rules=Array.isArray(liveStreamConfig?.streams)
    ? liveStreamConfig.streams
    : [];

  const wanted=canonicalVenue(venueName)||String(venueName||'').trim();

  for(const rule of rules){
    const configured=canonicalVenue(rule?.venue)||String(rule?.venue||'').trim();
    if(!configured)continue;

    const sameVenue=
      configured===wanted ||
      (
        /karrinyup/i.test(configured)&&/karrinyup/i.test(wanted)
      ) ||
      (
        /belmont/i.test(configured)&&/belmont/i.test(wanted)
      ) ||
      (
        /mirrabooka/i.test(configured)&&/mirrabooka/i.test(wanted)
      );

    if(!sameVenue)continue;

    const url=normalizeLiveStreamUrl(rule?.url);
    if(url)return url;
  }

  return '';
}

function liveVenueTvButton(venueName){
  const url=liveVenueStreamUrl(venueName);

  if(!url){
    return `<span class="live-venue-tv-button live-venue-tv-loading"
      title="Loading live stream link">
        <span aria-hidden="true">📺</span>
        Live TV
      </span>`;
  }

  // Same behaviour as each match's Watch live button: open the video-only
  // stream window through the existing data-live-video-url click handler.
  return `<button type="button"
    class="live-venue-tv-button live-video-button"
    data-live-video-url="${esc(url)}"
    title="Open ${esc(venueName)} live stream">
      <span aria-hidden="true">📺</span>
      Live TV
    </button>`;
}

// The overview API can retain the last partial score of a match after it has
// been hidden/finished on SquashScores. The public In Progress page does not
// show those rows. Explicit SquashScores live flags always win, but when the
// API gives us only a partial score (no live flag) we limit that inferred-live
// state to two hours after the scheduled start.
const SQUASH_SCORES_INFERRED_LIVE_MAX_MINUTES=120;
function squashScoresFeedRowIsStillLive(m,today=perthTodayIso()){
  const d=canonicalDate(m?.date||'')||today;
  if(d!==today)return false;
  if(String(m?.status||'').toLowerCase()!=='live')return false;
  if(!String(m?.result||'').trim())return false;
  if(String(m?.squashScoresTerminalReason||'').trim())return false;

  if(m?.squashScoresExplicitLive===true)return true;

  const start=matchLocalMinuteValue({...m,date:d});
  const now=perthNowMinuteValue();
  if(start===null||now===null)return true;

  return now>=start-30 && now-start<=SQUASH_SCORES_INFERRED_LIVE_MAX_MINUTES;
}

function currentLiveMatches(){
  const today=perthTodayIso();
  const base=(data.baseMatches||data.matches||[])
    .filter(m=>!m?.playerDetailOnly);

  const pairKey=m=>[ssNorm(m?.player1),ssNorm(m?.player2)].sort().join('|');
  const samePair=(a,b)=>!!a&&!!b&&(
    (sameName(a?.player1,b?.player1)&&sameName(a?.player2,b?.player2))||
    (sameName(a?.player1,b?.player2)&&sameName(a?.player2,b?.player1))
  );
  const minute=v=>{
    const m=displayTime24(v||'').match(/^(\d{1,2}):(\d{2})$/);
    return m?Number(m[1])*60+Number(m[2]):null;
  };

  const enrich=row=>{
    const rowDate=canonicalDate(row?.date||'')||today;
    const same=base.filter(m=>
      canonicalDate(m?.date||'')===rowDate&&
      samePair(m,row)
    );

    let official=null;
    const wantedTime=displayTime24(row?.time||'');
    if(wantedTime){
      official=same.find(m=>displayTime24(m?.time||'')===wantedTime)||null;
    }
    if(!official&&same.length===1)official=same[0];
    if(!official&&same.length>1&&wantedTime){
      const wanted=minute(wantedTime);
      if(wanted!==null){
        const ranked=same
          .map(m=>({m,diff:Math.abs((minute(m?.time||'')??99999)-wanted)}))
          .sort((a,b)=>a.diff-b.diff);
        if(ranked[0]&&ranked[0].diff<=180)official=ranked[0].m;
      }
    }

    // If SquashScores formatted one player name differently, use the parsed
    // court plus one matching player and the nearest time as a conservative
    // venue-enrichment fallback.  This never creates/removes a live match; it
    // only attaches the official venue/court to an already-live SquashScores row.
    if(!official){
      const liveCourt=squashScoresCourtToken(row?.court||'',{allowBareNumber:true});
      const wanted=minute(wantedTime);
      if(liveCourt&&wanted!==null){
        const onePlayer=base.filter(m=>{
          if(canonicalDate(m?.date||'')!==rowDate)return false;
          const baseCourt=normalizeLiveStreamCourt(actualCourt(m)||m?.court||'');
          if(baseCourt!==normalizeLiveStreamCourt(liveCourt))return false;
          return (
            sameName(m?.player1,row?.player1)||sameName(m?.player2,row?.player1)||
            sameName(m?.player1,row?.player2)||sameName(m?.player2,row?.player2)
          );
        });
        const ranked=onePlayer
          .map(m=>({m,diff:Math.abs((minute(m?.time||'')??99999)-wanted)}))
          .sort((a,b)=>a.diff-b.diff);
        if(ranked[0]&&ranked[0].diff<=180&&(!ranked[1]||ranked[0].diff<ranked[1].diff)){
          official=ranked[0].m;
        }
      }
    }

    // SquashScores is the source of truth for the Live page.  TournamentSoftware
    // is used only to enrich the row with official event/player IDs/location when
    // a corresponding fixture exists.  A SquashScores live match is NEVER hidden
    // merely because the official schedule copy is missing/moved/stale.
    if(!official){
      return normalizeSelfMatchAsBye(normaliseMatch({
        ...row,
        date:rowDate,
        status:'live',
        liveSource:'SquashScores',
        resultSource:'SquashScores'
      }));
    }

    return normalizeSelfMatchAsBye(normaliseMatch({
      ...official,
      date:rowDate||official.date,
      time:row.time||official.time,
      // A numeric SquashScores location such as "4" is a court label, not
      // a venue. Prefer the official venue unless SquashScores names one of the
      // three tournament venues explicitly.
      venue:canonicalVenue(row.venue)||official.venue,
      court:squashScoresCourtToken(row.court||'',{allowBareNumber:true})||official.court,
      event:official.event||row.event,
      round:official.round||row.round,
      result:row.result?orientLiveResultToExisting(official,row):(official.result||''),
      status:'live',
      liveSource:'SquashScores',
      resultSource:'SquashScores',
      squashScoresMatchId:row.squashScoresMatchId||official.squashScoresMatchId||null
    }));
  };

  const liveRows=(squashScoresLatestFeed||[])
    .filter(m=>{
      const d=canonicalDate(m?.date||'')||today;
      const terminalText=[
        m?.status,m?.matchStatus,m?.state,m?.matchState,
        m?.statusName,m?.stateName,m?.round,m?.liveRawText
      ].filter(v=>typeof v==='string').join(' ');
      const terminal=!!String(m?.squashScoresTerminalReason||'').trim()||
        /\b(?:retired|retirement|ret|rtd|withdrawn|withdrawal|walkover|walk-over|defaulted|abandoned|cancelled|canceled|finished|completed)\b/i.test(terminalText);
      return d===today&&
        !terminal&&
        squashScoresFeedRowIsStillLive(m,today);
    });

  const deduped=new Map();
  for(const row of liveRows){
    const key=String(row?.squashScoresMatchId||'').trim()||[
      canonicalDate(row?.date||'')||today,
      pairKey(row)
    ].join('|');
    const prev=deduped.get(key);
    if(!prev||String(row?.result||'').length>=String(prev?.result||'').length){
      deduped.set(key,row);
    }
  }

  return [...deduped.values()]
    .map(enrich)
    .sort((a,b)=>{
      const av=liveVenueGroup(a),bv=liveVenueGroup(b);
      if(av.order!==bv.order)return av.order-bv.order;
      if(av.name!==bv.name)return av.name.localeCompare(bv.name);
      return to24(a.time||'').localeCompare(to24(b.time||''));
    });
}

function liveVicParkPlayerCard(p,name,id,tracked=false,scoreClass=''){
  const displayName=playerListDisplayName(name)||'TBD';
  const tbd=isTbdName(name);
  const tag=tbd?'div':'a';
  const href=tbd?'':` href="${playerPageUrl(name,id||p?.officialPlayerId||'')}"`;
  const rankRaw=p?.squashLevelsWorldRank;
  const world=(rankRaw===null||rankRaw===undefined||String(rankRaw).trim()==='')
    ? ''
    : (/^tbd$/i.test(String(rankRaw).trim())?'TBD':squashMetric(rankRaw));
  const level=p?.squashLevelsLevel?squashMetric(p.squashLevelsLevel):'';
  const metrics=[
    world?`<span class="live-vic-world">World ${world}</span>`:'',
    level?`<span class="live-vic-level">Level ${level}${p?.squashLevelsLevelProvisional?' (P)':''}</span>`:''
  ].filter(Boolean).join('');

  return `<${tag}${href} class="live-vic-player-card ${tracked?'vic-tracked-player':''} ${scoreClass}">
    <span class="live-vic-player-name">${esc(displayName)}</span>
    <span class="live-vic-player-meta">
      <span class="live-vic-flag">${flagImg(p)}</span>
      <span class="live-vic-country">${esc(p?.country||'')}</span>
      ${metrics}
    </span>
  </${tag}>`;
}

function liveVicParkMatchRow(m,trackedNames=[]){
  const p1=playerForMatchSide(m,1),p2=playerForMatchSide(m,2);
  const p1Tracked=trackedNames.some(n=>sameName(n,m.player1));
  const p2Tracked=trackedNames.some(n=>sameName(n,m.player2));
  const state=scoreGameState(m);
  const p1Class=state.finished&&state.winnerSide===1?'match-winner-player':(state.finished&&state.winnerSide?'match-loser-player':'');
  const p2Class=state.finished&&state.winnerSide===2?'match-winner-player':(state.finished&&state.winnerSide?'match-loser-player':'');
  const ageGroupLabel=matchAgeGroupLabel(m,p1,p2);
  const v=venueVisual(m);
  const live=isMatchCurrent(m);

  return `<article class="vic-match-row live-page-match-row ${isPast(m)?'past':''} ${live?'match-live':''} ${state.finished?'match-finished':''}">
    <div class="vic-time live-vic-time">
      <span class="vic-time-value">${live?'<span class="live-match-dot" title="Match currently in progress" aria-label="Live"></span>':''}${esc(displayTime24(m.time))}</span>
      <span class="vic-time-age">${esc(ageGroupLabel)}</span>
      ${liveVideoButton(m)}
    </div>
    <div class="vic-match-main live-vic-main">
      <div class="live-vic-fixture-line">
        ${liveVicParkPlayerCard(p1,m.player1,m.player1Id,p1Tracked,p1Class)}
        <span class="vic-vs">vs</span>
        ${liveVicParkPlayerCard(p2,m.player2,m.player2Id,p2Tracked,p2Class)}
      </div>
      ${matchScoreSummary(m)}
    </div>
    <div class="vic-location" title="${esc(v.place)}">${v.code?`<span class="venue-letter venue-${v.code.toLowerCase()}" aria-hidden="true">${v.code}</span>`:''}<span>${esc(v.place)}</span></div>
  </article>`;
}

function renderLivePage(){
  const target=qs('#liveMatches');
  if(!target)return;

  mirrorVicParkStylesToLive();

  const matches=currentLiveMatches();
  const count=qs('#liveMatchCount');
  const label=qs('#liveMatchCountLabel');

  if(count)count.textContent=matches.length;
  if(label)label.textContent=matches.length===1?'match live':'matches live';

  // Always render every tournament venue, even if no match is currently live.
  // Order is intentional: Karrinyup -> Belmont -> Mirrabooka.
  const groups=[
    {
      key:'karrinyup',
      name:'Karrinyup Shopping Centre',
      order:0,
      matches:[]
    },
    {
      key:'belmont',
      name:'Belmont Saints Squash Centre',
      order:1,
      matches:[]
    },
    {
      key:'mirrabooka',
      name:'Squashworld Mirrabooka',
      order:2,
      matches:[]
    }
  ];

  const byKey=new Map(groups.map(group=>[group.key,group]));

  for(const m of matches){
    const venue=liveVenueGroup(m);
    const known=byKey.get(venue.key);

    if(known){
      known.matches.push(m);
      continue;
    }

    // Keep an unexpected venue visible rather than silently dropping it.
    let other=groups.find(group=>group.key===venue.key);
    if(!other){
      other={...venue,matches:[]};
      groups.push(other);
    }
    other.matches.push(m);
  }

  groups.sort((a,b)=>
    a.order-b.order || a.name.localeCompare(b.name)
  );

  let html='';

  for(const group of groups){
    html+=`
      <div class="vic-day-heading live-venue-heading">
        <div class="live-venue-title-wrap">
          <strong>${esc(group.name)}</strong>
          ${liveVenueTvButton(group.name)}
        </div>
      </div>
    `;

    if(group.matches.length){
      // Use the exact same match-card renderer and state styling as the
      // Courts/Vic Park views so the Live page stays visually consistent.
      // IMPORTANT: Live deliberately uses the SAME renderer as Vic Park.
      // Do not maintain a separate Live match-card renderer: the mobile Vic Park
      // CSS moves time/location/age into .vic-mobile-meta, and that markup must
      // exist on Live as well.
      html+=group.matches
        .map(m=>compactScheduleRow(m,VIC_PARK_PLAYERS||[]))
        .join('');
    }else{
      html+=`
        <div class="schedule-empty live-venue-empty">
          No matches currently running.
        </div>
      `;
    }
  }

  target.innerHTML=html;
}

function mirrorVicParkStylesToLive(){
  // The site's newest Vic Park layout contains selectors scoped to #vicpark
  // and #trackedPlayers.  Live uses the same card markup, so mirror those
  // scoped rules instead of maintaining a second, slightly different layout.
  // This keeps Live pixel-for-pixel in step with future Vic Park CSS changes.
  const old=document.getElementById('wsm-live-vicpark-mirror-styles');
  if(old)old.remove();

  const out=[];
  const rewriteSelector=selector=>{
    if(!/(#vicpark\b|#trackedPlayers\b)/.test(selector||''))return '';
    return String(selector)
      .replace(/#vicpark\b/g,'#live')
      .replace(/#trackedPlayers\b/g,'#liveMatches');
  };

  const copyRules=rules=>{
    let text='';
    for(const rule of Array.from(rules||[])){
      try{
        if(rule.selectorText){
          const selectors=String(rule.selectorText)
            .split(',')
            .map(x=>rewriteSelector(x.trim()))
            .filter(Boolean);
          if(selectors.length)text+=`${selectors.join(',')}{${rule.style.cssText}}`;
          continue;
        }

        if(rule.cssRules){
          const inner=copyRules(rule.cssRules);
          if(!inner)continue;
          const css=String(rule.cssText||'');
          const open=css.indexOf('{');
          const prefix=open>=0?css.slice(0,open).trim():'';
          if(prefix)text+=`${prefix}{${inner}}`;
        }
      }catch{}
    }
    return text;
  };

  for(const sheet of Array.from(document.styleSheets||[])){
    try{
      // Do not mirror our own generated sheets back into themselves.
      if(sheet.ownerNode?.id==='wsm-live-page-styles'||
         sheet.ownerNode?.id==='wsm-live-vicpark-mirror-styles')continue;
      const css=copyRules(sheet.cssRules);
      if(css)out.push(css);
    }catch{
      // Cross-origin stylesheets are intentionally ignored. The tournament
      // site's own styles.css is same-origin and remains readable here.
    }
  }

  if(out.length){
    const style=document.createElement('style');
    style.id='wsm-live-vicpark-mirror-styles';
    style.textContent=out.join('\n');
    document.head.appendChild(style);
  }
}

function ensureLivePageStyles(){
  if(document.getElementById('wsm-live-page-styles')){
    mirrorVicParkStylesToLive();
    return;
  }

  const style=document.createElement('style');
  style.id='wsm-live-page-styles';
  style.textContent=`
    #live .live-venue-heading{
      margin-top:18px;
    }

    #live .live-venue-heading:first-child{
      margin-top:0;
    }

    #live .live-venue-title-wrap{
      display:inline-flex;
      align-items:center;
      justify-content:flex-start;
      gap:8px;
      width:auto;
      max-width:100%;
    }

    #live .live-venue-title-wrap strong{
      min-width:0;
      flex:0 1 auto;
    }

    #live .live-venue-tv-button{
      display:inline-flex!important;
      align-items:center;
      justify-content:center;
      gap:6px;
      flex:0 0 auto;
      min-height:27px;
      padding:5px 9px;
      border:1px solid rgba(32,177,90,.58);
      border-radius:999px;
      background:rgba(32,177,90,.16);
      color:#31d56f;
      font:inherit;
      font-size:.72rem;
      font-weight:850;
      line-height:1;
      cursor:pointer;
      white-space:nowrap;
      visibility:visible!important;
      opacity:1!important;
      text-decoration:none;
      appearance:none;
      -webkit-appearance:none;
    }


    #live .live-venue-tv-button:hover{
      background:rgba(32,177,90,.17);
      border-color:rgba(32,177,90,.62);
    }

    #live .live-venue-tv-loading{
      opacity:.72!important;
      cursor:default;
    }

    #live .live-venue-empty{
      margin-bottom:10px;
    }

    /* Live match cards deliberately use the same visual language as the
       Vic Park cards: framed players, compact time/age block and score bar. */
    #live .live-page-match-row{
      display:grid!important;
      grid-template-columns:92px minmax(0,1fr) minmax(210px,300px)!important;
      gap:18px!important;
      align-items:center!important;
      min-height:134px;
      padding:16px 20px 12px!important;
      margin-bottom:9px!important;
      border:1px solid var(--line)!important;
      border-radius:16px!important;
      background:linear-gradient(145deg,rgba(18,42,72,.96),rgba(9,26,46,.96))!important;
      box-sizing:border-box;
    }

    #live .live-page-match-row .live-vic-time{
      display:flex;
      flex-direction:column;
      align-items:center;
      justify-content:center;
      align-self:center;
      min-width:0;
      color:var(--gold);
      text-align:center;
      font-family:Montserrat,Inter,sans-serif;
    }

    #live .live-page-match-row .vic-time-value{
      display:inline-flex;
      align-items:center;
      justify-content:center;
      gap:5px;
      font-size:1.16rem;
      font-weight:900;
      line-height:1.05;
      white-space:nowrap;
    }

    #live .live-page-match-row .vic-time-age{
      display:block!important;
      margin-top:4px;
      color:#8797ae;
      font-size:.69rem;
      font-weight:900;
      line-height:1.05;
      text-transform:uppercase;
      white-space:nowrap;
      letter-spacing:.01em;
    }

    #live .live-page-match-row .live-vic-main{
      display:flex;
      flex-direction:column;
      justify-content:center;
      min-width:0;
      align-self:stretch;
    }

    #live .live-vic-fixture-line{
      display:grid!important;
      grid-template-columns:minmax(0,1fr) 18px minmax(0,1fr)!important;
      gap:8px!important;
      align-items:center!important;
      min-width:0;
    }

    #live .live-vic-player-card{
      display:flex!important;
      flex-direction:column;
      justify-content:center;
      min-width:0;
      min-height:72px;
      padding:8px 11px!important;
      border:1px solid rgba(132,151,179,.23)!important;
      border-radius:10px!important;
      background:rgba(255,255,255,.025)!important;
      color:var(--text)!important;
      text-decoration:none!important;
      box-sizing:border-box;
      overflow:hidden;
    }

    #live .live-vic-player-card.vic-tracked-player{
      border-color:rgba(245,200,76,.58)!important;
      background:rgba(245,200,76,.025)!important;
    }

    #live .live-vic-player-card:hover{
      border-color:rgba(245,200,76,.42)!important;
      transform:none!important;
    }

    #live .live-vic-player-name{
      display:block;
      min-width:0;
      overflow:hidden;
      text-overflow:ellipsis;
      white-space:nowrap;
      color:#f3f6fb;
      font-family:Montserrat,Inter,sans-serif;
      font-size:1.04rem;
      font-weight:900;
      line-height:1.05;
      letter-spacing:-.015em;
    }

    #live .live-vic-player-meta{
      display:flex;
      align-items:center;
      min-width:0;
      gap:5px;
      margin-top:6px;
      color:#d6deea;
      font-size:.70rem;
      line-height:1;
      white-space:nowrap;
    }

    #live .live-vic-flag{
      display:inline-flex;
      align-items:center;
      flex:0 0 auto;
    }

    #live .live-vic-flag .inline-flag{
      width:28px!important;
      height:19px!important;
      object-fit:cover;
      border-radius:2px;
      box-shadow:0 0 0 1px rgba(255,255,255,.16);
    }

    #live .live-vic-country{
      max-width:112px;
      overflow:hidden;
      text-overflow:ellipsis;
      color:#d6deea;
    }

    #live .live-vic-world{
      color:var(--gold);
      font-weight:800;
    }

    #live .live-vic-level{
      color:#e0e5ed;
      font-weight:500;
    }

    #live .live-vic-fixture-line>.vic-vs{
      justify-self:center;
      color:#72839a;
      font-size:.67rem;
      font-weight:900;
      text-transform:lowercase;
    }

    #live .live-vic-main .match-history-score{
      display:flex!important;
      align-items:center!important;
      flex-wrap:wrap;
      gap:6px!important;
      min-height:27px;
      margin-top:8px!important;
      padding-top:8px!important;
      border-top:1px solid rgba(255,255,255,.075)!important;
      color:#cbd4e1;
      font-size:.86rem;
      line-height:1.05;
    }

    #live .live-vic-main .match-history-score-label{
      color:#8291a6;
      font-size:.69rem;
      font-weight:900;
      letter-spacing:.05em;
      text-transform:uppercase;
    }

    #live .live-vic-main .match-history-score>strong,
    #live .live-vic-main .match-history-score .match-live-games strong,
    #live .live-vic-main .match-history-score .match-winner-label strong{
      color:var(--gold);
      font-size:.96rem;
      font-weight:900;
    }

    #live .live-vic-main .match-winner-label{
      color:#cbd4e1;
    }

    #live .live-page-match-row .vic-location{
      justify-self:end!important;
      display:flex!important;
      align-items:center!important;
      justify-content:flex-end!important;
      gap:9px!important;
      min-width:0;
      color:#b9c8d7!important;
      text-align:right!important;
      font-size:.78rem!important;
      line-height:1.3!important;
    }

    #live .live-page-match-row .vic-location>span:last-child{
      min-width:0;
      overflow:hidden;
      text-overflow:ellipsis;
      white-space:nowrap;
    }

    #live .live-page-match-row .vic-location .venue-letter{
      width:38px!important;
      height:38px!important;
      flex:0 0 auto;
      border-radius:9px;
    }

    #live .live-page-match-row.match-finished .match-loser-player .live-vic-player-name{
      font-weight:600;
      opacity:.82;
    }

    #live .live-page-match-row.match-finished .match-winner-player .live-vic-player-name{
      font-weight:900;
      opacity:1;
    }

    @media(max-width:900px){
      #live .live-page-match-row{
        grid-template-columns:78px minmax(0,1fr)!important;
      }
      #live .live-page-match-row .vic-location{
        grid-column:2;
        justify-self:start!important;
        justify-content:flex-start!important;
        margin-top:5px;
        text-align:left!important;
      }
    }

    /* Keep the complete main menu inside narrow phone screens.  The old
       flex row could become wider than the viewport after the Live tab was
       added, which left the final Courts tab only partly visible. */
    @media(max-width:570px){
      .topbar{
        width:100%;
        max-width:100vw;
        box-sizing:border-box;
        overflow-x:hidden;
      }
      .topbar .nav{
        display:grid!important;
        grid-auto-flow:column;
        grid-auto-columns:minmax(0,1fr);
        width:100%!important;
        max-width:100%!important;
        min-width:0!important;
        gap:2px!important;
        padding:0!important;
        margin:0!important;
        overflow:visible!important;
        box-sizing:border-box;
      }
      .topbar .nav .nav-link{
        display:flex;
        align-items:center;
        justify-content:center;
        min-width:0!important;
        width:auto!important;
        max-width:none!important;
        padding:8px 3px!important;
        font-size:.68rem!important;
        line-height:1.05!important;
        text-align:center;
        white-space:normal!important;
        box-sizing:border-box;
      }
      .topbar .nav .nav-vic-label{
        display:flex!important;
        flex-direction:column;
        gap:0!important;
        line-height:1.02!important;
        white-space:normal!important;
      }
    }

    /* The exact Vic Park renderer is shared by Vic Park and Live. On compact
       layouts the desktop .vic-time column is hidden, so surface Watch live in
       the same mobile metadata strip that contains time, venue and age. */
    .vic-mobile-watch{display:none}
    @media(max-width:1180px){
      #vicpark .vic-mobile-watch,
      #live .vic-mobile-watch{
        display:inline-flex!important;
        align-items:center!important;
        flex:0 0 auto!important;
        margin-left:auto!important;
      }
      #vicpark .vic-mobile-watch .live-video-button,
      #live .vic-mobile-watch .live-video-button{
        display:inline-flex!important;
        align-items:center!important;
        justify-content:center!important;
        min-height:20px!important;
        margin:0!important;
        padding:2px 6px!important;
        border-radius:6px!important;
        font-size:.56rem!important;
        line-height:1!important;
        white-space:nowrap!important;
      }
      #vicpark .vic-mobile-watch .live-video-button-dot,
      #live .vic-mobile-watch .live-video-button-dot{
        width:6px!important;
        height:6px!important;
        margin-right:4px!important;
      }
    }

    @media(max-width:650px){
      #live .live-page-match-row{
        grid-template-columns:1fr!important;
        gap:9px!important;
        min-height:0;
        padding:13px 12px!important;
      }
      /* Vic Park's mobile stylesheet hides/rearranges the desktop .vic-time
         block. Live uses its own framed-player renderer, so explicitly keep
         the same three essentials visible on phones: time, age group and
         Watch live. !important is intentional here because the mirrored
         #vicpark mobile rules can themselves be !important. */
      #live .live-page-match-row .live-vic-time{
        display:grid!important;
        visibility:visible!important;
        opacity:1!important;
        width:100%!important;
        grid-template-columns:auto auto minmax(0,1fr)!important;
        align-items:center!important;
        gap:7px!important;
        justify-content:stretch!important;
        justify-items:start!important;
        text-align:left!important;
        margin:0!important;
      }
      #live .live-page-match-row .live-vic-time .vic-time-value{
        display:inline-flex!important;
        visibility:visible!important;
        opacity:1!important;
        font-size:.96rem!important;
        white-space:nowrap!important;
      }
      #live .live-page-match-row .live-vic-time .vic-time-age{
        display:inline-flex!important;
        visibility:visible!important;
        opacity:1!important;
        margin:0!important;
        font-size:.67rem!important;
        white-space:nowrap!important;
      }
      #live .live-page-match-row .live-vic-time .live-video-button{
        display:inline-flex!important;
        visibility:visible!important;
        opacity:1!important;
        justify-self:end!important;
        margin:0!important;
        padding:6px 8px!important;
        font-size:.66rem!important;
        white-space:nowrap!important;
      }
      #live .live-vic-fixture-line{
        grid-template-columns:minmax(0,1fr) 14px minmax(0,1fr)!important;
        gap:5px!important;
      }
      #live .live-vic-player-card{
        min-height:78px;
        padding:8px!important;
      }
      #live .live-vic-player-name{
        font-size:.84rem;
      }
      #live .live-vic-player-meta{
        display:grid;
        grid-template-columns:auto minmax(0,1fr);
        gap:3px 5px;
        white-space:normal;
        font-size:.62rem;
      }
      #live .live-vic-world,
      #live .live-vic-level{
        grid-column:2;
      }
      #live .live-vic-country{
        max-width:100%;
      }
      #live .live-page-match-row .vic-location{
        grid-column:1;
        margin-top:0;
      }
      #live .live-page-match-row .vic-location .venue-letter{
        width:30px!important;
        height:30px!important;
      }
    }

  `;
  document.head.appendChild(style);
  mirrorVicParkStylesToLive();
}

ensureLivePageShell();
ensureLivePageStyles();
bindPageNavigation();

let playersRendered=false,glassReady=false,vicParkReady=false,favoritesReady=false,liveReady=false;
function showLoading(id){
  const target=
    id==='players'?qs('#playerGrid'):
    id==='glass'?qs('#glassMatches'):
    id==='vicpark'?qs('#trackedPlayers'):
    id==='favorites'?qs('#favoriteMatches'):
    id==='live'?qs('#liveMatches'):
    null;

  if(target&&!target.innerHTML.trim()){
    target.innerHTML='<div class="schedule-empty">Loading…</div>';
  }
}
async function setPage(id){
  qsa('.page').forEach(p=>p.classList.toggle('active-page',p.id===id));
  qsa('[data-page]').forEach(a=>a.classList.toggle('active',a.dataset.page===id));
  history.replaceState(null,'','#'+id);
  scrollTo({top:0,behavior:'smooth'});
  try{
    if(['glass','vicpark','favorites','live'].includes(id)){
      startSquashScoresPolling();
      // Hash navigation does not reload index.html. Re-read live-streams.json
      // whenever a match page is opened so changed video URLs take effect now.
      await loadLiveStreamConfig({rerenderPage:false});
    }
    if(id==='players'&&!playersRendered){showLoading(id);await ensurePlayersData();renderPlayers();playersRendered=true;}
    if(id==='glass'&&!glassReady){showLoading(id);await ensureMatchesData();setupGlass();glassReady=true;}
    if(id==='vicpark'&&!vicParkReady){showLoading(id);await ensureVicParkData();setupVicPark();vicParkReady=true;}
    if(id==='favorites'){showLoading(id);await ensureMatchesData();renderFavoritePlayers();favoritesReady=true;}
    if(id==='live'){
      showLoading(id);
      await ensureMatchesData();
      renderLivePage();
      liveReady=true;
    }
  }catch(e){console.error(e);showDataError(id,e);}
}
function showDataError(id,e){
  const target=
    id==='players'?qs('#playerGrid'):
    id==='glass'?qs('#glassMatches'):
    id==='favorites'?qs('#favoriteMatches'):
    id==='live'?qs('#liveMatches'):
    qs('#trackedPlayers');

  if(target){
    target.innerHTML=`<div class="schedule-empty"><strong>Could not load tournament data.</strong><br>${esc(e?.message||e)}</div>`;
  }
}
bindPageNavigation();


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

function scoreGameState(m){
  const games=[...String(m?.result||'').matchAll(/(\d{1,2})\s*[-–—]\s*(\d{1,2})/g)]
    .map(x=>[Number(x[1]),Number(x[2])]);

  const wonGame=(a,b)=>{
    if(!Number.isFinite(a)||!Number.isFinite(b)||a===b)return 0;
    const hi=Math.max(a,b),lo=Math.min(a,b);

    // Squash games are won at 11 by at least two points. At 10-all play
    // continues until one player leads by two, e.g. 12-10, 15-13.
    const complete=
      hi>=11 &&
      (hi===11 ? lo<=9 : hi-lo===2);

    if(!complete)return 0;
    return a>b?1:2;
  };

  let p1Games=0,p2Games=0;
  for(const [a,b] of games){
    const winner=wonGame(a,b);
    if(winner===1)p1Games++;
    else if(winner===2)p2Games++;
  }

  const status=String(m?.status||'').toLowerCase();
  const live=status==='live';
  const finished=
    status==='completed' ||
    status==='played' ||
    (!live&&Math.max(p1Games,p2Games)>=3);

  let winnerSide=0;

  if(finished&&m?.winner){
    if(sameName(m.winner,m.player1))winnerSide=1;
    else if(sameName(m.winner,m.player2))winnerSide=2;
  }

  if(!winnerSide&&finished&&p1Games!==p2Games){
    winnerSide=p1Games>p2Games?1:2;
  }

  return {
    p1Games,
    p2Games,
    gamesText:games.length?`${p1Games}:${p2Games}`:'',
    winnerSide,
    finished,
    live
  };
}

function scoreWinnerInfo(m){
  const state=scoreGameState(m);
  if(!state.finished||!state.winnerSide){
    return {name:'',games:state.gamesText};
  }

  return {
    name:state.winnerSide===1?String(m?.player1||''):String(m?.player2||''),
    games:state.gamesText
  };
}

function scoreWinnerName(m){
  return scoreWinnerInfo(m).name;
}


let liveStreamConfig={streams:[]};
let liveStreamConfigLoaded=false;
let liveStreamConfigRequestId=0;

function normalizeLiveStreamCourt(v){
  const s=String(v||'').replace(/\s+/g,' ').trim();
  if(!s)return '';

  let m=s.match(/\bSC\s*(\d+)\b/i);
  if(m)return `SC${Number(m[1])}`;

  m=s.match(/\bCourt\s*(\d+)\b/i);
  if(m)return `SC${Number(m[1])}`;

  m=s.match(/\bAGC\s*(\d+)?\b/i);
  if(m)return m[1]?`AGC${Number(m[1])}`:'AGC';

  return s.toUpperCase();
}

function normalizeLiveStreamUrl(v){
  const s=String(v||'').trim();
  const match=s.match(/https:\/\/\S+/i);
  return match?match[0]:'';
}

function liveStreamVenueMatches(ruleVenue,m){
  const rule=String(ruleVenue||'').toLowerCase();

  // Use the SAME venue classification as the rest of the site. This is much
  // safer than depending on whichever raw venue/court fields happened to be
  // present on a particular TournamentSoftware/SquashScores row.
  const code=venueCode(m);

  if(rule.includes('karrinyup'))return code==='G';
  if(rule.includes('mirrabooka'))return code==='M';
  if(rule.includes('belmont'))return code==='B';

  const venueText=`${m?.venue||''} ${m?.rawText||''}`.toLowerCase();
  return !!rule&&venueText.includes(rule);
}

function liveStreamForMatch(m){
  if(!isMatchCurrent(m))return '';

  const rules=Array.isArray(liveStreamConfig?.streams)
    ? liveStreamConfig.streams
    : [];

  const venue=venueCode(m);
  const matchCourt=normalizeLiveStreamCourt(actualCourt(m)||m?.court||'');

  for(const rule of rules){
    const url=normalizeLiveStreamUrl(rule?.url);
    if(!url)continue;
    if(!liveStreamVenueMatches(rule.venue,m))continue;

    // Karrinyup has one streamed court. Any live Karrinyup match uses the
    // Karrinyup stream regardless of the court value in the JSON or match.
    if(venue==='G')return url;

    // Belmont and Mirrabooka must match BOTH venue and configured court.
    const configuredCourt=normalizeLiveStreamCourt(rule?.court||'');
    if(!configuredCourt||!matchCourt)continue;
    if(configuredCourt!==matchCourt)continue;

    return url;
  }

  return '';
}

function liveVideoButton(m){
  const url=liveStreamForMatch(m);
  if(!url){
    if(
      isMatchCurrent(m) &&
      venueCode(m)==='G'
    ){
      console.debug('Live video: Karrinyup live match has no matching configured URL',{
        venue:m?.venue||'',
        court:m?.court||''
      });
    }
    return '';
  }

  return `<button type="button"
    class="live-video-button"
    data-live-video-url="${esc(url)}"
    title="Open live video">
      <span class="live-video-button-dot" aria-hidden="true"></span>
      Watch live
    </button>`;
}

function openLiveVideoWindow(url,existingPopup=null){
  if(!url)return;

  const popup=existingPopup||window.open(
    '',
    'wsmLiveVideo',
    'popup=yes,width=1180,height=760,resizable=yes,scrollbars=no'
  );
  if(!popup)return;

  const html=`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Live Video</title>
<style>
  *{box-sizing:border-box}
  html,body{
    margin:0;
    width:100%;
    height:100%;
    background:#000;
    overflow:hidden;
  }
  video{
    display:block;
    width:100%;
    height:100%;
    object-fit:contain;
    background:#000;
  }
</style>
</head>
<body>
<video id="video" controls autoplay muted playsinline></video>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js"><\/script>
<script>
(function(){
  const url=${JSON.stringify(url)};
  const video=document.getElementById('video');

  if(video.canPlayType('application/vnd.apple.mpegurl')){
    video.src=url;
  }else if(window.Hls&&Hls.isSupported()){
    const hls=new Hls({enableWorker:true,lowLatencyMode:true});
    hls.loadSource(url);
    hls.attachMedia(video);
  }
})();
<\/script>
</body>
</html>`;

  popup.document.open();
  popup.document.write(html);
  popup.document.close();
  popup.focus();
}

async function loadLiveStreamConfig({rerenderPage=true}={}){
  // The stream URLs expire/change during the tournament.  On the published
  // site read the JSON directly from the repository first instead of trusting
  // the GitHub Pages copy, which can lag behind a commit at the CDN layer.
  // The same-origin file remains a fallback, and file:// keeps the JS mirror.
  const requestId=++liveStreamConfigRequestId;

  const applyConfig=(json,source)=>{
    if(requestId!==liveStreamConfigRequestId)return liveStreamConfig;
    liveStreamConfig={streams:Array.isArray(json?.streams)?json.streams:[]};
    liveStreamConfigLoaded=true;
    console.info(`Live stream config refreshed from ${source}: ${liveStreamConfig.streams.length} stream(s)`);
    return liveStreamConfig;
  };

  const rerender=()=>{
    if(!rerenderPage||requestId!==liveStreamConfigRequestId)return;
    const page=location.hash.slice(1)||'home';
    if(page==='vicpark'&&vicParkReady)setupVicPark();
    else if(page==='glass'&&glassReady)renderFeatureCourt(selectedFeatureDate);
    else if(page==='favorites')renderFavoritePlayers();
    else if(page==='live')renderLivePage();
  };

  const fetchJson=async(url,label)=>{
    const sep=url.includes('?')?'&':'?';
    const response=await fetch(`${url}${sep}streamRefresh=${Date.now()}`,{
      cache:'no-store',
      mode:'cors',
      headers:{'Cache-Control':'no-cache','Pragma':'no-cache'}
    });
    if(!response.ok)throw new Error(`${label} HTTP ${response.status}`);
    return response.json();
  };

  if(location.protocol!=='file:'){
    const sources=[
      ['https://raw.githubusercontent.com/RogerSchmidlin/WorldSquashMasters2026/main/live-streams.json','GitHub live-streams.json'],
      ['live-streams.json','site live-streams.json']
    ];

    for(const [url,label] of sources){
      try{
        const config=applyConfig(await fetchJson(url,label),label);
        rerender();
        return config;
      }catch(e){
        console.warn(`${label} unavailable:`,e?.message||e);
      }
    }
  }

  try{
    if(location.protocol==='file:'){
      window.LIVE_STREAM_CONFIG=undefined;
      await loadScriptOnce(`live-streams.js?streamRefresh=${Date.now()}`);
    }
    if(window.LIVE_STREAM_CONFIG){
      const config=applyConfig(window.LIVE_STREAM_CONFIG,'live-streams.js fallback');
      rerender();
      return config;
    }
  }catch(e){
    console.warn('live-streams.js fallback unavailable:',e?.message||e);
  }

  if(requestId===liveStreamConfigRequestId){
    liveStreamConfig={streams:[]};
    liveStreamConfigLoaded=true;
  }
  rerender();
  return liveStreamConfig;
}

function ensureLiveVideoStyles(){
  if(document.getElementById('wsm-live-video-styles'))return;

  const style=document.createElement('style');
  style.id='wsm-live-video-styles';
  style.textContent=`
    .vic-time .live-video-button{
      display:inline-flex;
      align-items:center;
      justify-content:center;
      gap:6px;
      margin-top:7px;
      padding:6px 9px;
      border:1px solid rgba(32,177,90,.42);
      border-radius:999px;
      background:rgba(32,177,90,.10);
      color:#20b15a;
      font:inherit;
      font-size:.70rem;
      font-weight:800;
      cursor:pointer;
      white-space:nowrap;
    }
    .vic-time .live-video-button:hover{
      background:rgba(32,177,90,.17);
      border-color:rgba(32,177,90,.62);
    }
    .live-video-button-dot{
      width:6px;
      height:6px;
      border-radius:50%;
      background:#20b15a;
      box-shadow:0 0 0 3px rgba(32,177,90,.14);
    }
  `;
  document.head.appendChild(style);
}

ensureLiveVideoStyles();

document.addEventListener('click',event=>{
  const button=event.target.closest?.('.live-video-button[data-live-video-url]');
  if(!button)return;
  openLiveVideoWindow(button.dataset.liveVideoUrl||'');
});


loadLiveStreamConfig();

function matchScoreSummary(m){
  if(!canShowPublishedResult(m))return '';
  if(!m?.result&&!m?.winner)return '';

  const state=scoreGameState(m);
  const showScoreLiveIndicator=state.live&&!m?.hideScoreLiveIndicator;

  return `<div class="match-history-score has-score ${state.live?'live-score-block':''}">
    ${m.result
      ? `<span class="match-history-score-label ${showScoreLiveIndicator?'live-score-label':''}">
          <span>Score</span>
          ${showScoreLiveIndicator
            ? `<span class="live-score-indicator" aria-label="Live match">
                <span class="live-score-dot" aria-hidden="true"></span>
                LIVE
              </span>`
            : ''}
        </span>
        <strong>${esc(m.result)}</strong>`
      : ''}
    ${state.live&&state.gamesText
      ? `<span class="match-live-games">Games <strong>${esc(state.gamesText)}</strong></span>`
      : ''}
    ${state.finished&&state.winnerSide
      ? `<span class="match-winner-label">Winner: <strong>${esc(state.winnerSide===1?m.player1:m.player2)}${state.gamesText?` ${esc(state.gamesText)}`:''}</strong></span>`
      : ''}
  </div>`;
}

function ensureLiveScoreStyles(){
  if(document.getElementById('wsm-live-score-styles'))return;

  const style=document.createElement('style');
  style.id='wsm-live-score-styles';
  style.textContent=`
    @keyframes wsmLivePulse{
      0%,100%{opacity:1;transform:scale(1)}
      50%{opacity:.35;transform:scale(.78)}
    }

    .live-score-label{
      display:inline-flex;
      flex-direction:column;
      align-items:flex-start;
      gap:2px;
    }

    .live-score-indicator{
      display:inline-flex;
      align-items:center;
      gap:5px;
      color:#20b15a;
      font-size:.68rem;
      font-weight:800;
      letter-spacing:.08em;
      line-height:1;
    }

    .live-score-dot{
      width:7px;
      height:7px;
      border-radius:50%;
      background:#20b15a;
      box-shadow:0 0 0 3px rgba(32,177,90,.14);
      animation:wsmLivePulse 1.15s ease-in-out infinite;
    }

    .match-live-games{
      white-space:nowrap;
    }

    .match-finished .match-loser-player .player-name-stack > b,
    .match-finished .match-loser-player .fixture-mobile-name{
      font-weight:500 !important;
      opacity:.78;
    }

    .match-finished .match-winner-player .player-name-stack > b,
    .match-finished .match-winner-player .fixture-mobile-name{
      font-weight:850 !important;
      opacity:1;
    }

    @media (prefers-reduced-motion: reduce){
      .live-score-dot{animation:none}
    }
  `;
  document.head.appendChild(style);
}

ensureLiveScoreStyles();

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

function compactScheduleRow(m,trackedNames=[],options={}){
  const p1=playerForMatchSide(m,1), p2=playerForMatchSide(m,2);
  const ageGroupLabel=matchAgeGroupLabel(m,p1,p2);
  const p1Tracked=trackedNames.some(n=>sameName(n,m.player1));
  const p2Tracked=trackedNames.some(n=>sameName(n,m.player2));
  const v=venueVisual(m);
  const live=isMatchCurrent(m);
  const showLiveIndicator=live&&!options.hideLiveIndicator;
  const scoreState=scoreGameState(m);
  const p1Winner=scoreState.finished&&scoreState.winnerSide===1;
  const p2Winner=scoreState.finished&&scoreState.winnerSide===2;
  const liveButton=liveVideoButton(m);
  return `<article class="vic-match-row ${isPast(m)?'past':''} ${live?'match-live':''} ${scoreState.finished?'match-finished':''} ${options.livePage?'live-page-match-row':''}">
    <div class="vic-time"><span class="vic-time-value">${showLiveIndicator?'<span class="live-match-dot" title="Match currently in progress" aria-label="Live"></span>':''}${esc(displayTime24(m.time))}</span><span class="vic-time-age">${esc(ageGroupLabel)}</span>${liveButton}</div>
    <div class="vic-match-main">
      <div class="vic-event"><span class="vic-mobile-meta"><span class="vic-mobile-time">${showLiveIndicator?'<span class="live-match-dot" title="Match currently in progress" aria-label="Live"></span>':''}${esc(displayTime24(m.time))}</span><span class="vic-mobile-location">${venueBadge(m)}<span class="vic-mobile-location-text">${esc(cleanVenuePlace(m))}</span></span><span class="vic-mobile-age">${esc(ageGroupLabel)}</span>${liveButton?`<span class="vic-mobile-watch">${liveButton}</span>`:''}</span><span class="vic-desktop-event"><span class="vic-event-category">${esc(ageGroupLabel)}</span>${m.round?`<span class="vic-event-round"> · ${esc(m.round)}</span>`:''}</span></div>
      <div class="vic-fixture-line">
        <a class="${p1Tracked?'vic-tracked-player':''} ${p1Winner?'match-winner-player':(scoreState.finished&&scoreState.winnerSide?'match-loser-player':'')}" href="${playerPageUrl(m.player1,m.player1Id)}">
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
        <a class="${p2Tracked?'vic-tracked-player':''} ${p2Winner?'match-winner-player':(scoreState.finished&&scoreState.winnerSide?'match-loser-player':'')}" href="${playerPageUrl(m.player2,m.player2Id)}">
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
      ${matchScoreSummary(options.hideLiveIndicator?{...m,hideScoreLiveIndicator:true}:m)}
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

    // History is a record of matches that are actually known to have been
    // played. A stale scheduled row from an old draw/schedule snapshot must
    // never appear as a past match merely because its stored date is old.
    // This is especially important when TournamentSoftware later moves a
    // fixture: the obsolete old slot can otherwise sit in History while the
    // real fixture is still upcoming.
    if(d&&d<today){
      const status=String(m?.status||'').toLowerCase();
      const verifiedPast=
        status==='completed' ||
        status==='played' ||
        !!String(m?.result||'').trim() ||
        !!String(m?.winner||'').trim();

      if(verifiedPast)history.push(row);
      continue;
    }

    upcoming.push(row);
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


const SQUASH_SCORES_RESULT_CACHE_KEY='wsm2026SquashScoresCompletedScoresV1';

function squashScoresCacheKey(m){
  return `${canonicalDate(m?.date||'')}|${[ssNorm(m?.player1),ssNorm(m?.player2)].sort().join('|')}`;
}
function loadSquashScoresCompletedCache(){
  try{
    const rows=JSON.parse(localStorage.getItem(SQUASH_SCORES_RESULT_CACHE_KEY)||'[]');
    const today=perthTodayIso();
    return Array.isArray(rows)?rows.filter(m=>
      canonicalDate(m?.date||'')===today &&
      String(m?.status||'').toLowerCase()==='completed' &&
      !!String(m?.result||'').trim()
    ):[];
  }catch{return []}
}
function saveSquashScoresCompletedCache(rows){
  try{
    const today=perthTodayIso();
    const completed=(rows||[]).filter(m=>
      canonicalDate(m?.date||'')===today &&
      String(m?.status||'').toLowerCase()==='completed' &&
      !!String(m?.result||'').trim()
    );
    localStorage.setItem(SQUASH_SCORES_RESULT_CACHE_KEY,JSON.stringify(completed));
  }catch{}
}
function mergeSquashScoresSnapshot(rows){
  const today=perthTodayIso();
  const map=new Map();

  // Completed scores are retained for the rest of the Perth day, even if
  // SquashScores removes that finished match from the live overview. Live rows
  // are NEVER retained when absent from the newest successful poll.
  for(const old of loadSquashScoresCompletedCache())map.set(squashScoresCacheKey(old),old);

  for(const row of rows||[]){
    if(canonicalDate(row?.date||'')!==today)continue;
    const status=String(row?.status||'').toLowerCase();
    const key=squashScoresCacheKey(row);
    if(!key||key.startsWith('|'))continue;
    if(status==='live')map.set(key,row);
    else if(status==='completed'&&String(row?.result||'').trim())map.set(key,row);
  }

  const merged=[...map.values()];
  saveSquashScoresCompletedCache(merged);
  return merged;
}

let squashScoresPollTimer=null;
let squashScoresLatestFeed=[];
let squashScoresLatestLive=loadSquashScoresCompletedCache();
let squashScoresLatestFingerprint=squashScoresFingerprint(squashScoresLatestLive);
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
    const known=[...(data.players||[]),...(vicParkPlayers||[])];
    const uniq=[];const seen=new Set();
    for(const p of known){
      const k=ssNorm(p?.name);
      if(k&&!seen.has(k)){seen.add(k);uniq.push(p)}
    }

    // Poll the SquashScores public overview API every cycle. It is the
    // structured source used for live scores/state; the polling loop itself is
    // self-scheduled so slow requests cannot pile up and freeze updates.
    const live=await readSquashScoresCurrentFeed(uniq);
    // Keep the complete newest SquashScores response separately. The Live page
    // renders directly from this feed so no current match can be lost because
    // TournamentSoftware has a stale/moved/missing copy of the fixture.
    squashScoresLatestFeed=(live||[]).map(m=>({...m,date:canonicalDate(m?.date||'')||perthTodayIso()}));

    console.log(
      `SquashScores API feed: ${live.length} row(s), `+
      `${live.filter(m=>m.result).length} with scores, `+
      `${live.filter(m=>String(m.status||'').toLowerCase()==='live'&&m.result).length} live scored match(es), `+
      `${live.filter(m=>String(m.status||'').toLowerCase()==='completed').length} completed match(es).`
    );

    const snapshot=mergeSquashScoresSnapshot(live);
    const fingerprint=squashScoresFingerprint(snapshot);
    const fullPagesChanged=fingerprint!==squashScoresLatestFingerprint;

    // Courts/Fav/Vic Park all consume the same current SquashScores snapshot.
    // A successful empty poll clears old LIVE rows but retains today's explicitly
    // completed scored rows so recent results do not disappear.
    squashScoresLatestLive=snapshot;
    squashScoresLatestFingerprint=fingerprint;

    let vicUpdated=false;

    if(vicParkDataReady){
      vicParkMatches=ssOverlay(window.__vicParkBaseMatches||vicParkMatches,snapshot)
        .map(normaliseMatch)
        .map(normalizeSelfMatchAsBye);
      squashScoresLastVicParkFingerprint=fingerprint;
      vicUpdated=true;
    }

    const page=location.hash.slice(1)||'home';
    if(page==='glass'&&glassReady&&fullPagesChanged){
      renderFeatureCourt(selectedFeatureDate);
    }else if(page==='favorites'&&fullPagesChanged){
      renderFavoritePlayers();
    }else if(page==='vicpark'&&vicParkReady&&vicUpdated){
      setupVicPark();
    }else if(page==='live'){
      // Live is intentionally re-rendered after every successful poll, even
      // when the count stays the same, because an individual game score may
      // have changed while the same players remain on court.
      renderLivePage();
    }
  }catch(e){
    console.warn('SquashScores live unavailable:',e?.message||e);
  }
}

let squashScoresPollingStarted=false;
let squashScoresPollInFlight=false;

async function squashScoresPollTick(){
  if(squashScoresPollTimer){
    clearTimeout(squashScoresPollTimer);
    squashScoresPollTimer=null;
  }

  if(document.visibilityState==='visible'&&!squashScoresPollInFlight){
    squashScoresPollInFlight=true;
    try{
      await updateSquashScoresLive();
    }finally{
      squashScoresPollInFlight=false;
    }
  }

  // Self-schedule after each completed attempt. Unlike setInterval, a slow or
  // hung network request cannot create overlapping polls and eventually stall
  // the browser. fetchSquashScoresRequest also aborts any request after 8 s.
  squashScoresPollTimer=setTimeout(squashScoresPollTick,SQUASH_SCORES_POLL_MS);
}

function startSquashScoresPolling(){
  if(squashScoresPollingStarted)return;
  squashScoresPollingStarted=true;
  squashScoresPollTick();
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState!=='visible')return;
    if(squashScoresPollTimer){
      clearTimeout(squashScoresPollTimer);
      squashScoresPollTimer=null;
    }
    if(!squashScoresPollInFlight)squashScoresPollTick();
  });
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
  ensureLivePageShell();
  bindPageNavigation();

  const initial=location.hash.slice(1);
  if(['players','glass','vicpark','favorites','live'].includes(initial))await setPage(initial);
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
