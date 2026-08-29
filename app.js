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
  rebuildPlayerNeedles();playersReady=true;
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
  data.matches=(data.matches||[]).map(normaliseMatch);matchesReady=true;
}

async function ensureVicParkData(){
  if(vicParkDataReady)return;
  try{
    await loadScriptOnce('vicpark-data.js');
    const pack=window.VIC_PARK_DATA;
    if(!pack||!Array.isArray(pack.players)||!Array.isArray(pack.matches))throw new Error('vicpark-data.js did not define VIC_PARK_DATA');
    vicParkPlayers=pack.players;
    vicParkMatches=pack.matches.map(normaliseMatch);
  }catch(e){
    // Backwards-compatible fallback while deploying the new small Vic Park data file.
    console.warn('vicpark-data.js not available; falling back to full match data.',e);
    await ensureMatchesData();
    vicParkPlayers=data.players;
    vicParkMatches=data.matches;
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
const playerByName=name=>data.players.find(p=>sameName(p.name,name))||vicParkPlayers.find(p=>sameName(p.name,name));
const playerById=id=>id?(data.players.find(p=>String(p.officialPlayerId||'')===String(id))||vicParkPlayers.find(p=>String(p.officialPlayerId||'')===String(id))):null;
const playerPageUrl=(name,id='')=>{const byId=playerById(id);const p=(byId&&sameName(byId.name,name)?byId:null)||playerByName(name);const q=new URLSearchParams();if(p?.officialPlayerId)q.set('id',p.officialPlayerId);q.set('name',p?.name||name||'');return `player.html?${q.toString()}`;};
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
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const fmtDate=iso=>{const d=new Date(iso+'T12:00:00');return{day:d.toLocaleDateString('en-AU',{weekday:'short'}),date:d.toLocaleDateString('en-AU',{day:'numeric',month:'short'}),long:d.toLocaleDateString('en-AU',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}};
const tournamentDates=()=>{const a=[], d=new Date(data.tournament.startDate+'T12:00:00'), end=new Date(data.tournament.endDate+'T12:00:00');for(;d<=end;d.setDate(d.getDate()+1))a.push(d.toISOString().slice(0,10));return a;};
const isGlass=m=>/Karrinyup|\bAGC\b/i.test([m.venue,m.court].join(' '));
const isPast=m=>m.status==='completed'||!!m.result;
const matchHas=(m,name)=>{const p=playerByName(name);return !!(p?.officialPlayerId&&(String(m.player1Id||'')===String(p.officialPlayerId)||String(m.player2Id||'')===String(p.officialPlayerId)))||sameName(m.player1,name)||sameName(m.player2,name);};
const opponentFor=(m,name)=>sameName(m.player1,name)?m.player2:m.player1;
const FAVORITES_STORAGE_KEY='wsm2026FavouritePlayers';
function getFavoriteNames(){try{const r=JSON.parse(localStorage.getItem(FAVORITES_STORAGE_KEY)||'[]');return Array.isArray(r)?r.filter(x=>typeof x==='string'&&x.trim()).map(x=>x.trim()):[]}catch{return []}}
function saveFavoriteNames(names){const out=[];for(const n of names||[])if(n&&!out.some(x=>sameName(x,n)))out.push(n);try{localStorage.setItem(FAVORITES_STORAGE_KEY,JSON.stringify(out))}catch{}return out}
function isFavoritePlayer(n){return getFavoriteNames().some(x=>sameName(x,n))}
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

function renderPlayers(){
  const term=norm(qs('#playerSearch').value), country=qs('#countryFilter').value, gender=qs('#genderFilter').value, age=qs('#ageFilter').value;
  const sortBy=qs('#playerSort')?.value||'name', sortOrder=qs('#playerSortOrder')?.value||'asc';
  const numeric=v=>{const raw=String(v??'').trim();if(!raw||!/[0-9]/.test(raw))return null;const n=Number(raw.replace(/,/g,'').replace(/[^0-9.-]/g,''));return Number.isFinite(n)?n:null};
  const compareText=(a,b)=>String(a||'').localeCompare(String(b||''),undefined,{sensitivity:'base',numeric:true});

  // Level rank is calculated from the COMPLETE player list, not the filtered rows.
  // This means a player's number stays fixed while searching/filtering.
  const levelRank=new Map();
  data.players.slice().sort((a,b)=>{
    const ar=numeric(a.squashLevelsLevel), br=numeric(b.squashLevelsLevel);
    if(ar==null&&br==null)return compareText(a.name,b.name);
    if(ar==null)return 1;if(br==null)return -1;
    const c=br-ar;return c===0?compareText(a.name,b.name):c;
  }).forEach((p,index)=>levelRank.set(p,index+1));

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
  qs('#playerGrid').innerHTML=rows.map(p=>`<div class="player-card">
    <div class="player-card-desktop-layout">
      <a class="player-card-flag-link" href="${playerPageUrl(p.name,p.officialPlayerId)}"><div class="flag-avatar">${flagImg(p,'flag-img')}</div></a>
      <div class="player-card-copy"><div class="player-card-name-line"><div class="player-name-stack"><div class="player-name-meta-line"><a class="player-card-name-link" href="${playerPageUrl(p.name,p.officialPlayerId)}"><b>${sortBy==='level'?`${levelRank.get(p)} - `:''}${esc(p.name)}</b></a><small class="player-inline-meta">${esc(p.country)} · ${p.ageGroup}+</small></div><div class="player-level-line">${squashBadges(p)}${p.squashLevelsUrl?`<a class="squashlevels-btn squashlevels-list-btn" href="${esc(p.squashLevelsUrl)}" target="_blank" rel="noopener noreferrer" title="Open ${esc(p.name)} on SquashLevels">SquashLevels</a>`:''}${favoriteButton(p.name,'favorite-list-btn')}</div></div></div></div>
    </div>
    <div class="mobile-player-layout">
      <a class="mobile-player-name" href="${playerPageUrl(p.name,p.officialPlayerId)}">${sortBy==='level'?`${levelRank.get(p)} - `:''}${esc(p.name)}</a>
      <div class="mobile-player-info">
        <a class="mobile-player-flag" href="${playerPageUrl(p.name,p.officialPlayerId)}">${flagImg(p,'flag-img')}</a>
        <div class="mobile-player-details">
          <div class="mobile-player-country">${esc(p.country||'')}</div>
          <div class="mobile-player-metrics">${squashBadges(p)}${p.squashLevelsUrl?`<a class="squashlevels-btn squashlevels-list-btn" href="${esc(p.squashLevelsUrl)}" target="_blank" rel="noopener noreferrer" title="Open ${esc(p.name)} on SquashLevels">SquashLevels</a>`:''}${favoriteButton(p.name,'favorite-list-btn')}</div>
        </div>
      </div>
    </div>
  </div>`).join('');
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
  // Prefer an explicit court token from the TournamentSoftware row.
  // Important: keep the generic coded-court regex case-sensitive so "Mon 31"
  // can never be mistaken for a court.
  const explicit=(raw.match(/\b(AGC(?:\s*\d+)?|SC\s*\d+|Court\s*\d+)\b/i)||[])[1]||'';
  const coded=(raw.match(/\b([A-Z]{2,5}\s*\d+)\b/)||[])[1]||'';
  if(explicit||coded)return String(explicit||coded).replace(/\s+/g,' ').trim();

  const current=stripLocationDate(m?.court,{keepStandaloneNumber:true});
  if(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\s*\d{1,2}$/i.test(current))return '';
  return current;
}
function cleanVenuePlace(m){
  const venue=stripLocationDate(m.venue);
  const court=actualCourt(m);
  const bits=[venue,court].filter(Boolean);
  return bits.join(' · ')||'Venue / court TBD';
}

function matchCard(m){
  const p1=playerByName(m.player1), p2=playerByName(m.player2);
  return `<article class="match-card"><div class="match-time">${esc(displayTime24(m.time))}</div><div class="event-badge">${esc([m.event,m.round].filter(Boolean).join(' · '))}</div><div class="fixture"><div class="player-side">${flagImg(p1)}<a class="match-player-link" href="${playerPageUrl(m.player1,m.player1Id)}"><span class="player-name-stack"><b>${esc(m.player1||'TBD')}</b>${squashBadges(p1)}</span></a></div><div class="vs">VS</div><div class="player-side right"><a class="match-player-link" href="${playerPageUrl(m.player2,m.player2Id)}"><span class="player-name-stack"><b>${esc(m.player2||'TBD')}</b>${squashBadges(p2)}</span></a>${flagImg(p2)}</div></div><div class="court-tag">${venueBadge(m)}<span>${esc(cleanVenuePlace(m))}</span></div></article>`;
}
function compactScheduleRow(m,trackedNames=[]){
  const p1=playerByName(m.player1), p2=playerByName(m.player2);
  const p1Tracked=trackedNames.some(n=>sameName(n,m.player1));
  const p2Tracked=trackedNames.some(n=>sameName(n,m.player2));
  const v=venueVisual(m);
  return `<article class="vic-match-row ${isPast(m)?'past':''}">
    <div class="vic-time"><span class="vic-time-value">${esc(displayTime24(m.time))}</span><span class="vic-time-age">${esc(m.event||'')}</span></div>
    <div class="vic-match-main">
      <div class="vic-event"><span class="vic-mobile-meta"><span class="vic-mobile-time">${esc(displayTime24(m.time))}</span><span class="vic-mobile-location">${venueBadge(m)}<span class="vic-mobile-location-text">${esc(cleanVenuePlace(m))}</span></span><span class="vic-mobile-age">${esc(m.event||'')}</span></span><span class="vic-desktop-event"><span class="vic-event-category">${esc(m.event||'')}</span>${m.round?`<span class="vic-event-round"> · ${esc(m.round)}</span>`:''}</span></div>
      <div class="vic-fixture-line">
        <a class="${p1Tracked?'vic-tracked-player':''}" href="${playerPageUrl(m.player1,m.player1Id)}">
          <span class="fixture-player-desktop">${flagImg(p1)}<span class="vic-player-name-wrap"><span class="vic-player-name-meta-line">${playerNameStack(p1,m.player1,p1Tracked)}${p1?.country?`<small class="vic-player-inline-meta">${esc(p1.country)}</small>`:''}</span></span></span>
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
        <a class="${p2Tracked?'vic-tracked-player':''}" href="${playerPageUrl(m.player2,m.player2Id)}">
          <span class="fixture-player-desktop">${flagImg(p2)}<span class="vic-player-name-wrap"><span class="vic-player-name-meta-line">${playerNameStack(p2,m.player2,p2Tracked)}${p2?.country?`<small class="vic-player-inline-meta">${esc(p2.country)}</small>`:''}</span></span></span>
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
        ${m.result?`<span class="vic-result">${esc(m.result)}</span>`:''}
      </div>
    </div>
    <div class="vic-location" title="${esc(v.place)}">${v.code?`<span class="venue-letter venue-${v.code.toLowerCase()}" aria-hidden="true">${v.code}</span>`:''}<span>${esc(v.place)}</span></div>
  </article>`;
}
function featureVenueKey(m){
  return cleanVenuePlace(m).split(' · ')[0]||'Venue TBD';
}
function featureVenueOptions(){
  const map=new Map();
  for(const m of (data.matches||[])){
    const key=featureVenueKey(m); if(!key||key==='Venue / court TBD')continue;
    if(!map.has(key))map.set(key,key);
  }
  return [...map.keys()].sort((a,b)=>{
    const ag=/Karrinyup/i.test(a)?0:1,bg=/Karrinyup/i.test(b)?0:1;
    return ag-bg||a.localeCompare(b);
  });
}
let selectedFeatureVenue='';
let selectedFeatureDate='';
function featureMatchesForVenue(){
  return (data.matches||[]).filter(m=>featureVenueKey(m)===selectedFeatureVenue);
}
function renderFeatureCourt(date=selectedFeatureDate){
  selectedFeatureDate=date;
  qsa('.date-tab').forEach(x=>x.classList.toggle('active',x.dataset.date===date));
  const ms=featureMatchesForVenue().filter(m=>canonicalDate(m.date)===date).sort((a,b)=>to24(a.time||'').localeCompare(to24(b.time||'')));
  const title=qs('#featureCourtTitle'); if(title)title.textContent='Courts';
  qs('#glassMatches').innerHTML=ms.length?ms.map(m=>compactScheduleRow(m)).join(''):`<div class="schedule-empty"><strong>No matches found for this venue on ${esc(fmtDate(date).long)}.</strong></div>`;
  qs('#glassDayCount').textContent=ms.length;
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

function renderFavoritePlayers(){
  const favourites=getFavoriteNames().map(n=>playerByName(n)).filter(Boolean);
  const names=saveFavoriteNames(favourites.map(p=>p.name));
  const count=qs('#favoriteCount'),label=qs('#favoriteCountLabel');if(count)count.textContent=names.length;if(label)label.textContent=names.length===1?'player selected':'players selected';
  const list=qs('#favoritePlayerList'),matchesEl=qs('#favoriteMatches');if(!list||!matchesEl)return;
  if(!names.length){list.innerHTML='';matchesEl.innerHTML='<div class="schedule-empty"><strong>No favourite players yet.</strong><br><span>Open Players and tap ☆ Fav next to anyone you want to follow.</span></div>';return;}
  list.innerHTML=favourites.map(p=>`<div class="fav-player-card"><a class="fav-player-main" href="${playerPageUrl(p.name,p.officialPlayerId)}">${flagImg(p,'flag-img')}<span class="player-name-stack"><b>${esc(p.name)}</b>${squashBadges(p)}<small>${esc(p.country)} · ${p.ageGroup}+</small></span></a>${favoriteButton(p.name,'fav-remove-btn')}</div>`).join('');
  const map=new Map();
  for(const m of (data.matches||[])){
    const tracked=names.filter(n=>matchHas(m,n));if(!tracked.length)continue;
    const players=[nameKey(m.player1||''),nameKey(m.player2||'')].filter(Boolean).sort().join('|');
    const key=`${canonicalDate(m.date)}||${to24(m.time||'')}||${players}`;
    if(!map.has(key))map.set(key,{m,tracked:[...tracked]});
    else{const row=map.get(key);for(const n of tracked)if(!row.tracked.some(x=>sameName(x,n)))row.tracked.push(n);if(!row.m.result&&m.result)row.m=m;}
  }
  const rows=[...map.values()].sort((a,b)=>`${canonicalDate(a.m.date)} ${to24(a.m.time||'')}`.localeCompare(`${canonicalDate(b.m.date)} ${to24(b.m.time||'')}`));
  let day='',html='';
  for(const {m,tracked} of rows){const d=canonicalDate(m.date);if(d!==day){day=d;const f=fmtDate(d);html+=`<div class="vic-day-heading"><span>${esc(f.day)}</span><strong>${esc(f.date)}</strong></div>`;}html+=compactScheduleRow(m,tracked);}
  matchesEl.innerHTML=html||'<div class="schedule-empty"><strong>No published matches found for your favourite players.</strong></div>';refreshFavoriteButtons();
}
document.addEventListener('click',e=>{const btn=e.target.closest?.('[data-favourite-player]');if(!btn)return;e.preventDefault();e.stopPropagation();const n=btn.dataset.favouritePlayer||'';if(!n)return;toggleFavoritePlayer(n);refreshFavoriteButtons();if(location.hash==='#favorites')renderFavoritePlayers();});

function trackedMatchCard(m,name){
  const tracked=playerByName(name)||{name}, opp=opponentFor(m,name), op=playerByName(opp);
  return `<article class="tracked-match"><div class="tracked-match-top"><div><b>${fmtDate(m.date).long}</b><span>${esc([m.event,m.round].filter(Boolean).join(' · '))}</span></div><strong>${esc(displayTime24(m.time))}</strong></div><div class="tracked-fixture"><div class="tracked-side">${flagImg(tracked,'match-flag')}<div><small>TRACKED</small><a href="${playerPageUrl(name,tracked?.officialPlayerId)}"><span class="player-name-stack"><b>${esc(name)}</b>${squashBadges(tracked)}</span></a></div></div><div class="versus-badge">VS</div><div class="tracked-side right"><div><small>OPPONENT</small><a href="${playerPageUrl(opp,op?.officialPlayerId)}"><span class="player-name-stack"><b>${esc(opp||'TBD')}</b>${squashBadges(op)}</span></a></div>${flagImg(op,'match-flag')}</div></div><div class="roger-meta"><span>${esc(cleanVenuePlace(m))}</span>${m.result?`<span>${esc(m.result)}</span>`:''}</div></article>`;
}
function venueVisual(m){
  return {place:cleanVenuePlace(m),code:venueCode(m)};
}
function setupVicPark(){
  const names=VIC_PARK_PLAYERS;
  qs('#trackedCount').textContent=names.length;
  qs('#trackedCountLabel').textContent=names.length===1?'player tracked':'players tracked';

  const rows=[];
  for(const m of (vicParkMatches||[])){
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
      html+=`<div class="vic-day-heading"><span>${esc(f.day)}</span><strong>${esc(f.date)}</strong></div>`;
    }
    html+=compactScheduleRow(m,tracked);
  }
  container.innerHTML=html;
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
  renderHeaderRefresh();setupPlayersShell();stamp();
  const initial=location.hash.slice(1);
  if(['players','glass','vicpark','favorites'].includes(initial))await setPage(initial);
}
bootstrap();
