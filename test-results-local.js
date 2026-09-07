const fs=require('fs');
const os=require('os');
const path=require('path');
const vm=require('vm');
const {execFileSync}=require('child_process');

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'wsm-results-'));
fs.copyFileSync(path.join(__dirname,'build-results-local.js'),path.join(tmp,'build-results-local.js'));
const keys=['Men|35','Men|40','Men|45','Men|50','Men|55','Men|60','Men|65','Men|70','Men|75','Men|80','Men|85','Women|35','Women|40','Women|45','Women|50','Women|55','Women|60','Women|65','Women|70','Women|75','Women|80'];
const players=[],matches=[];
const addp=(name,g,a)=>{if(!players.some(p=>p.name===name))players.push({name,gender:g,ageGroup:a,country:'Australia',iso3:'AUS',flagCode:'au'});};
const score='11-7, 11-8, 11-9';
const win=(date,time,event,round,p1,p2,winner)=>matches.push({date,time,event,round,player1:p1,player2:p2,result:score,winner,status:'completed'});

for(const key of keys){
  const [g,aa]=key.split('|'),a=+aa;
  if(key==='Men|85'||key==='Women|80')continue;
  const e=`${g==='Women'?"Women's":"Men's"} +${a}`;
  let names=[`${g}${a} A`,`${g}${a} B`,`${g}${a} C`,`${g}${a} D`];
  if(key==='Women|70')names=['Pauline Douglas','Gaye Mitchell','Semi Loser One','Semi Loser Two'];
  if(key==='Men|80')names=['Howard Armitage','Michael Millington','Robert Smith','Alastair James'];
  names.forEach(n=>addp(n,g,a));
  // Main-path quarterfinals: all four semifinalists are undefeated.
  names.forEach((n,i)=>{const q=`${g}${a} Q${i+1}`;addp(q,g,a);win('2026-09-04',`0${8+i}:00`,e,'quarter final',n,q,n);});
  // Championship semis and final.
  win('2026-09-05','10:00',e,'semi final',names[0],names[2],names[0]);
  win('2026-09-05','11:00',e,'semi final',names[1],names[3],names[1]);
  win('2026-09-06','14:00',e,'final',names[0],names[1],names[0]);
  if(key!=='Women|70')win('2026-09-06','12:00',e,'3rd/4th playoff',names[2],names[3],names[2]);

  // A second valid semi->final chain with ambiguous labels. These players have
  // already lost, so it is a consolation/placement branch and MUST be rejected.
  const side=[`${g}${a} X`,`${g}${a} Y`,`${g}${a} Z`,`${g}${a} W`];
  side.forEach((n,i)=>{addp(n,g,a);const opp=`${g}${a} M${i+1}`;addp(opp,g,a);win('2026-09-02',`1${i}:00`,e,'round of 32',n,opp,opp);});
  win('2026-09-05','15:00',e,'semi final',side[0],side[2],side[0]);
  win('2026-09-05','16:00',e,'semi final',side[1],side[3],side[1]);
  win('2026-09-06','16:30',e,'final',side[0],side[1],side[0]);
}

// Men 85+: six active players complete a round robin; a seventh is withdrawn.
const rr=['Ray Villarroya','Peter Zillmer','Thomas Slattery','Barry Gardiner','RR Five','RR Six'];
rr.forEach(n=>addp(n,'Men',85)); addp('Withdrawn Seven','Men',85);
for(let i=0;i<rr.length;i++)for(let j=i+1;j<rr.length;j++)win(`2026-09-0${1+(j%5)}`,`${10+i}:00`,"Men's +85",'',rr[i],rr[j],rr[i]);
for(let i=0;i<rr.length;i++)matches.push({date:`2026-09-0${1+(i%5)}`,time:`${16+i}:00`,event:"Men's +85",round:'',player1:'Withdrawn Seven',player2:'Bye',result:'',winner:'',status:'completed'});

// Women 80+: deliberately incomplete flattened match rows. The final official
// standings are already stored locally and must be used instead of inventing a bracket.
const w80=['Ann Manley','Pamela Moran','Gay Erskine','Christine Cooper','W80 Five'];
w80.forEach(n=>addp(n,'Women',80));
win('2026-09-01','10:00',"Women's +80",'',w80[0],w80[4],w80[0]);
win('2026-09-01','11:00',"Women's +80",'',w80[1],w80[4],w80[1]);
win('2026-09-02','10:00',"Women's +80",'',w80[2],w80[4],w80[2]);
win('2026-09-02','11:00',"Women's +80",'',w80[3],w80[4],w80[3]);
win('2026-09-03','10:00',"Women's +80",'',w80[0],w80[2],w80[0]);
win('2026-09-03','11:00',"Women's +80",'',w80[1],w80[3],w80[1]);
win('2026-09-04','10:00',"Women's +80",'',w80[0],w80[3],w80[0]);
win('2026-09-04','11:00',"Women's +80",'',w80[1],w80[2],w80[1]);

fs.writeFileSync(path.join(tmp,'players-data.js'),`window.TOURNAMENT_PLAYERS = ${JSON.stringify(players)};\n`);
fs.writeFileSync(path.join(tmp,'matches-data.js'),`window.TOURNAMENT_MATCHES = ${JSON.stringify(matches)};\n`);
const storedW80=['Ann Manley','Pamela Moran','Gay Erskine','Christine Cooper'].map((playerName,i)=>({gender:'Women',ageGroup:80,placeRank:i+1,place:String(i+1),playerName,country:'Australia',iso3:'AUS',flagCode:'au'}));
fs.writeFileSync(path.join(tmp,'results-data.js'),`window.TOURNAMENT_RESULTS = ${JSON.stringify({rows:storedW80})};\n`);

const log=execFileSync(process.execPath,['build-results-local.js'],{cwd:tmp,encoding:'utf8'});
const ctx={window:{}};vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(tmp,'results-data.js'),'utf8'),ctx);
const rows=ctx.window.TOURNAMENT_RESULTS.rows;
const names=key=>{const[g,a]=key.split('|');return rows.filter(x=>x.gender===g&&Number(x.ageGroup)===Number(a)).sort((x,y)=>x.placeRank-y.placeRank).map(x=>x.playerName)};
const eq=(actual,expected,label)=>{if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)};
eq(names('Women|70'),['Pauline Douglas','Gaye Mitchell','Bye','Bye'],'Women 70+');
eq(names('Men|80'),['Howard Armitage','Michael Millington','Robert Smith','Alastair James'],'Men 80+');
eq(names('Men|85'),['Ray Villarroya','Peter Zillmer','Thomas Slattery','Barry Gardiner'],'Men 85+');
eq(names('Women|80'),['Ann Manley','Pamela Moran','Gay Erskine','Christine Cooper'],'Women 80+');
if(rows.length!==84)throw new Error(`Expected 84 rows, got ${rows.length}`);
if(/RESULT Men\|35: championship semis Men35 X/.test(log))throw new Error('Consolation semifinal chain was selected.');
console.log('PASS: undefeated championship-semifinal progression rejects side branches; Women 70+ Bye/Bye; Men 80+ Howard; Men 85+ RR; Women 80+ stored standings fallback.');
