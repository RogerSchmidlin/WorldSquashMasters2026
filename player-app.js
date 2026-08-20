const data=window.TOURNAMENT_DATA, qs=s=>document.querySelector(s), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const basicNorm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[’‘]/g,"'").toLowerCase().replace(/[^a-z0-9']+/g,' ').trim();
const nameKey=s=>{let v=String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[’‘]/g,"'").trim();v=v.replace(/\[[^\]]*\]/g,' ').replace(/\((?:[A-Z]{2,3}|\d+)\)/g,' ').replace(/\b(?:AUS|ENG|SCO|WAL|SUI|NZL|USA|CAN|FRA|GER|DEU|IRL|RSA|IND|JPN|MAS|SGP|HKG)\b/gi,' ');if(v.includes(',')){const p=v.split(',').map(x=>x.trim()).filter(Boolean);if(p.length===2)v=p[1]+' '+p[0];}return v.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/).filter(Boolean).sort().join(' ')};
const sameName=(a,b)=>!!a&&!!b&&(basicNorm(a)===basicNorm(b)||nameKey(a)===nameKey(b));
const flatText=v=>{try{return typeof v==='string'?v:JSON.stringify(v)}catch{return String(v||'')}};
const playerNeedles=(data.players||[]).map(p=>({p,key:basicNorm(p.name)})).sort((a,b)=>b.key.length-a.key.length);
function canonicalDate(v){if(!v)return '';const s=String(v).trim();let m=s.match(/^(\d{4})-(\d{2})-(\d{2})/);if(m)return `${m[1]}-${m[2]}-${m[3]}`;m=s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/);if(m)return `${m[3]}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;const d=new Date(s);if(!Number.isNaN(d.getTime()))return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;return s;}
function namesFromRecord(m){const text=' '+basicNorm(flatText(m))+' ';const found=[];for(const x of playerNeedles){if(x.key.length>4&&text.includes(' '+x.key+' ')){found.push(x.p.name);if(found.length===2)break}}return found}
function normMatch(m){const raw=flatText(m.rawText||m.text||m.description||m);let p1=m.player1||m.playerOne||m.homePlayer||m.home||m.participant1||m.team1||m.entry1||'',p2=m.player2||m.playerTwo||m.awayPlayer||m.away||m.participant2||m.team2||m.entry2||'';const gn=v=>typeof v==='object'&&v?(v.name||v.displayName||v.fullName||v.title||v.label||''):String(v||'');p1=gn(p1);p2=gn(p2);if(!p1||!p2){const f=namesFromRecord(m);if(!p1)p1=f[0]||'';if(!p2)p2=f.find(n=>!sameName(n,p1))||f[1]||''}let venue=m.venue||m.venueName||m.location||m.locationName||m.site||m.facility||'',court=m.court||m.courtName||m.resource||m.resourceName||m.field||m.fieldName||'';if(typeof venue==='object')venue=venue.name||venue.title||venue.label||'';if(typeof court==='object')court=court.name||court.title||court.label||'';if(!venue){if(/Karrinyup/i.test(raw))venue='Karrinyup Shopping Centre';else if(/Mirrabooka/i.test(raw))venue='Squashworld Mirrabooka'}if(!court){const cm=raw.match(/(?:court(?:Name)?["':\s]*|\b)(AGC|SC\s*\d+|Court\s*\d+|[A-Z]{2,5}\s*\d+)\b/i);if(cm)court=cm[1]}return {...m,date:canonicalDate(m.date||m.matchDate||m.startDate||m.start||m.datetime||m.dateTime||m.scheduledDate),time:m.time||m.matchTime||m.startTime||m.scheduledTime||'',event:m.event||m.eventName||m.draw||m.category||m.disciplineName||'',round:m.round||m.roundName||'',player1:p1,player2:p2,venue,court,rawText:raw}}
data.matches=(data.matches||[]).map(normMatch);
const requested=new URLSearchParams(location.search).get('name')||'';
const p=data.players.find(x=>sameName(x.name,requested));
const name=p?.name||requested;
const flagImg=(x,cls='inline-flag')=>x?.flagCode?`<img class="${cls}" src="https://flagcdn.com/w160/${x.flagCode}.png" alt="${esc(x.country)} flag">`:'<span class="flag-fallback">🌐</span>';
const fmt=d=>{const x=new Date(d+'T12:00:00');return Number.isNaN(x.getTime())?{long:esc(d),day:''}:{long:x.toLocaleDateString('en-AU',{day:'numeric',month:'long'}),day:x.toLocaleDateString('en-AU',{weekday:'short'})}};
const has=(m,n)=>sameName(m.player1,n)||sameName(m.player2,n);
const opp=m=>sameName(m.player1,name)?m.player2:(sameName(m.player2,name)?m.player1:(namesFromRecord(m).find(n=>!sameName(n,name))||''));
const pb=n=>data.players.find(x=>sameName(x.name,n));
const past=m=>String(m.status||'').toLowerCase()==='completed'||String(m.status||'').toLowerCase()==='played'||!!m.result;
const venueCode=m=>{const place=[m.venue,m.court].filter(Boolean).join(' · ');if(/Karrinyup|\bAGC\b|Glass/i.test(place))return 'G';if(/Mirrabooka|Squashworld/i.test(place))return 'M';if(/Belmont|WA\s*State\s*Squash/i.test(place))return 'B';return '';};
const venueBadge=m=>{const c=venueCode(m);return c?`<span class="venue-letter venue-${c.toLowerCase()}" aria-hidden="true">${c}</span>`:'';};
const venuePlace=m=>[m.venue,m.court].filter(Boolean).join(' · ')||'Venue / court TBD';

function playerMatchRow(m){
  const p1=pb(m.player1),p2=pb(m.player2);
  const p1Current=sameName(m.player1,name),p2Current=sameName(m.player2,name);
  return `<article class="vic-match-row player-schedule-row ${past(m)?'past':''}">
    <div class="vic-time">${esc(m.time||'TBD')}</div>
    <div class="vic-match-main">
      <div class="vic-event">${esc([m.event,m.round].filter(Boolean).join(' · '))}</div>
      <div class="vic-fixture-line">
        <a href="player.html?name=${encodeURIComponent(m.player1)}">${flagImg(p1)}<b class="${p1Current?'vic-tracked-name':''}">${esc(m.player1||'TBD')}</b></a>
        <span class="vic-vs">vs</span>
        <a href="player.html?name=${encodeURIComponent(m.player2)}">${flagImg(p2)}<b class="${p2Current?'vic-tracked-name':''}">${esc(m.player2||'TBD')}</b></a>
        ${m.result?`<span class="vic-result">${esc(m.result)}</span>`:''}
      </div>
    </div>
    <div class="vic-location">${venueBadge(m)}<span>${esc(venuePlace(m))}</span></div>
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
  const ms=data.matches.filter(m=>has(m,name)).sort((a,b)=>`${a.date||''} ${a.time||''}`.localeCompare(`${b.date||''} ${b.time||''}`));
  qs('#playerHeader').innerHTML=`<div class="player-detail-card"><div class="player-detail-id">${flagImg(p,'tracked-flag')}<div><div class="eyebrow">${esc(p.country)} · ${esc(p.gender)} ${p.ageGroup}+</div><h1>${esc(p.name)}</h1></div></div><div class="status-chip">${ms.filter(m=>!past(m)).length} UPCOMING</div></div>`;
  const up=ms.filter(m=>!past(m)),done=ms.filter(past);
  qs('#playerSchedule').innerHTML=`<div class="schedule-group">${groupedMatches(up)}</div>${done.length?`<div class="schedule-group past-games-group"><div class="past-games-label">Past games</div>${groupedMatches(done)}</div>`:''}`;
}
