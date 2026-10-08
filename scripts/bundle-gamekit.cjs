const fs=require('node:fs');
const path=require('node:path');
const {readGamekit}=require('./setup-gamekit.cjs');
const dataURL=(mime,bytes)=>`data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
function replaceOnce(source,marker,replacement,label){
  const matches=typeof marker==='string'?source.split(marker).length-1:[...source.matchAll(new RegExp(marker.source,'g'))].length;
  if(matches!==1)throw Error(`Expected exactly one ${label} marker; found ${matches}`);
  return source.replace(marker,()=>replacement);
}
const withoutBlockComments=source=>source.replace(/\/\*[\s\S]*?\*\//g,'');
const selfContainedURL=value=>/^(?:data:|blob:|https?:|wss?:|#)/i.test(value);
function checkResources(source,label,css=false){
  // Literal runtime loads (including bare paths) must not depend on the checkout.
  for(const match of source.matchAll(/\b(?:fetch|importScripts|Worker|SharedWorker|URL)\s*\(\s*(['"`])([^'"`]+)\1/g)){
    if(!selfContainedURL(match[2]))throw Error(`Unresolved relative runtime resource in ${label}: ${match[2]}`);
  }
  for(const match of source.matchAll(/\.(?:src|href|poster)\s*=\s*(['"`])([^'"`]+)\1/g)){
    if(!selfContainedURL(match[2]))throw Error(`Unresolved relative runtime resource in ${label}: ${match[2]}`);
  }
  if(css&&/@import\b/i.test(source))throw Error(`Unresolved CSS import in ${label}`);
  for(const match of (css?source:'').matchAll(/\burl\(\s*['"]?([^\s)'";]+)['"]?\s*\)/gi)){
    if(!selfContainedURL(match[1]))throw Error(`Unresolved relative CSS resource in ${label}: ${match[1]}`);
  }
}
function checkModule(source,label){
  const code=withoutBlockComments(source);
  // Pinned dist entry points and authored campaign data are dependency-free. Even an
  // absolute import must be reviewed rather than silently added to a data module.
  if(/\bimport\s*(?:\(|['"{*]|[\w$]+\s*(?:,|from\b))|\bexport\s+(?:\*|\{[^}]*\})\s*from\b/.test(code))throw Error(`Unresolved runtime import in ${label}`);
  checkResources(code,label);
}
function checkHTML(html){
  let moduleLoads=0,campaignLoads=0;
  for(const [,attrs,js]of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
    const code=withoutBlockComments(js);
    for(const match of code.matchAll(/\bimport\s*\(([\s\S]*?)\)/g)){
      // The only variable import is the verified module map loader above.
      if(match[1]==='url')moduleLoads++;else campaignLoads++;
      if(match[1]!=='url'&&!/^"data:text\/javascript;base64,[A-Za-z0-9+/=]+"$/.test(match[1]))throw Error('Unresolved runtime import in standalone HTML');
    }
    if(/\bimport\s+(?:['"{*]|[\w$]+\s*(?:,|from\b))|\bexport\s+(?:\*|\{[^}]*\})\s*from\b/.test(code))throw Error('Unresolved static import in standalone HTML');
    checkResources(code,'standalone HTML');
  }
  if(moduleLoads!==1||campaignLoads!==1)throw Error('Unexpected runtime import count in standalone HTML');
  for(const [tag]of html.matchAll(/<(?:script|link|img|source|video|audio|iframe|embed|object)\b[^>]*>/gi)){
    for(const match of tag.matchAll(/\b(?:src|href|poster|data|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)){
      const value=match[1]??match[2]??match[3];
      if(!selfContainedURL(value))throw Error(`Unresolved relative HTML resource: ${value}`);
    }
  }
  for(const [,quote,css]of html.matchAll(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/gi))checkResources(css,'inline stylesheet',true);
  for(const [,css]of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi))checkResources(css,'standalone stylesheet',true);
}
function bundleGame(root,source){
  const {lock,modules:moduleBytes}=readGamekit(root);
  const modules={};
  for(const [name,entry] of Object.entries(lock.modules)){
    const bytes=moduleBytes[name];
    checkModule(bytes.toString('utf8'),entry.file);
    modules[name]=dataURL('text/javascript',bytes);
  }
  let html=replaceOnce(source,/const RALLY_GAMEKIT_MODULES=Object\.freeze\(\{[^\n]+\}\);/,`const RALLY_GAMEKIT_MODULES=Object.freeze(${JSON.stringify(modules)});`,'Gamekit module map');
  html=replaceOnce(html,/const RALLY_GAMEKIT_SOURCE=Object\.freeze\(\{[^\n]+\}\);/,`const RALLY_GAMEKIT_SOURCE=Object.freeze(${JSON.stringify({repository:lock.repository,sourceCommit:lock.sourceCommit,distCommit:lock.distCommit})});`,'Gamekit provenance');
  const campaignBytes=fs.readFileSync(path.join(root,'campaign/campaigns.js'));
  checkModule(campaignBytes.toString('utf8'),'campaign/campaigns.js');
  const campaign=dataURL('text/javascript',campaignBytes);
  html=replaceOnce(html,'import(this.importAttempt?`./campaign/campaigns.js?retry=${this.importAttempt}`:"./campaign/campaigns.js")',`import(${JSON.stringify(campaign)})`,'campaign import');
  html=replaceOnce(html,'href="./icons/rally-180.png"',`href="${dataURL('image/png',fs.readFileSync(path.join(root,'icons/rally-180.png')))}"`,'touch icon');
  // Keep the same hosted install identity while standalone gameplay is self-contained.
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.webmanifest'),'utf8'));
  for(const icon of manifest.icons){
    const filename=path.resolve(root,icon.src);
    if(!filename.startsWith(path.resolve(root)+path.sep))throw Error('Manifest icon escapes checkout');
    icon.src=dataURL(icon.type,fs.readFileSync(filename));
  }
  const manifestScript=`<link rel="manifest" id="rallyReleaseManifest"><script>(()=>{const manifest=${JSON.stringify(manifest)};const base=/^https?:$/.test(location.protocol)?new URL('.',location.href).href:'https://byh-playground.github.io/rally-frontier/';for(const field of ['id','start_url','scope'])manifest[field]=new URL(manifest[field],base).href;document.getElementById('rallyReleaseManifest').href='data:application/manifest+json,'+encodeURIComponent(JSON.stringify(manifest));})();<\/script>`;
  // Validate before adding the deliberately relative install-identity calculation.
  html=replaceOnce(html,'<link rel="manifest" href="./manifest.webmanifest">','<!-- RALLY_RELEASE_MANIFEST -->','manifest link');
  checkHTML(html);
  return replaceOnce(html,'<!-- RALLY_RELEASE_MANIFEST -->',manifestScript,'release manifest');
}
module.exports={bundleGame};
