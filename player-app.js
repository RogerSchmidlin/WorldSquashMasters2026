const qs=s=>document.querySelector(s), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
function loadPlayerScript(src){return new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=()=>reject(new Error(`Could not load ${src}`));document.head.appendChild(s);});}
async function loadPlayerDetailData(){
  try{
    await Promise.all([loadPlayerScript('players-data.js'),loadPlayerScript('matches-data.js')]);
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
function namesFromRecord(m){const text=' '+basicNorm(flatText(m))+' ';const found=[];for(const x of playerNeedles){if(x.key.length>4&&text.includes(' '+x.key+' ')){found.push(x.p.name);if(found.length===2)break}}return found}
function normMatch(m){const raw=flatText(m.rawText||m.text||m.description||m);let p1=m.player1||m.playerOne||m.homePlayer||m.home||m.participant1||m.team1||m.entry1||'',p2=m.player2||m.playerTwo||m.awayPlayer||m.away||m.participant2||m.team2||m.entry2||'';const gn=v=>typeof v==='object'&&v?(v.name||v.displayName||v.fullName||v.title||v.label||''):String(v||'');p1=gn(p1);p2=gn(p2);if(!p1||!p2){const f=namesFromRecord(m);if(!p1)p1=f[0]||'';if(!p2)p2=f.find(n=>!sameName(n,p1))||f[1]||''}let venue=m.venue||m.venueName||m.location||m.locationName||m.site||m.facility||'',court=m.court||m.courtName||m.resource||m.resourceName||m.field||m.fieldName||'';if(typeof venue==='object')venue=venue.name||venue.title||venue.label||'';if(typeof court==='object')court=court.name||court.title||court.label||'';if(!venue){if(/Karrinyup/i.test(raw))venue='Karrinyup Shopping Centre';else if(/Mirrabooka/i.test(raw))venue='Squashworld Mirrabooka'}if(!court){const cm=raw.match(/(?:court(?:Name)?["':\s]*|\b)(AGC|SC\s*\d+|Court\s*\d+|[A-Z]{2,5}\s*\d+)\b/i);if(cm)court=cm[1]}return {...m,date:canonicalDate(m.date||m.matchDate||m.startDate||m.start||m.datetime||m.dateTime||m.scheduledDate),time:m.time||m.matchTime||m.startTime||m.scheduledTime||'',event:m.event||m.eventName||m.draw||m.category||m.disciplineName||'',round:m.round||m.roundName||'',player1:p1,player2:p2,venue,court,rawText:raw}}
data.matches=(data.matches||[]).map(normMatch);
const params=new URLSearchParams(location.search);
const requestedId=params.get('id')||'';
const requested=params.get('name')||'';
const p=(requestedId?data.players.find(x=>String(x.officialPlayerId||'')===String(requestedId)):null)||data.players.find(x=>sameName(x.name,requested));
const name=p?.name||requested;
const officialPlayerId=p?.officialPlayerId||requestedId;
const playerPageUrl=(n,id='')=>{const byId=id?data.players.find(x=>String(x.officialPlayerId||'')===String(id)):null;const px=(byId&&sameName(byId.name,n)?byId:null)||data.players.find(x=>sameName(x.name,n));const q=new URLSearchParams();if(px?.officialPlayerId)q.set('id',px.officialPlayerId);q.set('name',px?.name||n||'');return `player.html?${q.toString()}`;};
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
const has=(m,n)=>{if(officialPlayerId&&(String(m.player1Id||'')===String(officialPlayerId)||String(m.player2Id||'')===String(officialPlayerId)))return true;return sameName(m.player1,n)||sameName(m.player2,n);};
const opp=m=>sameName(m.player1,name)?m.player2:(sameName(m.player2,name)?m.player1:(namesFromRecord(m).find(n=>!sameName(n,name))||''));
const pb=n=>data.players.find(x=>sameName(x.name,n));
const past=m=>String(m.status||'').toLowerCase()==='completed'||String(m.status||'').toLowerCase()==='played'||!!m.result;
const venueCode=m=>{const place=[m.venue,m.court].filter(Boolean).join(' · ');if(/Karrinyup|\bAGC\b|Glass/i.test(place))return 'G';if(/Mirrabooka|Squashworld/i.test(place))return 'M';if(/Belmont|WA\s*State\s*Squash/i.test(place))return 'B';return '';};
const venueBadge=m=>{const c=venueCode(m);return c?`<span class="venue-letter venue-${c.toLowerCase()}" aria-hidden="true">${c}</span>`:'';};
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
  const explicit=(raw.match(/\b(AGC(?:\s*\d+)?|SC\s*\d+|Court\s*\d+)\b/i)||[])[1]||'';
  // Deliberately case-sensitive: prevents a date heading such as "Mon 31"
  // from matching the generic coded-court pattern.
  const coded=(raw.match(/\b([A-Z]{2,5}\s*\d+)\b/)||[])[1]||'';
  if(explicit||coded)return String(explicit||coded).replace(/\s+/g,' ').trim();

  const current=stripLocationDate(m?.court,{keepStandaloneNumber:true});
  if(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\s*\d{1,2}$/i.test(current))return '';
  return current;
}
const venuePlace=m=>{
  const venue=stripLocationDate(m.venue);
  const court=actualCourt(m);
  return [venue,court].filter(Boolean).join(' · ')||'Venue / court TBD';
};

function playerMatchRow(m){
  const p1=pb(m.player1),p2=pb(m.player2);
  const p1Current=officialPlayerId?String(m.player1Id||'')===String(officialPlayerId)||sameName(m.player1,name):sameName(m.player1,name);
  const p2Current=officialPlayerId?String(m.player2Id||'')===String(officialPlayerId)||sameName(m.player2,name):sameName(m.player2,name);
  const place=venuePlace(m);
  return `<article class="vic-match-row player-schedule-row ${past(m)?'past':''}">
    <div class="vic-time"><span class="vic-time-value">${esc(m.time||'TBD')}</span><span class="vic-time-age">${esc(m.event||'')}</span></div>
    <div class="vic-match-main">
      <div class="vic-event">
        <span class="vic-mobile-meta">
          <span class="vic-mobile-time">${esc(m.time||'TBD')}</span>
          <span class="vic-mobile-location">${venueBadge(m)}<span>${esc(place)}</span></span>
          <span class="vic-mobile-age">${esc(m.event||'')}</span>
        </span>
        <span class="vic-desktop-event">${esc([m.event,m.round].filter(Boolean).join(' · '))}</span>
      </div>
      <div class="vic-fixture-line">
        <a class="player-detail-fixture-player ${p1Current?'vic-tracked-player':''}" href="${playerPageUrl(m.player1,m.player1Id)}">${flagImg(p1)}${playerNameStack(p1,m.player1,p1Current)}</a>
        <span class="vic-vs">vs</span>
        <a class="player-detail-fixture-player ${p2Current?'vic-tracked-player':''}" href="${playerPageUrl(m.player2,m.player2Id)}">${flagImg(p2)}${playerNameStack(p2,m.player2,p2Current)}</a>
        ${m.result?`<span class="vic-result">${esc(m.result)}</span>`:''}
      </div>
    </div>
    <div class="vic-location">${venueBadge(m)}<span>${esc(place)}</span></div>
  </article>`;
}

function playerDetailMatchKey(m){
  const d=canonicalDate(m.date||'');
  const t=String(m.time||'').trim().toLowerCase();
  const names=[nameKey(m.player1||''),nameKey(m.player2||'')].filter(Boolean).sort().join('|');
  // Names are intentionally authoritative here. TournamentSoftware copies of the
  // same fixture can carry a wrong player id when collected from the other profile.
  return [d,t,names].join('||');
}

function dedupePlayerDetailMatches(matches){
  const byKey=new Map();
  for(const m of matches){
    const k=playerDetailMatchKey(m);
    const existing=byKey.get(k);
    if(!existing){
      byKey.set(k,{...m});
      continue;
    }

    // Merge the two observations so the richer source wins rather than simply
    // keeping whichever orientation happened to appear first.
    for(const fld of ['event','round','venue','result','status']){
      if((!existing[fld]||String(existing[fld]).length<String(m[fld]||'').length)&&m[fld]){
        existing[fld]=m[fld];
      }
    }
    if(String(m.rawText||'').length>String(existing.rawText||'').length)existing.rawText=m.rawText;

    const existingCourt=actualCourt(existing);
    const incomingCourt=actualCourt(m);
    if(!existingCourt&&incomingCourt)existing.court=incomingCourt;

    // Prefer a player id only when it belongs to the corresponding displayed name.
    const p1=pb(existing.player1),p2=pb(existing.player2);
    if(p1?.officialPlayerId)existing.player1Id=p1.officialPlayerId;
    if(p2?.officialPlayerId)existing.player2Id=p2.officialPlayerId;
  }
  return [...byKey.values()];
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
  const ms=dedupePlayerDetailMatches(data.matches.filter(m=>has(m,name))).sort((a,b)=>`${a.date||''} ${a.time||''}`.localeCompare(`${b.date||''} ${b.time||''}`));
  qs('#playerHeader').innerHTML=`<div class="player-detail-card"><div class="player-detail-id">${flagImg(p,'tracked-flag')}<div><div class="eyebrow">${esc(p.country)} · ${esc(p.gender)} ${p.ageGroup}+</div><div class="player-name-line"><div class="player-name-stack player-detail-name-stack"><h1>${esc(p.name)}</h1>${squashBadges(p)}</div>${p.squashLevelsUrl?`<a class="squashlevels-btn" href="${esc(p.squashLevelsUrl)}" target="_blank" rel="noopener noreferrer">SquashLevels</a>`:''}</div></div></div><div class="player-detail-actions"><div class="status-chip">${ms.filter(m=>!past(m)).length} UPCOMING</div></div></div>`;
  const up=ms.filter(m=>!past(m)),done=ms.filter(past);
  qs('#playerSchedule').innerHTML=`<div class="schedule-group">${groupedMatches(up)}</div>${done.length?`<div class="schedule-group past-games-group"><div class="past-games-label">Past games</div>${groupedMatches(done)}</div>`:''}`;
}

}
initPlayerPage().catch(e=>{console.error(e);const h=qs('#playerHeader');if(h)h.innerHTML=`<div class="schedule-empty"><strong>Could not load player data.</strong><br>${esc(e.message||e)}</div>`;});
