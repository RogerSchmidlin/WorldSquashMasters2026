const fs=require('fs'), vm=require('vm'), path=require('path');
const source=fs.readFileSync(path.join(__dirname,'refresh-data.js'),'utf8');
const cut=source.indexOf('(async()=>{');
if(cut<0)throw new Error('Could not isolate refresh helpers');
const fakeRequire=id=>id==='playwright'?{chromium:{}}:require(id);
const ctx={require:fakeRequire,console,process:{...process,argv:['node','test']},__dirname,__filename:path.join(__dirname,'refresh-data.js'),Buffer,setTimeout,clearTimeout,URL,fetch:global.fetch};
vm.createContext(ctx);vm.runInContext(source.slice(0,cut),ctx,{filename:'refresh-data.js'});

function player(name,gender,age,id){return {name,gender,ageGroup:age,officialPlayerId:id||name,country:'Australia',drawCountryCode:'AUS',flagCode:'au'};}
const rrNames=['Ray Villarroya','Peter Zillmer','Geoffrey Coyne','Barry Gardiner','Robert Eather','Thomas Slattery','David Bloch'];
const players=[
  player('Michael Corren','Men',50),player('Alexander Clark','Men',50),player('Zuko Kubukeli','Men',50),player('Adam Dominey','Men',50),
  player('Samantha Foyle','Women',35),player('Zoe Petrovansky','Women',35),player('Kasey Bonato','Women',35),player('Heather Pilley','Women',35),
  ...rrNames.map(n=>player(n,'Men',85,n)),
  player('Melanie Knibbs','Women',70),player('Michel Galloway','Women',70),player('Pauline Douglas','Women',70),player('Gaye Mitchell','Women',70)
];
function row(drawUrl,p1,p2,winner,slots={},extra={}){
 return {drawUrl,drawName:extra.drawName||'',player1:p1,player2:p2,winner,status:'completed',result:extra.result||'11-5, 11-6, 11-7',treeInputSlot1:slots.a||'',treeInputSlot2:slots.b||'',treeOutputSlot:slots.o||'',treeCaption:extra.caption||'',round:extra.round||'',date:extra.date||'',time:extra.time||'',drawResultOrder:extra.order||0,treeSource:'legacy-slot-tree'};
}
const drawCatalog=[
 {href:'m50',text:"Men's +50"},{href:'m50b',text:"Men's +50 - Men's +50-3rd/4th",stageExtra:true},
 {href:'w35',text:"Women's +35"},{href:'w35b',text:"Women's +35 - Women's +35-3rd/4th",stageExtra:true},
 {href:'m85',text:"Men's 85+"},
 {href:'w70',text:"Women's +70"},{href:'w70b',text:"Women's +70 - Women's+70-3/4 Place",stageExtra:true}
];
const resultMatches=[
 row('m50','Michael Corren','Zuko Kubukeli','Michael Corren',{a:'3001',b:'3002',o:'2001'},{order:10}),
 row('m50','Alexander Clark','Adam Dominey','Alexander Clark',{a:'3003',b:'3004',o:'2002'},{order:11}),
 row('m50','Michael Corren','Alexander Clark','Michael Corren',{a:'2001',b:'2002',o:'1001'},{order:12}),
 row('m50b','Zuko Kubukeli','Adam Dominey','Zuko Kubukeli',{a:'2001',b:'2002',o:'1001'},{order:20}),
 row('w35','Samantha Foyle','Kasey Bonato','Samantha Foyle',{a:'3001',b:'3002',o:'2001'},{order:30}),
 row('w35','Zoe Petrovansky','Heather Pilley','Zoe Petrovansky',{a:'3003',b:'3004',o:'2002'},{order:31}),
 row('w35','Samantha Foyle','Zoe Petrovansky','Samantha Foyle',{a:'2001',b:'2002',o:'1001'},{order:32}),
 row('w35b','Kasey Bonato','Heather Pilley','Kasey Bonato',{a:'2001',b:'2002',o:'1001'},{order:40}),
 // Women 70 main final. Separate 3/4 draw intentionally has NO structural match row.
 row('w70','Melanie Knibbs','Pauline Douglas','Melanie Knibbs',{a:'3001',b:'3002',o:'2001'},{order:41}),
 row('w70','Michel Galloway','Gaye Mitchell','Michel Galloway',{a:'3003',b:'3004',o:'2002'},{order:42}),
 row('w70','Melanie Knibbs','Michel Galloway','Melanie Knibbs',{a:'2001',b:'2002',o:'1001'},{order:43})
];
// Men 85 true round robin: ranking order beats every player below it.
let order=100;
for(let i=0;i<rrNames.length;i++)for(let j=i+1;j<rrNames.length;j++){
  resultMatches.push(row('m85',rrNames[i],rrNames[j],rrNames[i],{}, {order:order++,round:`Round ${j}`,date:`2026-09-${String(1+j).padStart(2,'0')}`,time:'10:00'}));
}
// Add a misleading bracket-looking edge; RR standings must override it.
resultMatches.push(row('m85','Barry Gardiner','Geoffrey Coyne','Barry Gardiner',{a:'2003',b:'2004',o:'1002'},{order:999}));

const drawSnapshots=[
 {drawUrl:'m85',players:rrNames.map(n=>({name:n,officialPlayerId:n}))},
 {drawUrl:'w70b',players:[{name:'Pauline Douglas',officialPlayerId:'Pauline Douglas'},{name:'Gaye Mitchell',officialPlayerId:'Gaye Mitchell'}]}
];
const officialRows=[
 row('', 'Pauline Douglas','Gaye Mitchell','Pauline Douglas',{}, {date:'2026-09-06',time:'12:00',result:'11-7, 11-8, 11-9'})
];
const champions=[
 {key:'Men|50',playerName:'Michael Corren'},
 {key:'Women|35',playerName:'Samantha Foyle'},
 {key:'Men|85',playerName:'Ray Villarroya'},
 {key:'Women|70',playerName:'Melanie Knibbs'}
];
ctx.TEST_DRAW={drawCatalog,resultMatches,matches:[],drawSnapshots,treeDrawStats:[]};
ctx.TEST_PLAYERS=players;ctx.TEST_CHAMPIONS=champions;ctx.TEST_OFFICIAL=officialRows;
const results=vm.runInContext('buildOfficialTopFourFromDraws(TEST_DRAW,TEST_PLAYERS,TEST_OFFICIAL,TEST_CHAMPIONS)',ctx);
function group(g,a){return results.filter(r=>r.gender===g&&Number(r.ageGroup)===a).sort((x,y)=>x.placeRank-y.placeRank).map(r=>r.playerName);}
const cases=[
 ['Men',50,['Michael Corren','Alexander Clark','Zuko Kubukeli','Adam Dominey']],
 ['Women',35,['Samantha Foyle','Zoe Petrovansky','Kasey Bonato','Heather Pilley']],
 ['Women',70,['Melanie Knibbs','Michel Galloway','Pauline Douglas','Gaye Mitchell']],
 ['Men',85,['Ray Villarroya','Peter Zillmer','Geoffrey Coyne','Barry Gardiner']]
];
for(const [g,a,expected] of cases){
 const actual=group(g,a);
 if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(`${g} ${a}+ failed: ${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`);
 console.log(`PASS ${g} ${a}+: ${actual.join(' > ')}`);
}
ctx.TEST_RESULTS=results;ctx.TEST_CHAMPIONS2=champions;ctx.TEST_PLAYERS2=players;
vm.runInContext("validateDrawChampionsAgainstOfficialWinners(TEST_RESULTS,TEST_CHAMPIONS2,TEST_PLAYERS2)",ctx);
console.log('RESULT SELECTOR V11 TESTS PASSED');
