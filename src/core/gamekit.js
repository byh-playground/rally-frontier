// Loads the pinned GameKit dist (SHA-256 checked) and the unit SVG assets; modules that use GameKit evaluate after this resolves.
const RALLY_GAMEKIT_MODULES=Object.freeze({"rollback":"rollback.js","deterministic":"deterministic.js","simloop":"simloop.js","transport":"transport.js","interpolation":"interpolation.js","input":"input.js","rendering":"rendering.js","vectorAssets":"vector-assets.js","camera":"camera.js","events":"presentation-events.js","hud":"hud.js","debug":"debug-tools.js","vectorAssetsLoader":"vector-assets-loader.js","navigation":"navigation.js","objectPool":"object-pool.js","geometry":"geometry.js"});
// A dedicated Worker hosts only a simulation session (src/sim-worker.js): no UI boot.
const SIM_WORKER=typeof WorkerGlobalScope!=='undefined';
// Resolve from this module so the page and the Worker realm load the same files.
const RALLY_ASSET_ROOT=new URL('../../',import.meta.url);
const RALLY_GAMEKIT_SOURCE=Object.freeze({lock:new URL('gamekit.lock.json',RALLY_ASSET_ROOT).href});
const RALLY_VECTOR_ASSET_MANIFEST_URL=new URL('assets/units/manifest.json',RALLY_ASSET_ROOT).href;
let RALLY_NETCODE_URL=RALLY_GAMEKIT_SOURCE.lock;
let RallyNetcode,RallyGamekit;
async function loadRallyVectorAssets(loaderModule){
  const response=await fetch(RALLY_VECTOR_ASSET_MANIFEST_URL,{cache:'no-store'});
  if(!response.ok)throw new Error('Unit SVG manifest를 불러오지 못했습니다.');
  const manifest=await response.json();
  if(!manifest||manifest.schemaVersion!==1||!Array.isArray(manifest.assets)||!manifest.assets.length||manifest.assets.length>1024)throw new Error('Unit SVG manifest 형식이 올바르지 않습니다.');
  const ids=new Set();
  for(const entry of manifest.assets){
    if(!entry||Object.keys(entry).sort().join(',')!=='bytes,id,sha256,sourcePath,url'||typeof entry.id!=='string'||!/^[a-z0-9][a-z0-9-]*$/.test(entry.id)||ids.has(entry.id))throw new Error('Unit SVG id가 올바르지 않거나 중복되었습니다.');
    ids.add(entry.id);
    const sourcePath=`assets/units/${entry.id}.svg`;
    if(entry.sourcePath!==sourcePath||!Number.isSafeInteger(entry.bytes)||entry.bytes<1||entry.bytes>524288||!/^[a-f0-9]{64}$/.test(entry.sha256||''))throw new Error('Unit SVG manifest entry가 올바르지 않습니다: '+entry.id);
    if(entry.url!==`./${sourcePath}`)throw new Error('Unit SVG URL이 허용되지 않습니다: '+entry.id);
  }
  if(typeof loaderModule?.createVectorAssetLoader!=='function')throw new Error('Gamekit vector asset loader API가 없습니다.');
  const loader=loaderModule.createVectorAssetLoader({maxEntries:manifest.assets.length});
  // Preserve the pre-upgrade SVG geometry: curve16 and round-stroke arc12.
  const loaded=await Promise.all(manifest.assets.map(async entry=>{
    const asset=await loader.load(new URL(entry.sourcePath,RALLY_ASSET_ROOT).href,{sourcePath:entry.sourcePath,expectedSha256:entry.sha256,maxBytes:entry.bytes,curveSegments:16,strokeArcDivisions:12,includeSourcePaths:false});
    if(asset.sourceSha256!==entry.sha256||Object.hasOwn(asset,'sourcePaths'))throw new Error('Unit SVG 무결성 또는 compiler output 검증에 실패했습니다: '+entry.id);
    return [entry.id,asset];
  }));
  if(loader.size!==manifest.assets.length)throw new Error('Unit SVG cache 검증에 실패했습니다.');
  return {assets:Object.freeze(Object.fromEntries(loaded)),loader};
}
try{
  const lockResponse=await fetch(RALLY_GAMEKIT_SOURCE.lock,{cache:'no-store'});
  if(!lockResponse.ok)throw new Error('Gamekit lock를 불러오지 못했습니다. npm run setup:gamekit 후 HTTP 서버를 실행해 주세요.');
  const gamekitLock=await lockResponse.json();
  if(gamekitLock.repository!=='byh-playground/bloom-gamekit'||!/^[a-f0-9]{40}$/.test(gamekitLock.sourceCommit||'')||!/^[a-f0-9]{40}$/.test(gamekitLock.distCommit||''))throw new Error('Gamekit lock 출처가 올바르지 않습니다.');
  const gamekitSource=Object.freeze({repository:gamekitLock.repository,sourceCommit:gamekitLock.sourceCommit,distCommit:gamekitLock.distCommit});
  RALLY_NETCODE_URL='gamekit:'+gamekitSource.distCommit;
  // Import only immutable official ESM bytes from the pinned dist; keep source files unchanged.
  const modules=await Promise.all(Object.entries(RALLY_GAMEKIT_MODULES).map(async([name,file])=>{
    const entry=gamekitLock.modules[name];
    if(!entry||entry.file!==file||!/^[a-f0-9]{64}$/.test(entry.sha256||''))throw new Error('Gamekit lock entry mismatch: '+name);
    const url='https://cdn.jsdelivr.net/gh/'+gamekitSource.repository+'@'+gamekitSource.distCommit+'/'+file;
    const response=await fetch(url);
    if(!response.ok)throw new Error('Gamekit module load failed: '+name+' HTTP '+response.status);
    const bytes=await response.arrayBuffer();
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
    if(digest!==entry.sha256)throw new Error('Gamekit module SHA-256 mismatch: '+name);
    const objectURL=URL.createObjectURL(new Blob([bytes],{type:'text/javascript'}));
    try{return [name,await import(objectURL)];}
    finally{URL.revokeObjectURL(objectURL);}
  }));
  const namespaces=Object.fromEntries(modules);
  const loadedVectorAssets=SIM_WORKER?{assets:Object.freeze({}),loader:null}:await loadRallyVectorAssets(namespaces.vectorAssetsLoader);
  globalThis.RallyVectorAssets=loadedVectorAssets.assets;
  globalThis.RallyVectorAssetLoader=loadedVectorAssets.loader;
  RallyNetcode=Object.freeze({...namespaces.rollback,...namespaces.deterministic,...namespaces.simloop,...namespaces.transport});
  RallyGamekit=Object.freeze(Object.assign({},...modules.map(([,module])=>module)));
  globalThis.RallyGamekit=RallyGamekit;
  for(const name of ['PresentationRuntime','RenderObject','WebGLDevice','createDOMInput','CameraViewport','PresentationEventQueue','resolveAnchorInto','DiagnosticRing','ReplayTimeline','VectorContext','createVectorActor','createVectorAssetLoader','ObjectPool','createNavigation'])if(typeof RallyGamekit[name]!=='function')throw new Error('Gamekit module API missing: '+name);
  for(const name of ["createSession","hashBytes","createValueCodec","WebRTCTransport","createNostrSignaler","createLoop","runSyncTestAsync"]){
    if(typeof RallyNetcode[name]!=="function")throw new Error("공개 라이브러리에 필수 API "+name+"가 없습니다. 라이브러리 배포 상태를 확인해 주세요.");
  }
  if(typeof Object.getOwnPropertyDescriptor(RallyNetcode.SyncTestSession?.prototype||{},"metrics")?.get!=="function")throw new Error("공개 라이브러리에 Synctest metrics API가 없습니다. 라이브러리 배포 상태를 확인해 주세요.");
  if(typeof RallyNetcode.RollbackSession?.prototype.exportSyncTestFrames!=="function")throw new Error("공개 라이브러리에 확정 입력 Synctest export API가 없습니다. 라이브러리 배포 상태를 확인해 주세요.");
  globalThis.RallyNetcode=RallyNetcode;
  globalThis.RallyNetcodeSource=Object.freeze({url:RALLY_NETCODE_URL,version:RallyNetcode.VERSION,pinned:true,...gamekitSource});
}catch(error){
  globalThis.__RALLY_PRESENT_FATAL__({kind:"RALLY_NETCODE_LOAD_FAILED",message:"넷코드 라이브러리를 불러오지 못해 게임을 시작할 수 없습니다. "+String(error?.message||error),url:RALLY_NETCODE_URL});
  // Dependent modules never evaluate, as the old IIFE `return` stopped the app.
  await new Promise(()=>{});
}

export { RallyGamekit, RallyNetcode, SIM_WORKER };
