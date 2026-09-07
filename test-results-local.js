const fs=require('fs'), path=require('path');
const src=JSON.parse(fs.readFileSync(path.join(__dirname,'final-results-source.json'),'utf8'));
const rows=src.rows||[];
function group(g,a){return rows.filter(r=>r.gender===g&&Number(r.ageGroup)===a).sort((x,y)=>x.place-y.place).map(r=>r.playerName)}
function assert(cond,msg){if(!cond)throw new Error(msg)}
assert(rows.length===84,`expected 84 rows, got ${rows.length}`);
assert(!rows.some(r=>/^(?:bye|tbd)$/i.test(String(r.playerName||'').trim())),'Bye/TBD found');
const keys=new Set(rows.map(r=>`${r.gender}|${r.ageGroup}`));
assert(keys.size===21,`expected 21 groups, got ${keys.size}`);
for(const k of keys){const [g,a]=k.split('|');const x=group(g,Number(a));assert(x.length===4,`${k}: expected 4`);assert(new Set(x.map(s=>s.toLowerCase())).size===4,`${k}: duplicate player`)}
const expected={
  'Women|70':['Pauline Douglas','Gaye Mitchell','Melanie Knibbs','Napoti Teremaki'],
  'Women|75':['Margaret Hunt-Kemp','Claire Bryars','Lynette Woodyard','Nikki Mccullough'],
  'Men|80':['Gerald Poulton','Jose Luis Alba','Howard Armitage','Norbert Kornyei'],
  'Men|85':['Ray Villarroya','Peter Zillmer','Thomas Slattery','Barry Gardiner'],
  'Women|80':['Ann Manley','Pamela Moran','Gay Erskine','Christine Cooper']
};
for(const [k,v] of Object.entries(expected)){const [g,a]=k.split('|');const got=group(g,Number(a));assert(JSON.stringify(got)===JSON.stringify(v),`${k}: ${got.join(' > ')}`)}
console.log('RESULT SOURCE V28 TESTS PASSED');
console.log('84 rows / 21 groups / 0 Bye-TBD placements');
