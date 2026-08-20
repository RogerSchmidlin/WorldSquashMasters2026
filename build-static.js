const fs=require('fs'),path=require('path'); const dir=__dirname;
const css=fs.readFileSync(path.join(dir,'styles.css'),'utf8'), data=fs.readFileSync(path.join(dir,'data.js'),'utf8'), app=fs.readFileSync(path.join(dir,'app.js'),'utf8');
function build(template,out,withApp){let s=fs.readFileSync(path.join(dir,template),'utf8').replace('/*__CSS__*/',css).replace('/*__DATA__*/',data); if(withApp)s=s.replace('/*__APP__*/',app); fs.writeFileSync(path.join(dir,out),s);}
build('index.template.html','index.html',true);build('player.template.html','player.html',false);console.log('Built self-contained index.html and player.html');
