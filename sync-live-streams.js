const fs=require('fs');

const input='live-streams.json';
const output='live-streams.js';

const json=JSON.parse(fs.readFileSync(input,'utf8'));

for(const stream of Array.isArray(json.streams)?json.streams:[]){
  const match=String(stream.url||'').match(/https:\/\/\S+/i);
  stream.url=match?match[0]:'';
}

fs.writeFileSync(
  output,
  '// Generated from live-streams.json for file:// local-browser fallback.\n'+
  'window.LIVE_STREAM_CONFIG='+JSON.stringify(json)+';\n',
  'utf8'
);

console.log(`Updated ${output} from ${input}`);
