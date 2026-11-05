// Usage: node pinlock.cjs <repo> <distCommit> <sourceCommit> <manifestFile> [extraModule=file ...]
const fs=require('fs'),crypto=require('crypto'),path=require('path');
const [repo,distCommit,sourceCommit,manifestFile,...extra]=process.argv.slice(2);
const lockPath=path.join(repo,'gamekit.lock.json'),lock=JSON.parse(fs.readFileSync(lockPath,'utf8'));
const bytes=fs.readFileSync(manifestFile),manifest=JSON.parse(bytes);
for(const e of extra){const [name,file]=e.split('=');lock.modules[name]={file,sha256:''}}
for(const [name,entry] of Object.entries(lock.modules)){const m=manifest.modules.filter(x=>x.file===entry.file);if(m.length!==1)throw Error('manifest missing '+entry.file);entry.sha256=m[0].sha256}
lock.distCommit=distCommit;lock.sourceCommit=sourceCommit;lock.distManifestSha256=crypto.createHash('sha256').update(bytes).digest('hex');
fs.writeFileSync(lockPath,JSON.stringify(lock,null,2)+'\n');console.log('ok',Object.keys(lock.modules).length,lock.distManifestSha256);
