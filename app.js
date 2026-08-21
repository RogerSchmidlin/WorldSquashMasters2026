const data = window.TOURNAMENT_DATA;
const VIC_PARK_PLAYERS = Array.isArray(window.VIC_PARK_PLAYERS) ? window.VIC_PARK_PLAYERS : [];
function canonicalDate(v){
  if(!v)return '';
  const s=String(v).trim();
  let m=s.match(/^(\d{4})-(\d{2})-(\d{2})/); if(m)return `${m[1]}-${m[2]}-${m[3]}`;
  m=s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/); if(m)return `${m[3]}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
  const d=new Date(s); if(!Number.isNaN(d.getTime())){const y=d.getFullYear(),mo=String(d.getMonth()+1).padStart(2,'0'),da=String(d.getDate()).padStart(2,'0');return `${y}-${mo}-${da}`;}
  return s;
}
const flatText=v=>{try{return typeof v==='string'?v:JSON.stringify(v)}catch{return String(v||'')}};
const basicNorm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[’‘]/g,"'").toLowerCase().replace(/[^a-z0-9']+/g,' ').trim();
const playerNeedles=(data.players||[]).map(p=>({p,key:basicNorm(p.name)})).sort((a,b)=>b.key.length-a.key.length);
function namesFromRecord(m){
  const text=' '+basicNorm(flatText(m))+' ';
  const found=[];
  for(const x of playerNeedles){if(x.key.length>4 && text.includes(' '+x.key+' ')){found.push(x.p.name);if(found.length===2)break;}}
  return found;
}
function deriveVenueCourt(m,raw){
  let venue=m.venue||m.venueName||m.location||m.locationName||m.site||m.facility||'';
  let court=m.court||m.courtName||m.resource||m.resourceName||m.field||m.fieldName||'';
  if(typeof venue==='object')venue=venue.name||venue.title||venue.label||'';
  if(typeof court==='object')court=court.name||court.title||court.label||'';
  const t=String(raw||'');
  if(!venue){if(/Karrinyup/i.test(t))venue='Karrinyup Shopping Centre';else if(/Mirrabooka/i.test(t))venue='Squashworld Mirrabooka';else if(/Marmion/i.test(t))venue='Marmion Squash Club';else if(/Belmont/i.test(t))venue='Belmont Squash Centre';}
  if(!court){const cm=t.match(/(?:court(?:Name)?["':\s]*|\b)(AGC|SC\s*\d+|Court\s*\d+|[A-Z]{2,5}\s*\d+)\b/i);if(cm)court=cm[1].replace(/\s+/g,' ').trim();}
  return {venue,court};
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
  return {...m,date,time,event:m.event||m.eventName||m.draw||m.category||m.disciplineName||'',round:m.round||m.roundName||'',player1:p1,player2:p2,venue:vc.venue,court:vc.court,rawText:raw};
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
const playerByName=name=>data.players.find(p=>sameName(p.name,name));
const flagUrl=p=>p?.flagCode?`https://flagcdn.com/w80/${p.flagCode}.png`:'';
const flagImg=(p,cls='inline-flag')=>p?.flagCode?`<img class="${cls}" src="${flagUrl(p)}" alt="${p.country||''} flag">`:'<span class="flag-fallback">🌐</span>';
const flagForName=name=>flagImg(playerByName(name));
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const fmtDate=iso=>{const d=new Date(iso+'T12:00:00');return{day:d.toLocaleDateString('en-AU',{weekday:'short'}),date:d.toLocaleDateString('en-AU',{day:'numeric',month:'short'}),long:d.toLocaleDateString('en-AU',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}};
const tournamentDates=()=>{const a=[], d=new Date(data.tournament.startDate+'T12:00:00'), end=new Date(data.tournament.endDate+'T12:00:00');for(;d<=end;d.setDate(d.getDate()+1))a.push(d.toISOString().slice(0,10));return a;};
const isGlass=m=>/Karrinyup|\bAGC\b/i.test([m.venue,m.court].join(' '));
const isPast=m=>m.status==='completed'||!!m.result;
const matchHas=(m,name)=>sameName(m.player1,name)||sameName(m.player2,name);
const opponentFor=(m,name)=>sameName(m.player1,name)?m.player2:m.player1;

function setPage(id){
  qsa('.page').forEach(p=>p.classList.toggle('active-page',p.id===id));
  qsa('[data-page]').forEach(a=>a.classList.toggle('active',a.dataset.page===id));
  history.replaceState(null,'','#'+id);
  scrollTo({top:0,behavior:'smooth'});
}
qsa('[data-page]').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();setPage(a.dataset.page)}));

function renderPlayers(){
  const term=norm(qs('#playerSearch').value), country=qs('#countryFilter').value, gender=qs('#genderFilter').value, age=qs('#ageFilter').value;
  const rows=data.players.filter(p=>(!term||norm(p.name).includes(term))&&(country==='all'||p.country===country)&&(gender==='all'||p.gender===gender)&&(age==='all'||String(p.ageGroup)===age));
  qs('#playerCount').textContent=rows.length;
  qsa('.country-chip').forEach(ch=>ch.classList.toggle('active',ch.dataset.country===country));
  qs('#playerGrid').innerHTML=rows.map(p=>`<a class="player-card" href="player.html?name=${encodeURIComponent(p.name)}"><div class="flag-avatar">${flagImg(p,'flag-img')}</div><div><b>${esc(p.name)}</b><small>${esc(p.country)} · ${esc(p.gender)} ${p.ageGroup}+</small></div></a>`).join('');
}
function setupPlayers(){
  const counts={}; data.players.forEach(p=>counts[p.country]=(counts[p.country]||0)+1);
  Object.keys(counts).sort().forEach(c=>qs('#countryFilter').insertAdjacentHTML('beforeend',`<option value="${esc(c)}">${esc(c)} (${counts[c]})</option>`));
  const strip=qs('#countryStrip'); if(strip){const countries=Object.keys(counts).sort((a,b)=>counts[b]-counts[a]||a.localeCompare(b)); strip.innerHTML=`<button class="country-chip active" data-country="all">All <span class="chip-count">${data.players.length}</span></button>`+countries.map(c=>{const p=data.players.find(x=>x.country===c);return `<button class="country-chip" data-country="${esc(c)}">${flagImg(p)}<span>${esc(c)}</span><span class="chip-count">${counts[c]}</span></button>`}).join(''); qsa('.country-chip').forEach(ch=>ch.addEventListener('click',()=>{qs('#countryFilter').value=ch.dataset.country;renderPlayers();setPage('players');}));}
  [...new Set(data.players.map(p=>p.ageGroup))].sort((a,b)=>a-b).forEach(a=>qs('#ageFilter').insertAdjacentHTML('beforeend',`<option value="${a}">${a}+</option>`));
  ['#playerSearch','#countryFilter','#genderFilter','#ageFilter'].forEach(s=>qs(s).addEventListener(s==='#playerSearch'?'input':'change',renderPlayers));
  qs('#countryCount').textContent=Object.keys(counts).length; renderPlayers(); setupParticipationMap(counts);
}
function setupParticipationMap(counts){
  if(!window.Plotly){qs('#participationMap').innerHTML='<div class="empty">Map unavailable while offline.</div>';return;}
  // TournamentSoftware uses some sporting country codes that differ from ISO-3166 alpha-3.
  // Plotly's world map requires ISO-3166 alpha-3 (e.g. South Africa is ZAF, not RSA).
  const mapIso3 = code => ({ RSA:'ZAF' }[String(code||'').toUpperCase()] || String(code||'').toUpperCase());
  const grouped={}; data.players.forEach(p=>{const iso=mapIso3(p.iso3);if(!iso)return; grouped[iso]??={name:p.country,count:0}; grouped[iso].count++;});
  const locations=Object.keys(grouped), z=locations.map(()=>1), text=locations.map(k=>`${grouped[k].name}: ${grouped[k].count} player${grouped[k].count===1?'':'s'}`);
  Plotly.newPlot('participationMap',[{type:'choropleth',locationmode:'ISO-3',locations,z,text,hovertemplate:'%{text}<extra></extra>',colorscale:[[0,'#f5c84c'],[1,'#f5c84c']],showscale:false,marker:{line:{color:'#071427',width:.7}}}],{margin:{l:0,r:0,t:0,b:0},paper_bgcolor:'rgba(0,0,0,0)',geo:{projection:{type:'natural earth'},showframe:false,showcoastlines:false,showcountries:true,countrycolor:'#294462',showland:true,landcolor:'#152b45',showocean:true,oceancolor:'rgba(5,19,35,.35)',bgcolor:'rgba(0,0,0,0)'}},{displayModeBar:false,responsive:true});
}
function venueCode(m){
  const place=[m.venue,m.court].filter(Boolean).join(' · ');
  if(/Karrinyup|\bAGC\b|Glass/i.test(place)) return 'G';
  if(/Mirrabooka|Squashworld/i.test(place)) return 'M';
  if(/Belmont|WA\s*State\s*Squash/i.test(place)) return 'B';
  return '';
}
function venueBadge(m){const code=venueCode(m);return code?`<span class="venue-letter venue-${code.toLowerCase()}" aria-label="${code==='G'?'Glass Court':code==='M'?'Mirrabooka':'Belmont'}">${code}</span>`:'';}
function stripLocationDate(value){
  return String(value||'')
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g,'')
    .replace(/\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/g,'')
    .replace(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\b[,]?\s*/gi,'')
    .replace(/\b\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:\s+\d{4})?\b/gi,'')
    .replace(/\s*[·|,\-–—]\s*$/g,'')
    .replace(/\s{2,}/g,' ')
    .trim();
}
function cleanVenuePlace(m){
  const bits=[stripLocationDate(m.venue),stripLocationDate(m.court)].filter(Boolean);
  return bits.join(' · ')||'Venue / court TBD';
}

function matchCard(m){
  const p1=playerByName(m.player1), p2=playerByName(m.player2);
  return `<article class="match-card"><div class="match-time">${esc(m.time||'TBD')}</div><div class="event-badge">${esc([m.event,m.round].filter(Boolean).join(' · '))}</div><div class="fixture"><div class="player-side">${flagImg(p1)}<a class="match-player-link" href="player.html?name=${encodeURIComponent(m.player1)}">${esc(m.player1||'TBD')}</a></div><div class="vs">VS</div><div class="player-side right"><a class="match-player-link" href="player.html?name=${encodeURIComponent(m.player2)}">${esc(m.player2||'TBD')}</a>${flagImg(p2)}</div></div><div class="court-tag">${venueBadge(m)}<span>${esc(m.court||m.venue||'')}</span></div></article>`;
}
function compactScheduleRow(m,trackedNames=[]){
  const p1=playerByName(m.player1), p2=playerByName(m.player2);
  const p1Tracked=trackedNames.some(n=>sameName(n,m.player1));
  const p2Tracked=trackedNames.some(n=>sameName(n,m.player2));
  const v=venueVisual(m);
  return `<article class="vic-match-row ${isPast(m)?'past':''}">
    <div class="vic-time">${esc(m.time||'TBD')}</div>
    <div class="vic-match-main">
      <div class="vic-event">${esc([m.event,m.round].filter(Boolean).join(' · '))}</div>
      <div class="vic-fixture-line">
        <a href="player.html?name=${encodeURIComponent(m.player1)}">${flagImg(p1)}<b class="${p1Tracked?'vic-tracked-name':''}">${esc(m.player1||'TBD')}</b></a>
        <span class="vic-vs">vs</span>
        <a href="player.html?name=${encodeURIComponent(m.player2)}">${flagImg(p2)}<b class="${p2Tracked?'vic-tracked-name':''}">${esc(m.player2||'TBD')}</b></a>
        ${m.result?`<span class="vic-result">${esc(m.result)}</span>`:''}
      </div>
    </div>
    <div class="vic-location" title="${esc(v.place)}">${v.code?`<span class="venue-letter venue-${v.code.toLowerCase()}" aria-hidden="true">${v.code}</span>`:''}<span>${esc(v.place)}</span></div>
  </article>`;
}
function renderGlass(date){
  qsa('.date-tab').forEach(x=>x.classList.toggle('active',x.dataset.date===date));
  const dayMatches=data.matches.filter(m=>canonicalDate(m.date)===date);
  const ms=dayMatches.filter(isGlass).sort((a,b)=>to24(a.time||'').localeCompare(to24(b.time||'')));
  qs('#glassMatches').innerHTML=ms.length?ms.map(m=>compactScheduleRow(m)).join(''):`<div class="schedule-empty"><strong>No AGC-tagged matches found for this day.</strong><br><span>${dayMatches.length?`${dayMatches.length} downloaded match(es) exist for ${fmtDate(date).long}, but none currently contain Karrinyup / AGC court metadata.`:'No downloaded matches exist for this date.'}</span></div>`;
  qs('#glassDayCount').textContent=ms.length;
}
function setupGlass(){
  const dates=tournamentDates(); qs('#dateTabs').innerHTML=dates.map((d,i)=>{const f=fmtDate(d);return `<button class="date-tab ${i===0?'active':''}" data-date="${d}"><strong>${f.day}</strong><small>${f.date}</small></button>`}).join('');
  qsa('.date-tab').forEach(b=>b.addEventListener('click',()=>renderGlass(b.dataset.date))); renderGlass(dates[0]);
}
function trackedMatchCard(m,name){
  const tracked=playerByName(name)||{name}, opp=opponentFor(m,name), op=playerByName(opp);
  return `<article class="tracked-match"><div class="tracked-match-top"><div><b>${fmtDate(m.date).long}</b><span>${esc([m.event,m.round].filter(Boolean).join(' · '))}</span></div><strong>${esc(m.time||'TBD')}</strong></div><div class="tracked-fixture"><div class="tracked-side">${flagImg(tracked,'match-flag')}<div><small>TRACKED</small><b><a href="player.html?name=${encodeURIComponent(name)}">${esc(name)}</a></b></div></div><div class="versus-badge">VS</div><div class="tracked-side right"><div><small>OPPONENT</small><b><a href="player.html?name=${encodeURIComponent(opp)}">${esc(opp||'TBD')}</a></b></div>${flagImg(op,'match-flag')}</div></div><div class="roger-meta"><span>${esc(m.venue||'Venue TBD')}</span><span>${esc(m.court||'Court TBD')}</span>${m.result?`<span>${esc(m.result)}</span>`:''}</div></article>`;
}
function venueVisual(m){
  return {place:cleanVenuePlace(m),code:venueCode(m)};
}
function setupVicPark(){
  const names=VIC_PARK_PLAYERS;
  qs('#trackedCount').textContent=names.length;
  qs('#trackedCountLabel').textContent=names.length===1?'player tracked':'players tracked';

  const rows=[];
  for(const m of (data.matches||[])){
    const tracked=names.filter(name=>matchHas(m,name));
    if(tracked.length) rows.push({m,tracked});
  }
  rows.sort((a,b)=>{
    const ka=`${a.m.date||'9999-99-99'} ${to24(a.m.time||'')}`;
    const kb=`${b.m.date||'9999-99-99'} ${to24(b.m.time||'')}`;
    return ka.localeCompare(kb);
  });

  const container=qs('#trackedPlayers');
  if(!rows.length){
    container.innerHTML=`<div class="schedule-empty"><strong>No Vic Park matches found in the refreshed match data.</strong><br><span>${names.length?`Tracking: ${names.map(esc).join(', ')}`:'Add players to vic-park-players.js.'}</span></div>`;
    return;
  }

  let currentDate='';
  let html='';
  for(const {m,tracked} of rows){
    if(m.date!==currentDate){
      currentDate=m.date;
      const f=fmtDate(m.date);
      html+=`<div class="vic-day-heading"><strong>${esc(f.date)}</strong></div>`;
    }
    html+=compactScheduleRow(m,tracked);
  }
  container.innerHTML=html;
}

function to24(t){
  const s=String(t||'').trim(); const m=s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i); if(!m)return s.padStart(8,'9');
  let h=+m[1]; const ap=(m[3]||'').toLowerCase(); if(ap==='pm'&&h<12)h+=12; if(ap==='am'&&h===12)h=0; return `${String(h).padStart(2,'0')}:${m[2]}`;
}
function stamp(){const el=qs('#refreshStamp'); if(!el)return; el.textContent=data.refreshedAt?`Tournament data refreshed ${new Date(data.refreshedAt).toLocaleString('en-AU')}`:'Bundled snapshot — run npm run refresh to pull the latest TournamentSoftware data.';}
setupPlayers(); setupGlass(); setupVicPark(); stamp();
const initial=location.hash.slice(1); if(['home','players','glass','vicpark'].includes(initial))setPage(initial);
