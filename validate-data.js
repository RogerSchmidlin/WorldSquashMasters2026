const fs=require('fs'),path=require('path'),vm=require('vm');
const ctx={window:{}};vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'data.js'),'utf8'),ctx);
const d=ctx.window.TOURNAMENT_DATA||{}, ms=d.matches||[], names=d.trackedNames||[];
const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/).filter(Boolean).sort().join(' ');
const same=(a,b)=>a&&b&&norm(a)===norm(b);
const has=(m,n)=>same(m.player1,n)||same(m.player2,n);
const glass=m=>/karrinyup|\bagc\b/i.test([m.venue,m.court].join(' '));
console.log(`Players: ${d.players?.length||0}`);console.log(`Matches: ${ms.length}`);console.log(`Glass Court matches: ${ms.filter(glass).length}`);
for(const n of names) console.log(`${n}: ${ms.filter(m=>has(m,n)).length}`);
