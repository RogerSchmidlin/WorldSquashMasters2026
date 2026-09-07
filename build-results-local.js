const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = __dirname;
const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const basicName = v => clean(v)
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[’‘]/g, "'")
  .toLowerCase()
  .replace(/\[[^\]]*\]/g, ' ')
  .replace(/\((?:[A-Z]{2,3}|\d+)\)/g, ' ')
  .replace(/\b(?:AUS|ENG|SCO|WAL|SUI|NZL|USA|CAN|FRA|GER|DEU|IRL|RSA|IND|JPN|MAS|SGP|HKG|ESP|FIN|BRA|PAK)\b/gi, ' ')
  .replace(/[^a-z0-9']+/g, ' ')
  .trim();
const nameKey = v => basicName(v).split(/\s+/).filter(Boolean).sort().join(' ');
const sameName = (a,b) => !!a && !!b && nameKey(a) === nameKey(b);

console.log('=== LOCAL RESULTS BUILD START ===');

function evalWindowFile(fileName) {
  const fp = path.join(DIR, fileName);
  if (!fs.existsSync(fp)) return {};
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(fp, 'utf8'), ctx, { filename: fileName });
  return ctx.window;
}

const legacy = evalWindowFile('data.js').TOURNAMENT_DATA || {};
const splitPlayers = evalWindowFile('players-data.js').TOURNAMENT_PLAYERS || [];
const splitMatches = evalWindowFile('matches-data.js').TOURNAMENT_MATCHES || [];
const players = Array.isArray(splitPlayers) && splitPlayers.length ? splitPlayers : (Array.isArray(legacy.players) ? legacy.players : []);
const matches = Array.isArray(splitMatches) && splitMatches.length ? splitMatches : (Array.isArray(legacy.matches) ? legacy.matches : []);
const resultsPack = evalWindowFile('results-data.js').TOURNAMENT_RESULTS || null;
const storedResultRows = [
  ...(Array.isArray(resultsPack) ? resultsPack : (Array.isArray(resultsPack?.rows) ? resultsPack.rows : [])),
  ...(Array.isArray(legacy.results) ? legacy.results : [])
];

if (matches.length < 100) {
  throw new Error(`Local match dataset looks incomplete (${matches.length}). Existing results-data.js was left unchanged.`);
}

const expectedKeys = [
  'Men|35','Men|40','Men|45','Men|50','Men|55','Men|60','Men|65','Men|70','Men|75','Men|80','Men|85',
  'Women|35','Women|40','Women|45','Women|50','Women|55','Women|60','Women|65','Women|70','Women|75','Women|80'
];

const byPlayerId = new Map();
const byPlayerName = new Map();
for (const p of players) {
  const id = String(p?.officialPlayerId || '');
  if (id) byPlayerId.set(id, p);
  const k = nameKey(p?.name || '');
  if (!k) continue;
  if (!byPlayerName.has(k)) byPlayerName.set(k, []);
  byPlayerName.get(k).push(p);
}

function genderNorm(v) {
  const s = clean(v);
  return /women|female/i.test(s) ? 'Women' : (/\bmen\b|male/i.test(s) ? 'Men' : '');
}

function playerFor(name, id='') {
  if (id && byPlayerId.has(String(id))) return byPlayerId.get(String(id));
  const a = byPlayerName.get(nameKey(name)) || [];
  return a.length === 1 ? a[0] : null;
}

function categoryFromText(text) {
  const s = clean(text);
  const age = (s.match(/\b(35|40|45|50|55|60|65|70|75|80|85)\+?\b/) || [])[1];
  const gender = /women/i.test(s) ? 'Women' : (/\bmen\b/i.test(s) ? 'Men' : '');
  return gender && age ? `${gender}|${Number(age)}` : '';
}

function categoryForMatch(m) {
  const fromText = categoryFromText(`${m?.event || ''} ${m?.drawName || ''}`);
  if (fromText) return fromText;
  const p1 = playerFor(m?.player1, m?.player1Id);
  const p2 = playerFor(m?.player2, m?.player2Id);
  if (!p1 || !p2) return '';
  const g1 = genderNorm(p1.gender), g2 = genderNorm(p2.gender);
  const a1 = Number(p1.ageGroup) || 0, a2 = Number(p2.ageGroup) || 0;
  return g1 && g1 === g2 && a1 && a1 === a2 ? `${g1}|${a1}` : '';
}

function concrete(m) {
  const a = clean(m?.player1), b = clean(m?.player2);
  return !!a && !!b && !/^(?:TBD|Bye)$/i.test(a) && !/^(?:TBD|Bye)$/i.test(b) && !sameName(a,b);
}

function scorePairs(result) {
  let pairs = [...clean(result).matchAll(/(\d{1,2})\s*[-–—]\s*(\d{1,2})/g)].map(x => [Number(x[1]), Number(x[2])]);
  // Some sources prefix the game score (e.g. 3-1) before per-game points.
  if (pairs.length > 1 && Math.max(...pairs[0]) <= 5 && pairs.slice(1).some(p => Math.max(...p) >= 11)) pairs = pairs.slice(1);
  return pairs;
}

function winnerLoser(m) {
  if (!concrete(m)) return null;
  const p1 = clean(m.player1), p2 = clean(m.player2);
  const id1 = String(m.player1Id || ''), id2 = String(m.player2Id || '');
  const w = clean(m.winner || '');
  const wid = String(m.winnerId || '');
  if (w && sameName(w,p1)) return {winner:{name:p1,id:id1}, loser:{name:p2,id:id2}, match:m};
  if (w && sameName(w,p2)) return {winner:{name:p2,id:id2}, loser:{name:p1,id:id1}, match:m};
  if (wid && id1 && wid === id1) return {winner:{name:p1,id:id1}, loser:{name:p2,id:id2}, match:m};
  if (wid && id2 && wid === id2) return {winner:{name:p2,id:id2}, loser:{name:p1,id:id1}, match:m};

  const pairs = scorePairs(m.result);
  if (pairs.length === 1 && Math.max(...pairs[0]) <= 5) {
    const [a,b] = pairs[0];
    if (a >= 3 && a > b) return {winner:{name:p1,id:id1}, loser:{name:p2,id:id2}, match:m};
    if (b >= 3 && b > a) return {winner:{name:p2,id:id2}, loser:{name:p1,id:id1}, match:m};
  }
  if (pairs.length >= 3 && pairs.length <= 5) {
    let a=0,b=0;
    for (const [x,y] of pairs) { if (x>y) a++; else if (y>x) b++; }
    if (a >= 3 && a > b) return {winner:{name:p1,id:id1}, loser:{name:p2,id:id2}, match:m};
    if (b >= 3 && b > a) return {winner:{name:p2,id:id2}, loser:{name:p1,id:id1}, match:m};
  }
  return null;
}

function canonicalDate(v) {
  const s = clean(v);
  let m = s.match(/\b(2026)[-\/.](\d{1,2})[-\/.](\d{1,2})\b/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;
  m = s.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](2026)\b/);
  if (m) return `${m[3]}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
  m = s.match(/\b(\d{1,2})\s+(Aug(?:ust)?|Sep(?:tember)?)\s*(?:2026)?\b/i);
  if (m) return `2026-${/^sep/i.test(m[2])?'09':'08'}-${String(m[1]).padStart(2,'0')}`;
  return '';
}

function stamp(m) {
  const d = canonicalDate(m?.date);
  if (!d) return '';
  const mt = clean(m?.time).match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i);
  if (!mt) return `${d}T00:00`;
  let h = Number(mt[1]); const min = Number(mt[2]); const ap=(mt[3]||'').toLowerCase();
  if (ap==='pm' && h<12) h+=12; if (ap==='am' && h===12) h=0;
  return `${d}T${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
}

function pairKeyNames(a,b) { return [nameKey(a),nameKey(b)].sort().join('~'); }
function pairKey(m) { return pairKeyNames(m?.player1,m?.player2); }
function stageText(m) {
  // TournamentSoftware does not consistently put the bracket type in the same
  // field. In the local dataset, words such as Consolation / 3rd-4th are often
  // stored in event while round only says Semi final. Always classify the stage
  // from all structural text fields together.
  return clean(`${m?.event || ''} ${m?.drawName || ''} ${m?.round || ''}`);
}
function sideBracket(m) {
  return /\b(?:consolation|plate|position|placement|classification|bronze|3rd|third|3\s*(?:[\/-]|and)\s*4|third\s*(?:[\/-]|and)\s*fourth|play[- ]?off|extra)\b/i.test(stageText(m));
}
function semiFinal(m) { return /\bsemi[- ]?finals?\b/i.test(stageText(m)) && !sideBracket(m); }
function explicitFinal(m) { return /\bfinals?\b/i.test(stageText(m)) && !/semi|quarter|consolation|plate|position|placement|classification|bronze|play[- ]?off|3rd|third/i.test(stageText(m)); }
function eliminationLabel(m) { return /\b(?:round\s+of|quarter[- ]?final|semi[- ]?final|final)\b/i.test(stageText(m)); }

function quality(m) {
  return (winnerLoser(m)?100000:0) + (explicitFinal(m)?20000:0) + (stamp(m)?1000:0) + (clean(m?.result)?100:0);
}

function uniqueBestByPair(rows) {
  const map = new Map();
  for (const m of rows) {
    if (!concrete(m) || !winnerLoser(m)) continue;
    const k = pairKey(m); if (!k) continue;
    const old = map.get(k);
    if (!old || quality(m) > quality(old) || (quality(m)===quality(old) && stamp(m)>stamp(old))) map.set(k,m);
  }
  return [...map.values()];
}

function laterThan(m, cutoff) {
  const s = stamp(m);
  if (!cutoff || !s) return true;
  return s > cutoff;
}

function findPairResult(rows, a, b, cutoff='', mode='any') {
  const target = pairKeyNames(a,b);
  const candidates = rows.filter(m => concrete(m) && pairKey(m)===target && winnerLoser(m) && laterThan(m,cutoff));
  if (!candidates.length) return null;
  candidates.sort((x,y) => {
    const xPref = mode==='final' ? (explicitFinal(x)?1:0) : (mode==='bronze' ? (sideBracket(x)?1:0) : 0);
    const yPref = mode==='final' ? (explicitFinal(y)?1:0) : (mode==='bronze' ? (sideBracket(y)?1:0) : 0);
    if (xPref!==yPref) return yPref-xPref;
    const xs=stamp(x), ys=stamp(y); if (xs!==ys) return ys.localeCompare(xs);
    return quality(y)-quality(x);
  });
  return winnerLoser(candidates[0]);
}

function decidedHistory(rows) {
  const by = new Map();
  for (const m of rows) {
    if (!concrete(m) || !winnerLoser(m)) continue;
    const st=stamp(m); if(!st) continue;
    const k=`${pairKey(m)}|${st}`;
    const old=by.get(k);
    if(!old || quality(m)>quality(old)) by.set(k,m);
  }
  return [...by.values()].sort((a,b)=>stamp(a).localeCompare(stamp(b)));
}

function priorLossCount(history, playerName, cutoff) {
  if(!playerName || !cutoff) return 0;
  let n=0;
  const seen=new Set();
  for(const m of history){
    const st=stamp(m); if(!st || st>=cutoff) break;
    const wl=winnerLoser(m); if(!wl || !sameName(wl.loser.name,playerName)) continue;
    const k=`${pairKey(m)}|${st}`; if(seen.has(k))continue; seen.add(k); n++;
  }
  return n;
}

function deriveFromSemis(key, rows) {
  const history=decidedHistory(rows);
  const allSemis = uniqueBestByPair(rows.filter(m=>/\bsemi[- ]?finals?\b/i.test(stageText(m))));
  // The championship semifinalists are still undefeated before their semifinal.
  // Consolation / placement semifinalists have already lost in the event, even
  // when the flattened local row has lost the word "Consolation".
  const semis = allSemis.filter(m=>{
    const st=stamp(m),wl=winnerLoser(m); if(!st||!wl)return false;
    return priorLossCount(history,m.player1,st)===0 && priorLossCount(history,m.player2,st)===0;
  });
  if (semis.length < 2) return null;
  const resolved = semis.map(m => ({m,wl:winnerLoser(m)})).filter(x=>x.wl);
  const candidates = [];
  for (let i=0;i<resolved.length;i++) for (let j=i+1;j<resolved.length;j++) {
    const a=resolved[i], b=resolved[j];
    const semiPlayers = [a.wl.winner.name,a.wl.loser.name,b.wl.winner.name,b.wl.loser.name].map(nameKey);
    if (new Set(semiPlayers).size !== 4) continue;
    const cutoff = [stamp(a.m),stamp(b.m)].filter(Boolean).sort().at(-1) || '';
    const final = findPairResult(rows,a.wl.winner.name,b.wl.winner.name,cutoff,'final');
    if (!final) continue;
    const fst=stamp(final.match);
    // Both finalists must still be undefeated before the championship final.
    if(fst && (priorLossCount(history,final.match.player1,fst)!==0 || priorLossCount(history,final.match.player2,fst)!==0)) continue;
    const bronze = findPairResult(rows,a.wl.loser.name,b.wl.loser.name,cutoff,'bronze');
    const semiGap=Math.abs(Date.parse(stamp(a.m)+':00Z')-Date.parse(stamp(b.m)+':00Z'))||0;
    const score = (explicitFinal(final.match)?1000000:0) + (fst?100000:0) - Math.min(semiGap,86400000)/1000 + (bronze?100:0);
    candidates.push({a,b,cutoff,final,bronze,score});
  }
  if (!candidates.length) return null;
  candidates.sort((x,y)=>y.score-x.score || stamp(y.final.match).localeCompare(stamp(x.final.match)));
  const best=candidates[0];
  return {
    method:'undefeated-semifinal-winners-head-to-head',
    placements:[best.final.winner,best.final.loser,best.bronze?.winner||{name:'Bye',id:''},best.bronze?.loser||{name:'Bye',id:''}],
    detail:`championship semis ${best.a.wl.winner.name} > ${best.a.wl.loser.name}; ${best.b.wl.winner.name} > ${best.b.wl.loser.name} -> final ${best.final.winner.name} > ${best.final.loser.name}; bronze ${best.bronze?`${best.bronze.winner.name} > ${best.bronze.loser.name}`:'Bye / Bye'}`
  };
}

function scoreDiff(m) {
  const pairs=scorePairs(m?.result);
  let gameDiff=0,pointDiff=0;
  for (const [a,b] of pairs) {
    if (Math.max(a,b)<=5 && pairs.length===1) { gameDiff=a-b; continue; }
    gameDiff += a>b ? 1 : (b>a ? -1 : 0); pointDiff += a-b;
  }
  return {gameDiff,pointDiff};
}

function deriveRoundRobin(key, rows) {
  const decided = uniqueBestByPair(rows.filter(m=>concrete(m)&&winnerLoser(m)));
  if (!decided.length) return null;

  // Build the decided head-to-head graph. Do NOT search every combination of
  // players: the old exhaustive clique search can become exponential and make
  // `npm run refresh` appear to hang. Instead find a large complete active set
  // with deterministic degree/neighbour pruning. Tournament round robins are
  // dense graphs, so this is both fast and reliable for the local final data.
  const people = new Map();
  const edge = new Map();
  const adj = new Map();
  const addAdj=(a,b)=>{if(!adj.has(a))adj.set(a,new Set());adj.get(a).add(b);};
  for (const m of decided) {
    const a=nameKey(m.player1), b=nameKey(m.player2);
    if(!a||!b||a===b)continue;
    people.set(a,clean(m.player1)); people.set(b,clean(m.player2));
    edge.set([a,b].sort().join('~'),m);
    addAdj(a,b); addAdj(b,a);
  }
  const keys=[...people.keys()];
  if(keys.length<4)return null;

  const connected=(a,b)=>edge.has([a,b].sort().join('~'));
  const isClique=sub=>{
    for(let i=0;i<sub.length;i++)for(let j=i+1;j<sub.length;j++)if(!connected(sub[i],sub[j]))return false;
    return true;
  };

  // Greedy complete-set search, seeded from every player and from highest-degree
  // order. This is O(V^3), not exponential. Keep the largest clique found.
  const degree=k=>(adj.get(k)?.size||0);
  const order=[...keys].sort((a,b)=>degree(b)-degree(a)||people.get(a).localeCompare(people.get(b)));
  let active=[];
  const trySeed=seed=>{
    const candidates=order.filter(k=>k!==seed&&connected(seed,k));
    const clique=[seed];
    for(const k of candidates){
      if(clique.every(x=>connected(x,k)))clique.push(k);
    }
    if(clique.length>active.length)active=clique;
  };
  for(const seed of order)trySeed(seed);

  // A second deterministic pass starts with every connected pair. This handles
  // cases where the single-seed greedy ordering encounters a withdrawn player
  // before a genuine active round-robin member.
  for(let i=0;i<order.length;i++){
    for(let j=i+1;j<order.length;j++){
      const a=order[i],b=order[j]; if(!connected(a,b))continue;
      const clique=[a,b];
      for(const k of order){
        if(k===a||k===b)continue;
        if(clique.every(x=>connected(x,k)))clique.push(k);
      }
      if(clique.length>active.length)active=clique;
    }
  }

  if(active.length<4 || !isClique(active))return null;
  const expected=active.length*(active.length-1)/2;
  if(expected<6)return null;
  const activeSet=new Set(active);
  const pairEvidence=new Map();
  for(const [pk,m] of edge){
    const [a,b]=pk.split('~');
    if(activeSet.has(a)&&activeSet.has(b))pairEvidence.set(pk,winnerLoser(m));
  }
  if(pairEvidence.size!==expected)return null;

  const stats=new Map(active.map(k=>[k,{person:{name:people.get(k),id:''},wins:0,losses:0,gameDiff:0,pointDiff:0}]));
  for(const e of pairEvidence.values()){
    if(!e)continue;
    const wk=nameKey(e.winner.name),lk=nameKey(e.loser.name),ws=stats.get(wk),ls=stats.get(lk);if(!ws||!ls)continue;
    ws.wins++;ls.losses++;
    const m=e.match||{},sd=scoreDiff(m),p1k=nameKey(m.player1),p2k=nameKey(m.player2);
    if(p1k===wk){ws.gameDiff+=sd.gameDiff;ws.pointDiff+=sd.pointDiff;ls.gameDiff-=sd.gameDiff;ls.pointDiff-=sd.pointDiff;}
    else if(p2k===wk){ws.gameDiff-=sd.gameDiff;ws.pointDiff-=sd.pointDiff;ls.gameDiff+=sd.gameDiff;ls.pointDiff+=sd.pointDiff;}
  }
  const all=[...stats.values()];
  const miniWins=stat=>{const tied=new Set(all.filter(x=>x.wins===stat.wins).map(x=>nameKey(x.person.name)));let n=0;for(const e of pairEvidence.values()){if(!e)continue;const w=nameKey(e.winner.name),l=nameKey(e.loser.name);if(tied.has(w)&&tied.has(l)&&w===nameKey(stat.person.name))n++;}return n;};
  all.sort((a,b)=>b.wins-a.wins||miniWins(b)-miniWins(a)||b.gameDiff-a.gameDiff||b.pointDiff-a.pointDiff||a.person.name.localeCompare(b.person.name));
  if(all.length<4)return null;
  return {method:'fast-active-round-robin-standings',placements:all.slice(0,4).map(x=>x.person),detail:`active round robin ${all.slice(0,4).map(x=>`${x.person.name} (${x.wins} wins)`).join(' > ')} [${pairEvidence.size}/${expected} pairs]`};
}

function deriveStoredStandings(key) {
  const [gender,ageRaw]=key.split('|'),age=Number(ageRaw);
  const candidates=storedResultRows.filter(r=>{
    const g=genderNorm(r?.gender)||categoryFromText(r?.event||'').split('|')[0];
    const a=Number(r?.ageGroup)||Number((clean(r?.event).match(/\b(35|40|45|50|55|60|65|70|75|80|85)\+?\b/)||[])[1])||0;
    return g===gender && a===age;
  });
  const byPlace=new Map();
  for(const r of candidates){
    const place=Number(r?.placeRank||r?.place); const name=clean(r?.playerName||r?.name||'');
    if(place<1||place>4||!name||/^bye$/i.test(name))continue;
    if(!byPlace.has(place))byPlace.set(place,r);
  }
  if(![1,2,3,4].every(p=>byPlace.has(p)))return null;
  const rows=[1,2,3,4].map(p=>byPlace.get(p));
  if(new Set(rows.map(r=>nameKey(r.playerName||r.name))).size!==4)return null;
  return {
    method:'local-stored-standings-snapshot',
    placements:rows.map(r=>({name:clean(r.playerName||r.name),id:String(r.officialPlayerId||''),snapshot:r})),
    detail:`stored local standings ${rows.map(r=>clean(r.playerName||r.name)).join(' > ')}`
  };
}

function deriveDirectFinal(key, rows) {
  const finals = rows.filter(m=>concrete(m)&&winnerLoser(m)&&explicitFinal(m));
  if (!finals.length) return null;
  finals.sort((a,b)=>stamp(b).localeCompare(stamp(a))||quality(b)-quality(a));
  const wl=winnerLoser(finals[0]);
  return {method:'direct-final-no-semifinals',placements:[wl.winner,wl.loser,{name:'Bye',id:''},{name:'Bye',id:''}],detail:`direct final ${wl.winner.name} > ${wl.loser.name}; bronze Bye / Bye`};
}

function enrichPerson(person, gender, ageGroup, place, method) {
  if (person.name === 'Bye') {
    return {event:`${gender==='Women'?"Women's":"Men's"} +${ageGroup}`,gender,ageGroup,place:String(place),placeRank:place,playerName:'Bye',officialPlayerId:'',officialProfileUrl:'',country:'',iso3:'',flagCode:'',countryCode:'',seed:'',squashLevelsWorldRank:null,squashLevelsLevel:null,squashLevelsLevelProvisional:false,club:'',source:'Local completed tournament matches',sourceUrl:'',resultMethod:method};
  }
  const p=playerFor(person.name,person.id)||{}; const snap=person.snapshot||{};
  return {
    event:`${gender==='Women'?"Women's":"Men's"} +${ageGroup}`,gender,ageGroup,place:String(place),placeRank:place,
    playerName:p.name||person.name,officialPlayerId:p.officialPlayerId||person.id||snap.officialPlayerId||'',officialProfileUrl:p.officialProfileUrl||snap.officialProfileUrl||'',
    country:p.country||snap.country||'',iso3:p.iso3||snap.iso3||'',flagCode:p.flagCode||snap.flagCode||'',countryCode:p.drawCountryCode||p.countryCode||snap.countryCode||'',seed:clean(p.seed||snap.seed||''),
    squashLevelsWorldRank:p.squashLevelsWorldRank??snap.squashLevelsWorldRank??null,squashLevelsLevel:p.squashLevelsLevel??snap.squashLevelsLevel??null,squashLevelsLevelProvisional:!!(p.squashLevelsLevelProvisional||snap.squashLevelsLevelProvisional),
    club:clean(p.squashLevelsClubLocation||snap.club||''),source:'Local completed tournament matches / stored local standings',sourceUrl:'',resultMethod:method
  };
}

const rowsByKey = new Map(expectedKeys.map(k=>[k,[]]));
for (const m of matches) {
  const key=categoryForMatch(m); if(rowsByKey.has(key)) rowsByKey.get(key).push(m);
}

const outputRows=[];
const unresolved=[];
const audit=[];
for (const key of expectedKeys) {
  console.log(`  Processing ${key}...`);
  const [gender,ageRaw]=key.split('|'), ageGroup=Number(ageRaw), groupRows=rowsByKey.get(key)||[];
  let result=deriveFromSemis(key,groupRows);
  if (!result) result=deriveRoundRobin(key,groupRows);
  if (!result) result=deriveStoredStandings(key);
  if (!result) result=deriveDirectFinal(key,groupRows);
  if (!result) { unresolved.push(`${key} (${groupRows.length} local rows)`); continue; }
  result.placements.forEach((p,i)=>outputRows.push(enrichPerson(p,gender,ageGroup,i+1,result.method)));
  audit.push({key,method:result.method,detail:result.detail,localRows:groupRows.length});
  console.log(`  RESULT ${key}: ${result.detail}`);
}

if (unresolved.length) {
  throw new Error(`Could not derive Results from local matches for ${unresolved.length} group(s): ${unresolved.join('; ')}. Existing results-data.js was left unchanged.`);
}
if (outputRows.length !== expectedKeys.length*4) {
  throw new Error(`Expected ${expectedKeys.length*4} result rows, built ${outputRows.length}. Existing results-data.js was left unchanged.`);
}
for (const key of expectedKeys) {
  const [g,a]=key.split('|'); const r=outputRows.filter(x=>x.gender===g&&Number(x.ageGroup)===Number(a));
  if (r.length!==4 || ![1,2,3,4].every(p=>r.some(x=>Number(x.placeRank)===p)) || r.some(x=>x.placeRank<=2&&x.playerName==='Bye')) {
    throw new Error(`Validation failed for ${key}. Existing results-data.js was left unchanged.`);
  }
}

const pack={
  refreshedAt:'2026-09-06T23:59:00+08:00',generatedAt:'2026-09-06T23:59:00+08:00',
  source:'Local completed tournament matches',sourceUrl:'',algorithm:'undefeated-semifinal-progression-v4-fast-round-robin',rows:outputRows,audit
};
const target=path.join(DIR,'results-data.js');
const out=`window.TOURNAMENT_RESULTS = ${JSON.stringify(pack)};\n`;
const previous=fs.existsSync(target)?fs.readFileSync(target,'utf8'):'';
if(previous!==out)fs.writeFileSync(target,out);
console.log('\n=== LOCAL RESULTS BUILD ===');
console.log(`Local matches read: ${matches.length}`);
console.log(`Local players read: ${players.length}`);
console.log(`Result groups: ${expectedKeys.length}`);
console.log(`Result rows: ${outputRows.length}`);
console.log(previous===out?'results-data.js is already up to date.':'Wrote only results-data.js.');
console.log('No browser launched. No scraping. No network request made.');
