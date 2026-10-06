const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const dataURL=(mime,bytes)=>`data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
function bundleGame(root,source){
  const lock=JSON.parse(fs.readFileSync(path.join(root,'vendor/gamekit/provenance.json'),'utf8'));
  const modules={};
  for(const [name,entry] of Object.entries(lock.modules)){
    const bytes=fs.readFileSync(path.join(root,'vendor/gamekit',entry.file));
    if(crypto.createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw Error(`Gamekit integrity mismatch: ${entry.file}`);
    modules[name]=dataURL('text/javascript',bytes);
  }
  const marker=/const RALLY_GAMEKIT_MODULES=Object\.freeze\(\{[^\n]+\}\);/;
  if(!marker.test(source))throw Error('Gamekit source module map missing');
  let html=source.replace(marker,`const RALLY_GAMEKIT_MODULES=Object.freeze(${JSON.stringify(modules)});`);
  html=html.replace(/const RALLY_GAMEKIT_SOURCE=Object\.freeze\(\{[^\n]+\}\);/,`const RALLY_GAMEKIT_SOURCE=Object.freeze(${JSON.stringify({repository:lock.repository,sourceCommit:lock.sourceCommit,distCommit:lock.distCommit})});`);
  const campaign=dataURL('text/javascript',fs.readFileSync(path.join(root,'campaign/campaigns.js')));
  html=html.replace('import(this.importAttempt?`./campaign/campaigns.js?retry=${this.importAttempt}`:"./campaign/campaigns.js")',`import(${JSON.stringify(campaign)})`);
  html=html.replace('href="./icons/rally-180.png"',`href="${dataURL('image/png',fs.readFileSync(path.join(root,'icons/rally-180.png')))}"`);
  // Keep the same hosted install identity while standalone gameplay is self-contained.
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.webmanifest'),'utf8'));
  for(const icon of manifest.icons)icon.src=dataURL(icon.type,fs.readFileSync(path.join(root,icon.src)));
  const manifestScript=`<link rel="manifest" id="rallyReleaseManifest"><script>(()=>{const manifest=${JSON.stringify(manifest)};const base=/^https?:$/.test(location.protocol)?new URL('.',location.href).href:'https://byh-playground.github.io/rally-frontier/';for(const field of ['id','start_url','scope'])manifest[field]=new URL(manifest[field],base).href;document.getElementById('rallyReleaseManifest').href='data:application/manifest+json,'+encodeURIComponent(JSON.stringify(manifest));})();<\/script>`;
  html=html.replace('<link rel="manifest" href="./manifest.webmanifest">',manifestScript);
  return html;
}
module.exports={bundleGame};
