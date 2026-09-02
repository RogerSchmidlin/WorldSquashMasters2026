
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

const qs=s=>document.querySelector(s), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
function loadPlayerScript(src){return new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=()=>reject(new Error(`Could not load ${src}`));document.head.appendChild(s);});}

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

function startAutomaticSyncRefresh(summary){
  const loadedSummary=summary||window.TOURNAMENT_SUMMARY||{};
  autoRefreshLoadedToken=syncTokenFromSummary(loadedSummary);
  const loadedRefreshMs=Date.parse(String(loadedSummary?.refreshedAt||''))||0;
  const STALE_RELOAD_MS=30*60*1000;

  const check=async()=>{
    if(document.visibilityState==='hidden')return;
    const latest=await fetchLatestSyncToken();
    if(!latest||latest==='|')return;

    const latestRefresh=latest.split('|')[0]||'';
    const latestRefreshMs=Date.parse(latestRefresh)||0;
    if(!latestRefreshMs||!loadedRefreshMs)return;
    if(latestRefreshMs-loadedRefreshMs<=STALE_RELOAD_MS)return;

    const reloadKey=`wsm2026ReloadedForSync:${latestRefresh}`;
    try{
      if(sessionStorage.getItem(reloadKey)==='1')return;
      sessionStorage.setItem(reloadKey,'1');
    }catch{}
    location.reload();
  };

  setInterval(check,AUTO_REFRESH_CHECK_MS);
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='visible')check();
  });
}

async function loadPlayerDetailData(){
  try{
    await Promise.all([
      loadPlayerScript('summary-data.js'),
      loadPlayerScript('players-data.js'),
      loadPlayerScript('matches-data.js')
    ]);
    if(!Array.isArray(window.TOURNAMENT_PLAYERS)||!Array.isArray(window.TOURNAMENT_MATCHES))throw new Error('Split data files were incomplete');
    return {...(window.TOURNAMENT_SUMMARY||{}),players:window.TOURNAMENT_PLAYERS,matches:window.TOURNAMENT_MATCHES};
  }catch(e){
    await loadPlayerScript('data.js');
    if(!window.TOURNAMENT_DATA)throw e;
    return window.TOURNAMENT_DATA;
  }
}
async function initPlayerPage(){
  const data=await loadPlayerDetailData();
  startAutomaticSyncRefresh(data);


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
renderHeaderRefresh();
const basicNorm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[’‘]/g,"'").toLowerCase().replace(/[^a-z0-9']+/g,' ').trim();
const nameKey=s=>{let v=String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[’‘]/g,"'").trim();v=v.replace(/\[[^\]]*\]/g,' ').replace(/\((?:[A-Z]{2,3}|\d+)\)/g,' ').replace(/\b(?:AUS|ENG|SCO|WAL|SUI|NZL|USA|CAN|FRA|GER|DEU|IRL|RSA|IND|JPN|MAS|SGP|HKG)\b/gi,' ');if(v.includes(',')){const p=v.split(',').map(x=>x.trim()).filter(Boolean);if(p.length===2)v=p[1]+' '+p[0];}return v.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/).filter(Boolean).sort().join(' ')};
const sameName=(a,b)=>!!a&&!!b&&(basicNorm(a)===basicNorm(b)||nameKey(a)===nameKey(b));
const flatText=v=>{try{return typeof v==='string'?v:JSON.stringify(v)}catch{return String(v||'')}};
const playerNeedles=(data.players||[]).map(p=>({p,key:basicNorm(p.name)})).sort((a,b)=>b.key.length-a.key.length);
function canonicalDate(v){if(!v)return '';const s=String(v).trim();let m=s.match(/^(\d{4})-(\d{2})-(\d{2})/);if(m)return `${m[1]}-${m[2]}-${m[3]}`;m=s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/);if(m)return `${m[3]}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;const d=new Date(s);if(!Number.isNaN(d.getTime()))return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;return s;}

const SQUASH_SCORES_LIVE_URL='https://www.squashscores.com/inprogress.php?categoryId=19&hideControls=1&tourname=World+Squash+Masters+2026';
const SQUASH_SCORES_API_URL='https://squashscores.com/api/overview/public/?categoryId=19';
const SQUASH_SCORES_POLL_MS=5000;
// Restored known-good SquashScores overlay used before the Live-page regressions.

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
  for(const v of ['Squashworld Mirrabooka','Belmont Squash Centre','Karrinyup Shopping Centre']){
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
      const completed=p1Won>=3||p2Won>=3;
      const hasStarted=score.length>0||p1Won>0||p2Won>0;

      rows.push({
        date,
        time,
        player1,
        player2,
        result:score,
        status:completed?'completed':(hasStarted?'live':'scheduled'),
        venue:String(location?.name||location?.locationName||'').trim(),
        court:String(m?.courtName||m?.court||'').trim(),
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
    const values=[];
    for(const key of ['courtName','court','resourceName','resource','fieldName','field']){
      const value=node[key];
      if(value!==null&&value!==undefined)values.push(objectDisplayName(value)||String(value));
    }
    values.push(String(node.name||''));
    for(const value of values){
      let m=String(value||'').match(/\bSC\s*(\d+)\b/i);
      if(m)return `SC${Number(m[1])}`;
      m=String(value||'').match(/\bAGC\s*(\d+)?\b/i);
      if(m)return m[1]?`AGC${Number(m[1])}`:'AGC';
      m=String(value||'').match(/\bCourt\s*(\d+)\b/i);
      if(m)return `SC${Number(m[1])}`;
    }
    return '';
  };

  const statusFromNode=(node,games)=>{
    const text=[
      node?.status,node?.matchStatus,node?.state,node?.matchState,
      node?.statusName,node?.stateName
    ].filter(v=>typeof v==='string').join(' ').toLowerCase();

    if(/\b(finished|completed|complete|final|ended|closed)\b/.test(text))return 'completed';
    if(/\b(live|playing|in progress|in-progress|on court|started|running)\b/.test(text))return 'live';
    if(/\b(scheduled|pending|upcoming|not started|not-started|waiting)\b/.test(text))return 'scheduled';

    if(node?.isFinished===true||node?.finished===true||node?.completed===true||node?.isCompleted===true)return 'completed';
    if(node?.isLive===true||node?.inProgress===true||node?.isInProgress===true||node?.started===true)return 'live';

    let p1Games=0,p2Games=0;
    for(const [a,b] of games||[]){
      if(a>b)p1Games++; else if(b>a)p2Games++;
    }
    if(p1Games>=3||p2Games>=3)return 'completed';
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
      const status=statusFromNode(node,games);

      fallbackCandidates.push({
        date:date||perthTodayIso(),
        time,
        player1:p1,
        player2:p2,
        result,
        status,
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

    const childMeta={date,time,venue,court,event,round};
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

    if(rowRank>prevRank)merged.set(key,{...prev,...row});
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

    const explicitCompleted=/\b(?:finished|completed|won|lost)\b/i.test(text);
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

function perthTodayIso(){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Perth',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const get=t=>parts.find(x=>x.type===t)?.value||'';
  return `${get('year')}-${get('month')}-${get('day')}`;
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

function squashScoresFingerprint(rows){
  return JSON.stringify((rows||[]).map(m=>[
    canonicalDate(m.date||''),displayTime24(m.time||''),
    ssNorm(m.player1),ssNorm(m.player2),String(m.status||''),
    String(m.result||''),String(m.venue||''),String(m.court||''),
    String(m.originalTime||''),!!m.timeMoved
  ]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
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


function namesFromRecord(m){const text=' '+basicNorm(flatText(m))+' ';const found=[];for(const x of playerNeedles){if(x.key.length>4&&text.includes(' '+x.key+' ')){found.push(x.p.name);if(found.length===2)break}}return found}
function cleanMatchMeta(v){
  const s=String(v||'').replace(/\s+/g,' ').trim();
  if(!s)return '';
  if(s.length>70)return '';
  if((s.match(/\|/g)||[]).length>1)return '';
  if((s.match(/\b[A-Z][A-Za-z'-]+\s+[A-Z][A-Za-z'-]+\b/g)||[]).length>2)return '';
  return s;
}
function normMatch(m){const raw=flatText(m.rawText||m.text||m.description||m);let p1=m.player1||m.playerOne||m.homePlayer||m.home||m.participant1||m.team1||m.entry1||'',p2=m.player2||m.playerTwo||m.awayPlayer||m.away||m.participant2||m.team2||m.entry2||'';const gn=v=>typeof v==='object'&&v?(v.name||v.displayName||v.fullName||v.title||v.label||''):String(v||'');p1=gn(p1);p2=gn(p2);if(!p1||!p2){const f=namesFromRecord(m);if(!p1)p1=f[0]||'';if(!p2)p2=f.find(n=>!sameName(n,p1))||f[1]||''}let venue=m.venue||m.venueName||m.location||m.locationName||m.site||m.facility||'',court=m.court||m.courtName||m.resource||m.resourceName||m.field||m.fieldName||'';if(typeof venue==='object')venue=venue.name||venue.title||venue.label||'';if(typeof court==='object')court=court.name||court.title||court.label||'';if(!venue){if(/Karrinyup/i.test(raw))venue='Karrinyup Shopping Centre';else if(/Mirrabooka/i.test(raw))venue='Squashworld Mirrabooka'}if(!court){const cm=raw.match(/(?:court(?:Name)?["':\s]*|\b)(AGC(?:\s*\d+)?|SC\s*\d+|Court\s*\d+)\b/i);if(cm)court=cm[1]}return {...m,date:canonicalDate(m.date||m.matchDate||m.startDate||m.start||m.datetime||m.dateTime||m.scheduledDate),time:m.time||m.matchTime||m.startTime||m.scheduledTime||'',event:cleanMatchMeta(m.event||m.eventName||m.draw||m.category||m.disciplineName||''),round:cleanMatchMeta(m.round||m.roundName||''),player1:p1,player2:p2,venue,court,rawText:''}}
data.matches=(data.matches||[]).map(normMatch);
const tournamentBaseMatches=data.matches.map(m=>({...m}));
const params=new URLSearchParams(location.search);
const requestedId=params.get('id')||'';
const requested=params.get('name')||'';
const requestedById=requestedId
  ? data.players.find(x=>String(x.officialPlayerId||'')===String(requestedId))
  : null;
const requestedByName=data.players.filter(x=>sameName(x.name,requested));
const p=requestedById||(requestedByName.length===1?requestedByName[0]:null);
const name=p?.name||requested;
const officialPlayerId=p?.officialPlayerId||requestedId;
const sameDisplayedNamePlayers=data.players.filter(x=>sameName(x.name,name));
const duplicateDisplayedName=sameDisplayedNamePlayers.length>1;
const playerPageUrl=(n,id='')=>{
  const byId=id?data.players.find(x=>String(x.officialPlayerId||'')===String(id)):null;
  const same=data.players.filter(x=>sameName(x.name,n));
  const px=(byId&&sameName(byId.name,n))?byId:(same.length===1?same[0]:null);
  const q=new URLSearchParams();
  if(px?.officialPlayerId)q.set('id',px.officialPlayerId);
  q.set('name',px?.name||n||'');
  return `player.html?${q.toString()}`;
};
const flagImg=(x,cls='inline-flag')=>x?.flagCode?`<img class="${cls}" src="https://flagcdn.com/w160/${x.flagCode}.png" alt="${esc(x.country)} flag">`:'<span class="flag-fallback">🌐</span>';
const squashMetric=v=>{const n=Number(String(v??'').replace(/,/g,''));return Number.isFinite(n)&&n>0?n.toLocaleString('en-AU'):esc(v)};
const rankBadge=x=>{
  if(!x)return '';
  const raw=x.squashLevelsWorldRank;
  if(raw===null||raw===undefined||String(raw).trim()==='')return '';
  const text=/^tbd$/i.test(String(raw).trim())?'TBD':squashMetric(raw);
  return `<span class="world-rank" title="SquashLevels world ranking">World ${text}</span>`;
};
const levelBadge=x=>{
  if(!x||!x.squashLevelsLevel)return '';
  return `<span class="squash-level" title="SquashLevels level">Level ${squashMetric(x.squashLevelsLevel)}${x.squashLevelsLevelProvisional?' (P)':''}</span>`;
};
const squashBadges=x=>`<span class="squash-metrics">${rankBadge(x)}${levelBadge(x)}</span>`;
const playerNameStack=(x,n,current=false)=>`<span class="player-name-stack"><b class="${current?'vic-tracked-name':''}">${esc(n||'TBD')}</b>${squashBadges(x)}</span>`;
const isTbdNamePlayer=n=>/^TBD$/i.test(String(n||'').trim());
const isByeNamePlayer=n=>/^Bye$/i.test(String(n||'').trim());
const isPlayerByeMatch=m=>
  !!m?.deterministicBye ||
  String(m?.status||'').toLowerCase()==='bye' ||
  isByeNamePlayer(m?.player1) ||
  isByeNamePlayer(m?.player2);
const fmt=d=>{const x=new Date(d+'T12:00:00');return Number.isNaN(x.getTime())?{long:esc(d),day:''}:{long:x.toLocaleDateString('en-AU',{day:'numeric',month:'long'}),day:x.toLocaleDateString('en-AU',{weekday:'short'})}};
const has=(m,n)=>{
  const idMatch=officialPlayerId&&(
    String(m.player1Id||'')===String(officialPlayerId)||
    String(m.player2Id||'')===String(officialPlayerId)
  );
  if(idMatch)return true;

  // Name fallback is safe only when this displayed name is unique. For
  // duplicates such as Daniel Jones 35+ / Daniel Jones 40+, official ID is
  // required so the two schedules can never bleed into one another.
  if(duplicateDisplayedName)return false;

  return sameName(m.player1,n)||sameName(m.player2,n);
};
const opp=m=>{
  if(officialPlayerId){
    if(String(m.player1Id||'')===String(officialPlayerId))return m.player2;
    if(String(m.player2Id||'')===String(officialPlayerId))return m.player1;
  }
  if(!duplicateDisplayedName){
    if(sameName(m.player1,name))return m.player2;
    if(sameName(m.player2,name))return m.player1;
  }
  return namesFromRecord(m).find(n=>!sameName(n,name))||'';
};
function matchContextAgeGenderPlayer(m){
  const raw=String(m?.event||m?.eventName||m?.draw||m?.category||'');
  const age=(raw.match(/\b(35|40|45|50|55|60|65|70|75|80|85)\+?\b/)||[])[1]||'';
  const gender=/women/i.test(raw)?'women':(/\bmen/i.test(raw)?'men':'');
  return {age,gender};
}
function playerGenderKeyPlayer(v){
  const s=String(v||'').toLowerCase();
  if(/female|women|woman|\bf\b/.test(s))return 'women';
  if(/male|men|man|\bm\b/.test(s))return 'men';
  return '';
}
function playerForDetailMatchSide(m,side){
  const n=side===2?m?.player2:m?.player1;
  const id=side===2?m?.player2Id:m?.player1Id;

  if(isByeNamePlayer(n)||isTbdNamePlayer(n))return null;

  if(id){
    const byId=data.players.find(x=>String(x.officialPlayerId||'')===String(id));
    if(byId&&sameName(byId.name,n))return byId;
  }

  const candidates=data.players.filter(x=>sameName(x.name,n));
  if(candidates.length===1)return candidates[0];
  if(candidates.length<=1)return candidates[0]||null;

  const ctx=matchContextAgeGenderPlayer(m);
  let pool=candidates;

  if(ctx.age){
    const ageMatches=pool.filter(x=>{
      const a=(String(x.ageGroup??'').match(/\b(35|40|45|50|55|60|65|70|75|80|85)\b/)||[])[1]||'';
      return a===ctx.age;
    });
    if(ageMatches.length)pool=ageMatches;
  }

  if(ctx.gender){
    const genderMatches=pool.filter(x=>playerGenderKeyPlayer(x.gender)===ctx.gender);
    if(genderMatches.length)pool=genderMatches;
  }

  return pool.length===1?pool[0]:null;
}
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

function currentMatch(m){
  const status=String(m?.status||'').toLowerCase();
  if(status==='live')return true;
  if(status==='completed'||status==='played'||m?.result)return false;
  const start=matchLocalMinuteValue(m);
  if(start===null)return false;
  const now=perthNowMinuteValue();
  return now>=start&&now<start+LIVE_MATCH_WINDOW_MINUTES;
}

function canShowPublishedResult(m){
  const d=canonicalDate(m?.date||'');
  const parts=new Intl.DateTimeFormat('en-CA',{
    timeZone:'Australia/Perth',year:'numeric',month:'2-digit',day:'2-digit'
  }).formatToParts(new Date());
  const get=t=>parts.find(x=>x.type===t)?.value||'';
  const today=`${get('year')}-${get('month')}-${get('day')}`;
  const status=String(m?.status||'').toLowerCase();
  if(status==='live')return true;
  if(d&&d>today)return false;
  return status==='completed'||status==='played'||!!m?.result||!!m?.winner;
}

const past=m=>{
  const start=matchLocalMinuteValue(m);
  const now=perthNowMinuteValue();

  // Never style an upcoming fixture as past just because stale result/status
  // metadata survived from an earlier schedule slot.
  if(start!==null&&now<start)return false;

  const status=String(m?.status||'').toLowerCase();
  if(status==='completed'||status==='played')return true;
  if(status!=='live'&&!!m?.result)return true;
  return start!==null&&now>=start+LIVE_MATCH_WINDOW_MINUTES;
};
function displayTime24(t){const raw=String(t||'').trim();if(!raw)return 'TBD';let m=raw.match(/\b(\d{1,2})(?::(\d{2}))?\s*([AP]M)\b/i);if(m){let h=Number(m[1])%12;if(/^p/i.test(m[3]))h+=12;return `${String(h).padStart(2,'0')}:${m[2]||'00'}`;}m=raw.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);if(m)return `${String(Number(m[1])).padStart(2,'0')}:${m[2]}`;return raw;}
const FAVORITES_STORAGE_KEY='wsm2026FavouritePlayers';
function getFavoriteNames(){try{const r=JSON.parse(localStorage.getItem(FAVORITES_STORAGE_KEY)||'[]');return Array.isArray(r)?r:[]}catch{return []}}
function isFavoritePlayer(n){return getFavoriteNames().some(x=>sameName(x,n))}
function toggleFavoritePlayer(n){const r=getFavoriteNames(),i=r.findIndex(x=>sameName(x,n));if(i>=0)r.splice(i,1);else r.push(n);try{localStorage.setItem(FAVORITES_STORAGE_KEY,JSON.stringify(r))}catch{}return i<0}
function playerFavoriteButton(n){const on=isFavoritePlayer(n);return `<button type="button" id="playerFavoriteButton" class="favorite-player-btn player-detail-favorite-btn ${on?'is-favorite':''}" aria-pressed="${on?'true':'false'}"><span aria-hidden="true">${on?'★':'☆'}</span><span class="favorite-player-btn-text">${on?'Faved':'Fav'}</span></button>`}
function playerScoreState(m){
  const games=[...String(m?.result||'').matchAll(/(\d{1,2})\s*[-–—]\s*(\d{1,2})/g)]
    .map(x=>[Number(x[1]),Number(x[2])]);

  const wonGame=(a,b)=>{
    if(!Number.isFinite(a)||!Number.isFinite(b)||a===b)return 0;
    const hi=Math.max(a,b),lo=Math.min(a,b);

    // Count only FINISHED games, never the player who is merely leading
    // the current game.
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

function scoreWinnerSide(m){
  return playerScoreState(m).winnerSide;
}

function scoreWinnerName(m){
  const w=scoreWinnerSide(m);
  if(w===1)return String(m?.player1||'');
  if(w===2)return String(m?.player2||'');
  return '';
}

function matchGamesScore(m){
  return playerScoreState(m).gamesText;
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
  const code=venueCode(m);

  if(rule.includes('karrinyup'))return code==='G';
  if(rule.includes('mirrabooka'))return code==='M';
  if(rule.includes('belmont'))return code==='B';

  const venueText=`${m?.venue||''} ${m?.rawText||''}`.toLowerCase();
  return !!rule&&venueText.includes(rule);
}

function liveStreamForMatch(m){
  if(!currentMatch(m))return '';

  const rules=Array.isArray(liveStreamConfig?.streams)
    ? liveStreamConfig.streams
    : [];

  const venue=venueCode(m);
  const matchCourt=normalizeLiveStreamCourt(playerActualCourt(m)||m?.court||'');

  for(const rule of rules){
    const url=normalizeLiveStreamUrl(rule?.url);
    if(!url)continue;
    if(!liveStreamVenueMatches(rule.venue,m))continue;

    // Karrinyup: ignore court and always use the Karrinyup venue stream.
    if(venue==='G')return url;

    // Belmont/Mirrabooka: venue and court must both match the JSON rule.
    const configuredCourt=normalizeLiveStreamCourt(rule?.court||'');
    if(!configuredCourt||!matchCourt)continue;
    if(configuredCourt!==matchCourt)continue;

    return url;
  }

  return '';
}

function playerLiveVideoButton(m){
  const url=liveStreamForMatch(m);
  if(!url){
    if(
      currentMatch(m) &&
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

function openPlayerLiveVideoWindow(url){
  if(!url)return;

  const popup=window.open(
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
    try{renderPlayerLiveView();}catch{}
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

function ensurePlayerLiveVideoStyles(){
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

ensurePlayerLiveVideoStyles();

document.addEventListener('click',event=>{
  const button=event.target.closest?.('.live-video-button[data-live-video-url]');
  if(!button)return;
  openPlayerLiveVideoWindow(button.dataset.liveVideoUrl||'');
});

await loadLiveStreamConfig({rerenderPage:false});

function playerMatchScoreSummary(m,outcome=''){
  const state=playerScoreState(m);
  const shouldShow=
    state.live ||
    state.finished ||
    past(m);

  if(!shouldShow)return '';

  return `<div class="match-history-score ${m.result?'has-score':'no-score'} ${state.live?'live-score-block':''}">
    <span class="match-history-score-label ${state.live?'live-score-label':''}">
      <span>Score</span>
      ${state.live
        ? `<span class="live-score-indicator" aria-label="Live match">
            <span class="live-score-dot" aria-hidden="true"></span>
            LIVE
          </span>`
        : ''}
    </span>
    <strong>${m.result?esc(m.result):'Score not published'}</strong>
    ${state.live&&state.gamesText
      ? `<span class="match-live-games">Games <strong>${esc(state.gamesText)}</strong></span>`
      : ''}
    ${state.finished&&state.winnerSide
      ? `<span class="match-winner-label">Winner: <strong>${esc(state.winnerSide===1?m.player1:m.player2)}${state.gamesText?` ${esc(state.gamesText)}`:''}</strong></span>`
      : ''}
    ${outcome&&state.finished
      ? `<span class="match-outcome-badge match-outcome-${outcome}">${outcome==='win'?'WIN':'LOSS'}</span>`
      : ''}
  </div>`;
}

function ensurePlayerLiveScoreStyles(){
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

ensurePlayerLiveScoreStyles();

function matchOutcomeForCurrentPlayer(m){
  const w=scoreWinnerSide(m);if(!w)return '';
  let side=0;
  if(officialPlayerId){
    if(String(m.player1Id||'')===String(officialPlayerId))side=1;
    else if(String(m.player2Id||'')===String(officialPlayerId))side=2;
  }
  if(!side&&!duplicateDisplayedName){
    side=sameName(m.player1,name)?1:sameName(m.player2,name)?2:0;
  }
  return side?(w===side?'win':'loss'):'';
}


function playerDetailMatchKey(m){
  const d=canonicalDate(m.date||'');
  const t=String(m.time||'').trim().toLowerCase();
  const names=[nameKey(m.player1||''),nameKey(m.player2||'')].filter(Boolean).sort().join('|');
  return [d,t,names].join('||');
}
function dedupePlayerDetailMatches(rows){
  const out=[];

  const pair=m=>[
    nameKey(m.player1||''),
    nameKey(m.player2||'')
  ].filter(Boolean).sort().join('|');

  const time=m=>displayTime24(m.time||'');
  const date=m=>canonicalDate(m.date||'');

  const evidenceSources=m=>new Set([
    ...(m.drawEvidenceSources||[]),
    ...(m.evidenceSources||[]),
    m.source,
    m.resultSource
  ].map(x=>String(x||'').trim()).filter(Boolean));

  const authorityTier=m=>{
    const s=evidenceSources(m);
    const status=String(m.status||'').toLowerCase();

    // Historical result evidence proves an actually played fixture.
    if(
      (m.result||m.winner) &&
      (status==='completed'||status==='played'||s.has('TournamentSoftware'))
    )return 5;

    // Deterministic bracket-tree fixture is the strongest schedule evidence.
    if(
      s.has('TournamentSoftware Draw Tree') ||
      s.has('TournamentSoftware Official Draw')
    )return 4;

    // Fresh TournamentSoftware match row.
    if(
      s.has('TournamentSoftware Match') ||
      s.has('TournamentSoftware')
    )return 3;

    // Completed rows without result text still outrank unverified schedules.
    if(status==='completed'||status==='played')return 2;

    return 1;
  };

  const mergeSameFixture=(target,source)=>{
    const sourceStatus=String(source.status||'').toLowerCase();
    if(sourceStatus==='completed'||sourceStatus==='played')target.status='completed';
    else if(sourceStatus==='live'&&String(target.status||'').toLowerCase()!=='completed'){
      target.status='live';
    }

    if(source.result&&!target.result)target.result=source.result;
    if(source.winner&&!target.winner)target.winner=source.winner;

    const sourceWins=authorityTier(source)>authorityTier(target);

    for(const field of [
      'event','round','court','venue','rawText',
      'player1Id','player2Id','source','resultSource'
    ]){
      if(sourceWins&&source[field])target[field]=source[field];
      else if(!target[field]&&source[field])target[field]=source[field];
    }

    const drawEvidence=[
      ...(target.drawEvidenceSources||[]),
      ...(source.drawEvidenceSources||[])
    ];
    if(drawEvidence.length)target.drawEvidenceSources=[...new Set(drawEvidence)];

    const evidence=[
      ...(target.evidenceSources||[]),
      ...(source.evidenceSources||[])
    ];
    if(evidence.length)target.evidenceSources=[...new Set(evidence)];
  };

  // 1. Collapse only literal duplicate fixtures.
  // Never merge the same pair across different tournament dates.
  for(const m0 of rows||[]){
    const m={...m0};

    const existing=out.find(x=>
      date(x)&&date(m)&&
      date(x)===date(m)&&
      time(x)===time(m)&&
      pair(x)===pair(m)
    );

    if(existing)mergeSameFixture(existing,m);
    else out.push(m);
  }

  // 2. Resolve impossible double-bookings for THIS player page.
  // All rows passed into this function already belong to the selected player,
  // so the selected player's slot is simply date+time. We deliberately do not
  // depend on sometimes-missing/stale historical player IDs here.
  const slots=new Map();

  out.forEach((m,i)=>{
    const d=date(m),t=time(m);
    if(!d||!t)return;

    const key=`${d}|${t}`;
    if(!slots.has(key))slots.set(key,[]);
    slots.get(key).push(i);
  });

  const remove=new Set();

  for(const [slot,indexes0] of slots){
    const indexes=[...new Set(indexes0)];
    if(indexes.length<=1)continue;

    const ranked=indexes
      .map(i=>({i,tier:authorityTier(out[i])}))
      .sort((a,b)=>b.tier-a.tier);

    const top=ranked[0].tier;
    const strongest=ranked.filter(x=>x.tier===top);

    if(strongest.length===1){
      const keep=strongest[0].i;

      console.warn(
        `Player detail ${name}: resolving impossible slot ${slot}; keeping `+
        `${out[keep].player1} vs ${out[keep].player2} `+
        `(authority ${top}), suppressing `+
        indexes.filter(i=>i!==keep).map(i=>
          `${out[i].player1} vs ${out[i].player2} (authority ${authorityTier(out[i])})`
        ).join(' | ')
      );

      for(const i of indexes){
        if(i!==keep)remove.add(i);
      }
    }else{
      // Never guess between equal-strength contradictory rows.
      console.warn(
        `Player detail ${name}: unresolved equal-authority conflict at ${slot}: `+
        strongest.map(x=>`${out[x.i].player1} vs ${out[x.i].player2}`).join(' | ')
      );
    }
  }

  return out.filter((_,i)=>!remove.has(i));
}

const venueCode=m=>{const place=[m.venue,m.court].filter(Boolean).join(' · ');if(/Karrinyup|\bAGC\b|Glass/i.test(place))return 'G';if(/Mirrabooka|Squashworld/i.test(place))return 'M';if(/Belmont|WA\s*State\s*Squash/i.test(place))return 'B';return '';};
const venueBadge=m=>{const c=venueCode(m);return c?`<span class="venue-letter venue-${c.toLowerCase()}" aria-hidden="true">${c}</span>`:'';};
function movedTimeNote(m){
  if(!m?.timeMoved||!m?.originalTime)return '';
  const original=displayTime24(m.originalTime);
  const current=displayTime24(m.time);
  if(!original||original==='TBD'||original===current)return '';
  return `<div class="match-moved-notice">MOVED · originally ${esc(original)}</div>`;
}

function stripPlayerLocationDate(v){
  let s=String(v||'').replace(/\s+/g,' ').trim();
  s=s.replace(/\s*(?:·|-)\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\s+\d{1,2}\s*$/i,'').trim();
  if(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\s+\d{1,2}$/i.test(s))return '';
  return s;
}
function playerActualCourt(m){
  const normalizeCourt=value=>{
    let s=String(value||'').replace(/\s+/g,' ').trim();
    if(!s)return '';

    // Only official court formats are valid. Generic tokens such as
    // "of 32" / "of 16" are round text, never a court.
    if(/^SC\s*\d+$/i.test(s))return s.replace(/\s+/g,'').toUpperCase();
    if(/^AGC(?:\s*\d+)?$/i.test(s))return s.replace(/\s+/g,'').toUpperCase();
    if(/^Court\s*\d+$/i.test(s))return s.replace(/\s+/g,' ').trim();
    return '';
  };

  const current=normalizeCourt(stripPlayerLocationDate(m?.court));
  if(current)return current;

  const raw=String(m?.rawText||'');
  const explicit=(raw.match(/\b(AGC(?:\s*\d+)?|SC\s*\d+|Court\s*\d+)\b/i)||[])[1]||'';
  return normalizeCourt(explicit);
}
const venuePlace=m=>{
  const venue=stripPlayerLocationDate(m?.venue);
  const court=playerActualCourt(m);
  return [venue,court].filter(Boolean).join(' · ')||'Venue / court TBD';
};

function playerMatchRow(m){
  const p1=playerForDetailMatchSide(m,1),p2=playerForDetailMatchSide(m,2);
  const p1Current=!!(
    officialPlayerId&&p1?.officialPlayerId&&
    String(p1.officialPlayerId)===String(officialPlayerId)
  )||(!duplicateDisplayedName&&sameName(m.player1,name));
  const p2Current=!!(
    officialPlayerId&&p2?.officialPlayerId&&
    String(p2.officialPlayerId)===String(officialPlayerId)
  )||(!duplicateDisplayedName&&sameName(m.player2,name));
  const scoreState=playerScoreState(m);
  const outcome=scoreState.finished?matchOutcomeForCurrentPlayer(m):'';
  const place=venuePlace(m);
  const live=currentMatch(m);
  const p1Winner=scoreState.finished&&scoreState.winnerSide===1;
  const p2Winner=scoreState.finished&&scoreState.winnerSide===2;

  return `<article class="vic-match-row player-schedule-row ${past(m)?'past':''} ${live?'match-live':''} ${scoreState.finished?'match-finished':''} ${outcome?`match-${outcome}`:''}">${movedTimeNote(m)}
    <div class="vic-time">
      <span class="vic-time-value">${live?'<span class="live-match-dot" title="Match currently in progress" aria-label="Live"></span>':''}${esc(displayTime24(m.time))}</span>
      <span class="vic-time-age">${esc(m.event||'')}</span>
      ${playerLiveVideoButton(m)}
    </div>

    <div class="vic-match-main">
      <div class="vic-event">
        <span class="vic-mobile-meta">
          <span class="vic-mobile-time">${live?'<span class="live-match-dot" title="Match currently in progress" aria-label="Live"></span>':''}${esc(displayTime24(m.time))}</span>
          <span class="vic-mobile-location">${venueBadge(m)}<span class="vic-mobile-location-text">${esc(place)}</span></span>
          <span class="vic-mobile-age">${esc(m.event||'')}</span>
        </span>
        <span class="vic-desktop-event">
          <span class="vic-event-category">${esc(m.event||'')}</span>
          ${m.round?`<span class="vic-event-round"> · ${esc(m.round)}</span>`:''}
        </span>
      </div>

      <div class="vic-fixture-line">
        ${isTbdNamePlayer(m.player1)
          ? `<span class="fixture-player-tbd"><span class="player-name-stack"><b>TBD</b></span></span>`
          : `<a class="${p1Current?'vic-tracked-player':''} ${p1Winner?'match-winner-player':(scoreState.finished&&scoreState.winnerSide?'match-loser-player':'')}" href="${playerPageUrl(m.player1,p1?.officialPlayerId||m.player1Id)}">
              <span class="fixture-player-desktop">
                ${flagImg(p1)}
                <span class="vic-player-name-wrap">
                  <span class="vic-player-name-meta-line">${playerNameStack(p1,m.player1,p1Current)}${p1?.country?`<small class="vic-player-inline-meta">${esc(p1.country)}</small>`:''}</span>
                </span>
              </span>
              <span class="fixture-player-mobile">
                <span class="fixture-mobile-name">${esc(m.player1)}</span>
                <span class="fixture-mobile-info">
                  <span class="fixture-mobile-flag">${flagImg(p1)}</span>
                  <span class="fixture-mobile-details">
                    <span class="fixture-mobile-country">${esc(p1?.country||'')}</span>
                    <span class="fixture-mobile-metrics">${squashBadges(p1)}</span>
                  </span>
                </span>
              </span>
            </a>`}

        <span class="vic-vs">vs</span>

        ${isTbdNamePlayer(m.player2)
          ? `<span class="fixture-player-tbd"><span class="player-name-stack"><b>TBD</b></span></span>`
          : `<a class="${p2Current?'vic-tracked-player':''} ${p2Winner?'match-winner-player':(scoreState.finished&&scoreState.winnerSide?'match-loser-player':'')}" href="${playerPageUrl(m.player2,p2?.officialPlayerId||m.player2Id)}">
              <span class="fixture-player-desktop">
                ${flagImg(p2)}
                <span class="vic-player-name-wrap">
                  <span class="vic-player-name-meta-line">${playerNameStack(p2,m.player2,p2Current)}${p2?.country?`<small class="vic-player-inline-meta">${esc(p2.country)}</small>`:''}</span>
                </span>
              </span>
              <span class="fixture-player-mobile">
                <span class="fixture-mobile-name">${esc(m.player2)}</span>
                <span class="fixture-mobile-info">
                  <span class="fixture-mobile-flag">${flagImg(p2)}</span>
                  <span class="fixture-mobile-details">
                    <span class="fixture-mobile-country">${esc(p2?.country||'')}</span>
                    <span class="fixture-mobile-metrics">${squashBadges(p2)}</span>
                  </span>
                </span>
              </span>
            </a>`}

      </div>

      ${playerMatchScoreSummary(m,outcome)}
    </div>

    <div class="vic-location" title="${esc(place)}">${venueBadge(m)}<span>${esc(place)}</span></div>
  </article>`;
}

function playerByeRow(m){
  const currentOnLeft=!isByeNamePlayer(m.player1);
  const realName=currentOnLeft?m.player1:m.player2;
  const realId=currentOnLeft?m.player1Id:m.player2Id;
  const realPlayer=playerForDetailMatchSide(m,currentOnLeft?1:2) || p;

  const event=String(m.event||'').replace(/\s+/g,' ').trim();
  const round=String(m.round||'').replace(/\s+/g,' ').trim();

  return `<article class="vic-match-row player-schedule-row player-bye-row">
    <div class="vic-time">
      <span class="vic-time-value">BYE</span>
      <span class="vic-time-age">${esc(event)}</span>
    </div>

    <div class="vic-match-main">
      <div class="vic-event">
        <span class="vic-desktop-event">
          <span class="vic-event-category">${esc(event||'Tournament progression')}</span>
          ${round?`<span class="vic-event-round"> · ${esc(round)}</span>`:''}
        </span>
      </div>

      <div class="vic-fixture-line">
        <a class="vic-tracked-player" href="${playerPageUrl(realName,realPlayer?.officialPlayerId||realId||'')}">
          <span class="fixture-player-desktop">
            ${flagImg(realPlayer)}
            <span class="vic-player-name-wrap">
              <span class="vic-player-name-meta-line">
                ${playerNameStack(realPlayer,realName,true)}
                ${realPlayer?.country?`<small class="vic-player-inline-meta">${esc(realPlayer.country)}</small>`:''}
              </span>
            </span>
          </span>
          <span class="fixture-player-mobile">
            <span class="fixture-mobile-name">${esc(realName)}</span>
            <span class="fixture-mobile-info">
              <span class="fixture-mobile-flag">${flagImg(realPlayer)}</span>
              <span class="fixture-mobile-details">
                <span class="fixture-mobile-country">${esc(realPlayer?.country||'')}</span>
                <span class="fixture-mobile-metrics">${squashBadges(realPlayer)}</span>
              </span>
            </span>
          </span>
        </a>

        <span class="vic-vs">vs</span>
        <span class="fixture-player-tbd">
          <span class="player-name-stack"><b>Bye</b></span>
        </span>
      </div>

      <div class="match-history-score no-score">
        <strong>Advances automatically</strong>
      </div>
    </div>

    <div class="vic-location"><span>No match played</span></div>
  </article>`;
}

function perthTodayPlayerIso(){
  const parts=new Intl.DateTimeFormat('en-CA',{
    timeZone:'Australia/Perth',
    year:'numeric',month:'2-digit',day:'2-digit'
  }).formatToParts(new Date());
  const get=t=>parts.find(x=>x.type===t)?.value||'';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function playerMatchDateKey(m){
  return canonicalDate(m?.date||'');
}

function groupedMatches(ms,{history=false}={}){
  if(!ms.length)return '<div class="schedule-empty">No matches currently published.</div>';

  const groups={};
  ms.forEach(m=>{
    const d=m.date||'TBD';
    (groups[d]??=[]).push(m);
  });

  // Same ordering as Vic Park / Fav:
  // - current/upcoming dates earliest first
  // - History dates newest first
  // - within EVERY day, earliest match first
  const dates=Object.keys(groups).sort((a,b)=>
    history
      ? String(b).localeCompare(String(a))
      : String(a).localeCompare(String(b))
  );

  return dates.map(d=>{
    const rows=groups[d].sort((a,b)=>
      String(a.time||'').localeCompare(String(b.time||''))
    );

    return `<div class="vic-day-heading"><span>${fmt(d).day}</span><strong>${fmt(d).long}</strong></div>${rows.map(playerMatchRow).join('')}`;
  }).join('');
}

if(!p){
  qs('#playerHeader').innerHTML='<div class="schedule-empty">Player not found.</div>';
  qs('#playerSchedule').innerHTML='';
}else{
  function renderPlayerLiveView(){
  const allRows=dedupePlayerDetailMatches(
    data.matches.filter(m=>has(m,name))
  );

  const byes=allRows
    .filter(isPlayerByeMatch)
    .sort((a,b)=>
      `${a.event||''} ${a.round||''}`.localeCompare(`${b.event||''} ${b.round||''}`)
    );

  const ms=allRows
    .filter(m=>!isPlayerByeMatch(m))
    .sort((a,b)=>
      `${a.date||''} ${a.time||''}`.localeCompare(`${b.date||''} ${b.time||''}`)
    );

  qs('#playerHeader').innerHTML=`<div class="player-detail-card"><div class="player-detail-id">${flagImg(p,'tracked-flag')}<div><div class="eyebrow">${esc(p.country)} · ${esc(p.gender)} ${p.ageGroup}+</div><div class="player-name-line"><div class="player-name-stack player-detail-name-stack"><h1>${esc(p.name)}</h1>${squashBadges(p)}</div>${p.squashLevelsUrl?`<a class="squashlevels-btn" href="${esc(p.squashLevelsUrl)}" target="_blank" rel="noopener noreferrer">SquashLevels</a>`:''}${playerFavoriteButton(p.name)}</div></div></div><div class="player-detail-actions"><div class="status-chip">${ms.filter(m=>{const d=playerMatchDateKey(m);return d&&d>=perthTodayPlayerIso()}).length} CURRENT</div></div></div>`;
  const today=perthTodayPlayerIso();

  // Player-detail grouping is intentionally DATE based:
  // - Current Matches = today + every future date
  // - History = yesterday and earlier
  // Result/status does NOT move a future-dated match into History.
  const up=ms
    .filter(m=>{
      const d=playerMatchDateKey(m);
      return d&&d>=today;
    })
    .sort((a,b)=>{
      const da=playerMatchDateKey(a),db=playerMatchDateKey(b);
      const dateCmp=String(da).localeCompare(String(db));
      if(dateCmp)return dateCmp;
      return String(a.time||'').localeCompare(String(b.time||''));
    });

  const done=ms
    .filter(m=>{
      const d=playerMatchDateKey(m);
      if(!d||d>=today)return false;

      // Do not turn a stale scheduled slot into History just because its
      // stored date is in the past. History contains only fixtures that have
      // actual completion/result evidence. Moved upcoming fixtures can leave
      // obsolete schedule rows behind, and those rows must stay hidden.
      const status=String(m?.status||'').toLowerCase();
      return status==='completed' || status==='played' ||
        !!String(m?.result||'').trim() || !!String(m?.winner||'').trim();
    })
    .sort((a,b)=>{
      const da=playerMatchDateKey(a),db=playerMatchDateKey(b);
      const dateCmp=String(db).localeCompare(String(da));
      if(dateCmp)return dateCmp;
      return String(a.time||'').localeCompare(String(b.time||''));
    });

  qs('#playerSchedule').innerHTML=
    `${up.length
      ? `<div class="schedule-group upcoming-games-group">
          <div class="player-schedule-section-title">
            <span>Current Matches</span>
            <small>${up.length}</small>
          </div>
          ${groupedMatches(up)}
        </div>`
      : ''}` +
    `${byes.length
      ? `<div class="schedule-group player-byes-group">
          <div class="player-schedule-section-title">
            <span>Byes</span>
            <small>${byes.length}</small>
          </div>
          ${byes.map(playerByeRow).join('')}
        </div>`
      : ''}` +
    `${done.length
      ? `<div class="schedule-group past-games-group">
          <div class="player-schedule-section-title match-history-title">
            <span>History</span>
            <small>${done.length}</small>
          </div>
          ${groupedMatches(done,{history:true})}
        </div>`
      : ''}` +
    `${!up.length&&!done.length&&!byes.length
      ? '<div class="schedule-empty">No matches currently published.</div>'
      : ''}`;
  const favBtn=qs('#playerFavoriteButton');if(favBtn)favBtn.addEventListener('click',()=>{const on=toggleFavoritePlayer(p.name);favBtn.classList.toggle('is-favorite',on);favBtn.setAttribute('aria-pressed',on?'true':'false');favBtn.querySelector('span[aria-hidden="true"]').textContent=on?'★':'☆';favBtn.querySelector('.favorite-player-btn-text').textContent=on?'Faved':'Fav';});

  }
  renderPlayerLiveView();

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
  let squashScoresLastFingerprint=squashScoresFingerprint(loadSquashScoresCompletedCache());

  async function updatePlayerSquashScoresLive(){
    try{
      const parsed=await readSquashScoresCurrentFeed(data.players||[]);

      // Keep finished scores for the rest of the Perth day because SquashScores
      // can remove a completed match from its in-progress view shortly after it
      // ends. Live rows are deliberately not retained when they disappear.
      const snapshot=mergeSquashScoresSnapshot(parsed);
      squashScoresLastFingerprint=squashScoresFingerprint(snapshot);

      // TournamentSoftware remains fixture authority; SquashScores only adds
      // the live/completed state and score to a matching official fixture.
      data.matches=ssOverlay(tournamentBaseMatches,snapshot).map(normMatch);

      console.log(
        `SquashScores player profile: ${snapshot.length} today row(s), `+
        `${snapshot.filter(m=>m.result).length} with scores.`
      );

      renderPlayerLiveView();
    }catch(e){
      console.warn('SquashScores live unavailable:',e?.message||e);
    }
  }

  let squashScoresPollInFlight=false;

  const tick=async()=>{
    if(squashScoresPollTimer){
      clearTimeout(squashScoresPollTimer);
      squashScoresPollTimer=null;
    }

    if(document.visibilityState==='visible'&&!squashScoresPollInFlight){
      squashScoresPollInFlight=true;
      try{
        await updatePlayerSquashScoresLive();
      }finally{
        squashScoresPollInFlight=false;
      }
    }

    squashScoresPollTimer=setTimeout(tick,SQUASH_SCORES_POLL_MS);
  };

  tick();
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState!=='visible')return;
    if(squashScoresPollTimer){
      clearTimeout(squashScoresPollTimer);
      squashScoresPollTimer=null;
    }
    if(!squashScoresPollInFlight)tick();
  });
}

}
initPlayerPage().catch(e=>{console.error(e);const h=qs('#playerHeader');if(h)h.innerHTML=`<div class="schedule-empty"><strong>Could not load player data.</strong><br>${esc(e.message||e)}</div>`;});
