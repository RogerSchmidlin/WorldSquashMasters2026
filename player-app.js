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
  for(const v of ['Squashworld Mirrabooka','Belmont Saints Squash Centre','Karrinyup Shopping Centre','Marmion Squash Club']){
    if(s.toLowerCase().includes(v.toLowerCase()))return v;
  }
  const m=s.match(/\b(?:Mirrabooka|Belmont|Karrinyup|Marmion)\b[^|]{0,80}/i);
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

  const gamesScore=match=>{
    const games=Array.isArray(match?.games)?match.games:[];
    const pairs=[];
    for(const g of games){
      const a=Number(g?.player1Score),b=Number(g?.player2Score);
      if(!Number.isFinite(a)||!Number.isFinite(b))continue;
      if(a===0&&b===0)continue;
      pairs.push(`${a}-${b}`);
    }
    return pairs.join(', ');
  };

  const gamesWon=match=>{
    const p1=Number(match?.player1GamesWon),p2=Number(match?.player2GamesWon);
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

      const description=String(m?.description||'').replace(/\s+/g,' ').trim();
      let time='';
      let tm=description.match(/\b(\d{1,2}):([0-5]\d)\b/);
      if(tm)time=`${String(+tm[1]).padStart(2,'0')}:${tm[2]}`;
      if(!time){
        tm=rawDate.match(/[T\s](\d{1,2}):([0-5]\d)/);
        if(tm)time=`${String(+tm[1]).padStart(2,'0')}:${tm[2]}`;
      }

      const [p1Won,p2Won]=gamesWon(m);
      const result=gamesScore(m);
      const completed=p1Won>=3||p2Won>=3;
      const started=result.length>0||p1Won>0||p2Won>0;
      const status=completed?'completed':(started?'live':'scheduled');

      rows.push({
        date,time,player1,player2,result,status,
        venue:String(location?.name||location?.locationName||'').trim(),
        court:String(m?.courtName||m?.court||'').trim(),
        event:String(m?.categoryName||m?.category||'').trim(),
        round:description,
        liveSource:'SquashScores',
        squashScoresMatchId:m?.id||m?.matchId||null
      });
    }
  }

  // SquashScores can contain both the old empty slot and the moved match.
  // For the same players/date, if two different times exist and one row is the
  // empty scheduled placeholder, collapse them into one moved fixture.
  const groups=new Map();
  for(const row of rows){
    const key=`${canonicalDate(row.date)}|${[ssNorm(row.player1),ssNorm(row.player2)].sort().join('|')}`;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(row);
  }

  const collapsed=[];
  for(const group of groups.values()){
    if(group.length===1){collapsed.push(group[0]);continue;}

    const times=[...new Set(group.map(x=>displayTime24(x.time||'')).filter(x=>x&&x!=='TBD'))];
    const active=group
      .filter(x=>x.status==='live'||x.status==='completed'||x.result)
      .sort((a,b)=>String(b.result||'').length-String(a.result||'').length);

    if(times.length>1){
      // Prefer the row that has activity/result data. If neither has activity,
      // prefer the later clock time because the old slot is typically left empty.
      let current=active[0];
      if(!current){
        current=group.slice().sort((a,b)=>displayTime24(b.time).localeCompare(displayTime24(a.time)))[0];
      }
      const otherTimes=times.filter(t=>t!==displayTime24(current.time));
      if(otherTimes.length){
        const original=otherTimes.slice().sort()[0];
        current={...current,originalTime:original,timeMoved:true};
      }
      collapsed.push(current);
      continue;
    }

    const richest=group.slice().sort((a,b)=>{
      const ar=(a.status==='completed'?3000:a.status==='live'?2000:0)+String(a.result||'').length;
      const br=(b.status==='completed'?3000:b.status==='live'?2000:0)+String(b.result||'').length;
      return br-ar;
    })[0];
    collapsed.push(richest);
  }

  console.log(`SquashScores API: ${locations.length} location(s) · ${collapsed.length} match(es) after move/dedupe`);
  return collapsed;
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

function perthTodayIso(){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Perth',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const get=t=>parts.find(x=>x.type===t)?.value||'';
  return `${get('year')}-${get('month')}-${get('day')}`;
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
function squashScoresFingerprint(rows){
  return JSON.stringify((rows||[]).map(m=>[
    canonicalDate(m.date||''),displayTime24(m.time||''),
    ssNorm(m.player1),ssNorm(m.player2),String(m.status||''),
    String(m.result||''),String(m.venue||''),String(m.court||''),
    String(m.originalTime||''),!!m.timeMoved
  ]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

async function fetchSquashScoresApi(){
  const sep=SQUASH_SCORES_API_URL.includes('?')?'&':'?';
  const r=await fetch(`${SQUASH_SCORES_API_URL}${sep}_=${Date.now()}`,{cache:'no-store',mode:'cors'});
  if(!r.ok)throw new Error(`SquashScores API HTTP ${r.status}`);
  return r.json();
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
function canonicalVenue(v){
  const s=String(v||'').replace(/\s+/g,' ').trim();
  if(/\bKarrinyup\b/i.test(s))return 'Karrinyup Shopping Centre';
  if(/\bMirrabooka\b/i.test(s))return 'Squashworld Mirrabooka';
  if(/\bBelmont\b/i.test(s))return 'Belmont Saints Squash Centre';
  return '';
}
function normMatch(m){const raw=flatText(m.rawText||m.text||m.description||m);let p1=m.player1||m.playerOne||m.homePlayer||m.home||m.participant1||m.team1||m.entry1||'',p2=m.player2||m.playerTwo||m.awayPlayer||m.away||m.participant2||m.team2||m.entry2||'';const gn=v=>typeof v==='object'&&v?(v.name||v.displayName||v.fullName||v.title||v.label||''):String(v||'');p1=gn(p1);p2=gn(p2);if(!p1||!p2){const f=namesFromRecord(m);if(!p1)p1=f[0]||'';if(!p2)p2=f.find(n=>!sameName(n,p1))||f[1]||''}let venue=m.venue||m.venueName||m.location||m.locationName||m.site||m.facility||'',court=m.court||m.courtName||m.resource||m.resourceName||m.field||m.fieldName||'';if(typeof venue==='object')venue=venue.name||venue.title||venue.label||'';if(typeof court==='object')court=court.name||court.title||court.label||'';venue=canonicalVenue(venue)||canonicalVenue(raw);if(!court){const cm=raw.match(/(?:court(?:Name)?["':\s]*|\b)(AGC|SC\s*\d+|Court\s*\d+|[A-Z]{2,5}\s*\d+)\b/i);if(cm)court=cm[1]}return {...m,date:canonicalDate(m.date||m.matchDate||m.startDate||m.start||m.datetime||m.dateTime||m.scheduledDate),time:m.time||m.matchTime||m.startTime||m.scheduledTime||'',event:cleanMatchMeta(m.event||m.eventName||m.draw||m.category||m.disciplineName||''),round:cleanMatchMeta(m.round||m.roundName||''),player1:p1,player2:p2,venue,court,rawText:''}}
data.matches=(data.matches||[]).map(normMatch);
const tournamentBaseMatches=data.matches.map(m=>({...m}));
const params=new URLSearchParams(location.search);
const requestedId=params.get('id')||'';
const requested=params.get('name')||'';
const p=(requestedId?data.players.find(x=>String(x.officialPlayerId||'')===String(requestedId)):null)||data.players.find(x=>sameName(x.name,requested));
const name=p?.name||requested;
const officialPlayerId=p?.officialPlayerId||requestedId;
const sameDisplayedNamePlayers=data.players.filter(x=>sameName(x.name,name));
const duplicateDisplayedName=sameDisplayedNamePlayers.length>1;
const playerPageUrl=(n,id='')=>{const px=(id?data.players.find(x=>String(x.officialPlayerId||'')===String(id)):null)||data.players.find(x=>sameName(x.name,n));const q=new URLSearchParams();if(px?.officialPlayerId)q.set('id',px.officialPlayerId);q.set('name',px?.name||n||'');return `player.html?${q.toString()}`;};
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
const pb=n=>data.players.find(x=>sameName(x.name,n));
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

const past=m=>{
  const status=String(m?.status||'').toLowerCase();
  if(status==='completed'||status==='played')return true;
  if(status!=='live'&&!!m?.result)return true;
  const start=matchLocalMinuteValue(m);
  return start!==null&&perthNowMinuteValue()>=start+LIVE_MATCH_WINDOW_MINUTES;
};
function displayTime24(t){const raw=String(t||'').trim();if(!raw)return 'TBD';let m=raw.match(/\b(\d{1,2})(?::(\d{2}))?\s*([AP]M)\b/i);if(m){let h=Number(m[1])%12;if(/^p/i.test(m[3]))h+=12;return `${String(h).padStart(2,'0')}:${m[2]||'00'}`;}m=raw.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);if(m)return `${String(Number(m[1])).padStart(2,'0')}:${m[2]}`;return raw;}
const FAVORITES_STORAGE_KEY='wsm2026FavouritePlayers';
function getFavoriteNames(){try{const r=JSON.parse(localStorage.getItem(FAVORITES_STORAGE_KEY)||'[]');return Array.isArray(r)?r:[]}catch{return []}}
function isFavoritePlayer(n){return getFavoriteNames().some(x=>sameName(x,n))}
function toggleFavoritePlayer(n){const r=getFavoriteNames(),i=r.findIndex(x=>sameName(x,n));if(i>=0)r.splice(i,1);else r.push(n);try{localStorage.setItem(FAVORITES_STORAGE_KEY,JSON.stringify(r))}catch{}return i<0}
function playerFavoriteButton(n){const on=isFavoritePlayer(n);return `<button type="button" id="playerFavoriteButton" class="favorite-player-btn player-detail-favorite-btn ${on?'is-favorite':''}" aria-pressed="${on?'true':'false'}"><span aria-hidden="true">${on?'★':'☆'}</span><span class="favorite-player-btn-text">${on?'Faved':'Fav'}</span></button>`}
function scoreWinnerSide(m){const g=[...String(m?.result||'').matchAll(/(\d{1,2})\s*[-–—]\s*(\d{1,2})/g)].map(x=>[+x[1],+x[2]]);if(g.length<2)return 0;let a=0,b=0;for(const [x,y] of g){if(x>y)a++;else if(y>x)b++;}return a===b?0:(a>b?1:2)}

function scoreWinnerName(m){
  const w=scoreWinnerSide(m);
  if(w===1)return String(m?.player1||'');
  if(w===2)return String(m?.player2||'');
  return '';
}
function matchGamesScore(m){
  const games=[...String(m?.result||'').matchAll(/(\d{1,2})\s*[-–—]\s*(\d{1,2})/g)]
    .map(x=>[Number(x[1]),Number(x[2])]);
  if(!games.length)return '';
  let p1=0,p2=0;
  for(const [a,b] of games){
    if(a>b)p1++;
    else if(b>a)p2++;
  }
  if(p1===p2)return '';
  return `${Math.max(p1,p2)}:${Math.min(p1,p2)}`;
}

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

  const pair=m=>[nameKey(m.player1||''),nameKey(m.player2||'')].filter(Boolean).sort().join('|');
  const time=m=>displayTime24(m.time||'');
  const date=m=>canonicalDate(m.date||'');

  const richer=(target,source)=>{
    // Completed/live state and score are authoritative, not string-length choices.
    const sourceStatus=String(source.status||'').toLowerCase();
    if(sourceStatus==='completed'||sourceStatus==='played')target.status='completed';
    else if(sourceStatus==='live'&&String(target.status||'').toLowerCase()!=='completed')target.status='live';

    if(source.result && (!target.result || String(source.result).length>=String(target.result).length))target.result=source.result;

    for(const field of ['event','round','court','venue','rawText','player1Id','player2Id']){
      const a=String(target[field]||''),b=String(source[field]||'');
      if(b.length>a.length)target[field]=source[field];
    }

    // Prefer a real tournament date over a missing/TBD one.
    if(!date(target)&&date(source))target.date=source.date;
    if(!target.time&&source.time)target.time=source.time;
  };

  for(const m of rows||[]){
    let existing=out.find(x=>date(x)&&date(m)&&date(x)===date(m)&&time(x)===time(m)&&pair(x)===pair(m));

    // Live API rows may have no date; collapse against the scheduled fixture by
    // exact player pair + time.
    if(!existing)existing=out.find(x=>time(x)&&time(x)===time(m)&&pair(x)===pair(m));

    if(!existing){
      const samePair=out.filter(x=>pair(x)===pair(m));
      if(samePair.length===1)existing=samePair[0];
    }

    if(existing)richer(existing,m);
    else out.push({...m});
  }

  return out;
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
  const raw=String(m?.rawText||'');
  const explicit=(raw.match(/\b(AGC(?:\s*\d+)?|SC\s*\d+|Court\s*\d+)\b/i)||[])[1]||'';
  const coded=(raw.match(/\b([A-Z]{2,5}\s*\d+)\b/)||[])[1]||'';
  if(explicit||coded)return String(explicit||coded).replace(/\s+/g,' ').trim();
  const current=stripPlayerLocationDate(m?.court);
  if(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\s*\d{1,2}$/i.test(current))return '';
  return current;
}
const venuePlace=m=>{
  const venue=stripPlayerLocationDate(m?.venue);
  const court=playerActualCourt(m);
  return [venue,court].filter(Boolean).join(' · ')||'Venue / court TBD';
};

function playerMatchRow(m){
  const p1=pb(m.player1),p2=pb(m.player2);
  const p1Current=(officialPlayerId&&String(m.player1Id||'')===String(officialPlayerId))||(!duplicateDisplayedName&&sameName(m.player1,name));
  const p2Current=(officialPlayerId&&String(m.player2Id||'')===String(officialPlayerId))||(!duplicateDisplayedName&&sameName(m.player2,name));
  const outcome=past(m)?matchOutcomeForCurrentPlayer(m):'';
  const place=venuePlace(m);
  const live=currentMatch(m);

  return `<article class="vic-match-row player-schedule-row ${past(m)?'past':''} ${live?'match-live':''} ${outcome?`match-${outcome}`:''}">${movedTimeNote(m)}
    <div class="vic-time">
      <span class="vic-time-value">${live?'<span class="live-match-dot" title="Match currently in progress" aria-label="Live"></span>':''}${esc(displayTime24(m.time))}</span>
      <span class="vic-time-age">${esc(m.event||'')}</span>
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
        <a class="${p1Current?'vic-tracked-player':''}" href="${playerPageUrl(m.player1,m.player1Id)}">
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
        </a>

        <span class="vic-vs">vs</span>

        <a class="${p2Current?'vic-tracked-player':''}" href="${playerPageUrl(m.player2,m.player2Id)}">
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
        </a>

        ${m.result&&!past(m)?`<span class="vic-result">${esc(m.result)}</span>`:''}
      </div>

      ${past(m)?`<div class="match-history-score ${m.result?'has-score':'no-score'}">
        <span class="match-history-score-label">Score</span>
        <strong>${m.result?esc(m.result):'Score not published'}</strong>
        ${m.result&&scoreWinnerName(m)?`<span class="match-winner-label">Winner: <strong>${esc(scoreWinnerName(m))} ${esc(matchGamesScore(m))}</strong></span>`:''}
        ${outcome?`<span class="match-outcome-badge match-outcome-${outcome}">${outcome==='win'?'WIN':'LOSS'}</span>`:''}
      </div>`:''}
    </div>

    <div class="vic-location" title="${esc(place)}">${venueBadge(m)}<span>${esc(place)}</span></div>
  </article>`;
}
function groupedMatches(ms){
  if(!ms.length)return '<div class="schedule-empty">No matches currently published.</div>';
  const groups={};
  ms.forEach(m=>{const d=m.date||'TBD';(groups[d]??=[]).push(m)});
  return Object.entries(groups).map(([d,rows])=>`<div class="vic-day-heading"><span>${fmt(d).day}</span><strong>${fmt(d).long}</strong></div>${rows.map(playerMatchRow).join('')}`).join('');
}

if(!p){
  qs('#playerHeader').innerHTML='<div class="schedule-empty">Player not found.</div>';
  qs('#playerSchedule').innerHTML='';
}else{
  function renderPlayerLiveView(){
  const ms=dedupePlayerDetailMatches(data.matches.filter(m=>has(m,name))).sort((a,b)=>`${a.date||''} ${a.time||''}`.localeCompare(`${b.date||''} ${b.time||''}`));
  qs('#playerHeader').innerHTML=`<div class="player-detail-card"><div class="player-detail-id">${flagImg(p,'tracked-flag')}<div><div class="eyebrow">${esc(p.country)} · ${esc(p.gender)} ${p.ageGroup}+</div><div class="player-name-line"><div class="player-name-stack player-detail-name-stack"><h1>${esc(p.name)}</h1>${squashBadges(p)}</div>${p.squashLevelsUrl?`<a class="squashlevels-btn" href="${esc(p.squashLevelsUrl)}" target="_blank" rel="noopener noreferrer">SquashLevels</a>`:''}${playerFavoriteButton(p.name)}</div></div></div><div class="player-detail-actions"><div class="status-chip">${ms.filter(m=>!past(m)).length} UPCOMING</div></div></div>`;
  const up=ms.filter(m=>!past(m)).sort((a,b)=>`${a.date||''} ${a.time||''}`.localeCompare(`${b.date||''} ${b.time||''}`)),done=ms.filter(past).sort((a,b)=>`${b.date||''} ${b.time||''}`.localeCompare(`${a.date||''} ${a.time||''}`));
  qs('#playerSchedule').innerHTML=`${up.length?`<div class="schedule-group upcoming-games-group"><div class="player-schedule-section-title"><span>Upcoming Matches</span><small>${up.length}</small></div>${groupedMatches(up)}</div>`:''}${done.length?`<div class="schedule-group past-games-group"><div class="player-schedule-section-title match-history-title"><span>Match History</span><small>${done.length} completed</small></div>${groupedMatches(done)}</div>`:''}${!up.length&&!done.length?'<div class="schedule-empty">No matches currently published.</div>':''}`;
  const favBtn=qs('#playerFavoriteButton');if(favBtn)favBtn.addEventListener('click',()=>{const on=toggleFavoritePlayer(p.name);favBtn.classList.toggle('is-favorite',on);favBtn.setAttribute('aria-pressed',on?'true':'false');favBtn.querySelector('span[aria-hidden="true"]').textContent=on?'★':'☆';favBtn.querySelector('.favorite-player-btn-text').textContent=on?'Faved':'Fav';});

  }
  renderPlayerLiveView();

  let squashScoresPollTimer=null;
  let squashScoresLastFingerprint='';
  async function updatePlayerSquashScoresLive(){
    try{
      const payload=await fetchSquashScoresApi();
      const live=parseSquashScoresApi(payload,data.players||[]);
      if(!live.length)return;

      const fingerprint=squashScoresFingerprint(live);
      if(fingerprint===squashScoresLastFingerprint)return;
      squashScoresLastFingerprint=fingerprint;

      data.matches=ssOverlay(tournamentBaseMatches,live).map(normMatch);
      renderPlayerLiveView();
    }catch(e){
      console.warn('SquashScores live unavailable:',e?.message||e);
    }
  }
  const tick=()=>{if(document.visibilityState==='visible')updatePlayerSquashScoresLive()};
  tick();
  squashScoresPollTimer=setInterval(tick,SQUASH_SCORES_POLL_MS);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')tick()});
}

}
initPlayerPage().catch(e=>{console.error(e);const h=qs('#playerHeader');if(h)h.innerHTML=`<div class="schedule-empty"><strong>Could not load player data.</strong><br>${esc(e.message||e)}</div>`;});
