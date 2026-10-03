const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const root=path.resolve(process.argv[2]||path.join(__dirname,'..'));
const output=path.resolve(process.env.QA_GROUND_DEPTH_OUTPUT||path.join(root,'.qa/ground-depth'));
async function run(){
 fs.mkdirSync(output,{recursive:true});
 let html=fs.readFileSync(path.join(root,'index.html'),'utf8');const end=html.lastIndexOf('})();');assert(end>=0);
 html=html.slice(0,end)+'window.__groundDepthQA={BattlefieldProjection,TerrainSurfaceAtlas,TerrainSurfaceProjection,WorldContext,TerrainNavigation,TerrainPresentation,GLRenderer,Unit,UnitVisualLookup,ActiveViewState,MatchLifecycle,CampaignBuiltinCatalog};'+html.slice(end);
 const server=http.createServer((req,res)=>{const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname),file=path.resolve(root,'.'+pathname);if(file.startsWith(root+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile()&&pathname!=='/index.html'){res.setHeader('Content-Type',/\.(?:mjs|js)$/.test(file)?'text/javascript':/\.json$/.test(file)?'application/json':'application/octet-stream');res.end(fs.readFileSync(file))}else{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html)}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+server.address().port+'/',browser=await chromium.launch({channel:process.env.QA_BROWSER_CHANNEL||'msedge',headless:true,args:process.env.QA_SOFTWARE_GPU==='1'?['--use-angle=swiftshader','--enable-unsafe-swiftshader']:[]}),result={pageErrors:[]};
 try{
 const page=await browser.newPage({viewport:{width:1400,height:1000}});page.on('pageerror',e=>result.pageErrors.push(e.message));await page.goto(url);await page.waitForFunction(()=>window.__groundDepthQA);
 result.fixtures=await page.evaluate(()=>{
 const {WorldContext,TerrainSurfaceProjection,TerrainPresentation,GLRenderer,Unit,TerrainNavigation,UnitVisualLookup}=window.__groundDepthQA;
 const rect=(id,level,x0,z0,x1,z1)=>({id,level,points:[{x:x0,y:z0},{x:x1,y:z0},{x:x1,y:z1},{x:x0,y:z1}]});
 const cases=[];
 for(const level of [1,-1])for(const edge of [0,1,2,3]){
 const world=WorldContext.fromMap({width:2400,height:2400,terrain:{layers:[rect('hill',level,600,600,1800,1800)],ramps:[{id:'ramp',layerId:'hill',edge,t0:.3,t1:.7,run:160}],blockers:[]}}),ramp=world.terrain.surfaces.ramps[0];
 for(const end of ['low','high'])for(const delta of [-.1,.1]){const a=end==='low'?ramp.lowA:ramp.highA,b=end==='low'?ramp.lowB:ramp.highB;cases.push({label:`level${level}-edge${edge}-${end}${delta}`,world,x:(a.x+b.x)/2+ramp.nx*delta,z:(a.y+b.y)/2+ramp.ny*delta,clear:true})}
 const a=ramp.lowA,b=ramp.highA,c=ramp.lowB,d=ramp.highB;cases.push({label:`level${level}-edge${edge}-middle`,world,x:(a.x+b.x+c.x+d.x)/4,z:(a.y+b.y+c.y+d.y)/4,clear:true});
 }
  const bankLayer=rect('bank',-1,600,600,1800,1800);bankLayer.innerPoints=rect('inside',-1,760,760,1640,1640).points;
 const bankWorld=WorldContext.fromMap({width:2400,height:2400,terrain:{layers:[bankLayer],ramps:[],blockers:[]}});
 for(const q of [599.9,600.1,759.9,760.1,1639.9,1640.1,1799.9,1800.1])for(const axis of ['x','z'])cases.push({label:'negative-bank-'+axis+'-'+q,world:bankWorld,x:axis==='x'?q:1200,z:axis==='z'?q:1200,clear:true});
 for(const [x,z] of [[680,680],[1720,680],[1720,1720],[680,1720]])cases.push({label:'negative-bank-corner-'+x+'-'+z,world:bankWorld,x,z,clear:true});
 const hill=cases[0].world;cases.push({label:'cliff-north',world:hill,x:800,z:590,occlusionRole:'host'});
 cases.push({label:'cliff-south',world:hill,x:800,z:1801,occlusionRole:'guest'},{label:'boss-side-cliff',world:hill,x:965,z:680,type:'ancientbear',forcedHeight:0});
 const bridge=WorldContext.fromMap({width:2400,height:2400,terrain:{layers:[rect('pit',-2,800,500,1600,1900)],ramps:[],bridges:[{id:'deck',level:0,x:1200,y:1200,angle:0,halfLength:450,halfWidth:50}],blockers:[]}});cases.push({label:'bridge-under',world:bridge,x:1200,z:1200,forcedHeight:-48});
 cases.push({label:'bridge-top-back',world:bridge,x:1200,z:1151,clear:true},{label:'bridge-top-front',world:bridge,x:1200,z:1249,clear:true});
 document.body.replaceChildren();document.body.style='display:flex;flex-wrap:wrap;background:#222;color:white';
 const canvas=document.createElement('canvas');canvas.width=270;canvas.height=360;const r=new GLRenderer(canvas),gl=r.gl,rows=[];
 const diff=(a,b)=>{let n=0;for(let i=0;i<a.length;i+=4)if(Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2])>30)n++;return n};
 const rendererInfo=gl.getExtension('WEBGL_debug_renderer_info');
 for(const fixture of cases)for(const role of ['host','guest']){
 const {world,x,z}=fixture,height=fixture.forcedHeight??world.terrain.surfaces.heightAt(x,z);r.world=world;r.role=role;r.replayZoom=6;r.cameraLeft=r.viewX(x)-r.viewWorldW()/2;r.cameraTop=r.viewY(z)-height*.6-r.viewWorldH()/2;
 const unit=new Unit({id:'qa',type:fixture.type||'swordsman',side:0,x,y:z,fx:x*100,fy:z*100,alive:true,hp:100,maxHp:100});r.snapshot={tick:0,world,units:[unit],buildings:[],flags:[],resources:[],gasNodes:[],projectiles:[]};performance.now=()=>10000;r._framePresentationAt=10000;r.presentationNow=()=>10000;r.resolveUnitFacingScreen=()=>Math.PI/2;r.unitFacingStates.set('qa',{angle:Math.PI/2,lastAt:performance.now()});
 const flush=r.flush,resolve=r.resolveRenderWorldPosition,occluded=r.renderTerrainOccludedBodies;let vertices=0,control=false,bodyPhase=false;if(fixture.forcedHeight!==undefined)r.resolveRenderWorldPosition=function(entity,kind){const p=resolve.call(this,entity,kind);return{...p,y:fixture.forcedHeight,groundY:fixture.forcedHeight}};
 r.flush=function(frame,worldDepth){if(!frame||frame===this.frame)vertices+=this.frame.length/7;const bypass=control&&bodyPhase&&(!frame||frame===this.frame),enabled=gl.isEnabled(gl.DEPTH_TEST);if(bypass)gl.disable(gl.DEPTH_TEST);try{return flush.call(this,frame,worldDepth)}finally{if(bypass&&enabled)gl.enable(gl.DEPTH_TEST)}};r.renderTerrainOccludedBodies=function(){if(!control)return occluded.call(this)};
 const render=(ignoreDepth,units=[unit],shadow=false)=>{vertices=0;control=ignoreDepth;bodyPhase=false;gl.viewport(0,0,270,360);gl.useProgram(r.p);gl.uniform2f(r.r,270,360);gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.depthMask(true);gl.clearColor(.7,.8,.6,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);r.begin();TerrainPresentation.drawSurfaces(r);r.flush();const before=vertices;bodyPhase=true;if(shadow){r.renderTerrainOcclusionDepth();gl.depthMask(false);r.begin();r.drawUnitShadow(unit,true);r.flush();gl.depthMask(true)}else r.renderWorldPass(units);bodyPhase=false;const pixels=new Uint8Array(270*360*4);gl.readPixels(0,0,270,360,gl.RGBA,gl.UNSIGNED_BYTE,pixels);return{pixels,vertices:vertices-before}};
 const empty=render(true,[]),full=render(true),actual=render(false),warm=render(false),shadowFull=render(true,[unit],true),shadowActual=render(false,[unit],true);const withoutShadow=render(false);r.renderShadowPass([unit]);const withShadow=new Uint8Array(withoutShadow.pixels.length);gl.readPixels(0,0,270,360,gl.RGBA,gl.UNSIGNED_BYTE,withShadow);const centerOffset=(180*270+135)*4,centerUnchanged=Array.from(withShadow.slice(centerOffset,centerOffset+3)).every((v,i)=>v===withoutShadow.pixels[centerOffset+i]);render(false);r.flush=flush;r.renderTerrainOccludedBodies=occluded;r.resolveRenderWorldPosition=resolve;let clippedPixels=0,bodyPixels=0;for(let i=0;i<full.pixels.length;i+=4){const d=(a,b)=>Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2]);if(d(full.pixels,empty.pixels)>30){bodyPixels++;if(d(full.pixels,actual.pixels)>30)clippedPixels++}}
 const row={label:fixture.label,role,height,expectClear:!!fixture.clear,shadowDoesNotDarkenBody:centerUnchanged,shadowClippedPixels:diff(shadowFull.pixels,shadowActual.pixels),bodyPixels,expectOcclusion:fixture.occlusionRole===role||fixture.label==='bridge-under',clippedPixels,repeatedDifference:diff(actual.pixels,warm.pixels),fullVertices:full.vertices,actualVertices:actual.vertices,errors:[...(r.entityRenderErrors||[])],glError:gl.getError()};rows.push(row);
 if(fixture.label.startsWith('level1-edge0')||!fixture.clear){const box=document.createElement('div');box.innerText=fixture.label+' '+role;const img=document.createElement('img');img.src=canvas.toDataURL();img.style='display:block';box.appendChild(img);document.body.appendChild(box)}
 }
 const cachePolicy=UnitVisualLookup.cachePolicy;let cache;
 try{UnitVisualLookup.cachePolicy=type=>type==='swordsman'?'STATIC':cachePolicy.call(UnitVisualLookup,type);r.unitBodyMeshCache.clear();r.world=hill;r.role='host';
 const probe=z=>{const height=hill.terrain.surfaces.heightAt(1200,z),u=new Unit({id:'cache-probe',type:'swordsman',side:0,x:1200,y:z,fx:120000,fy:z*100,alive:true,hp:100,maxHp:100}),anchor={x:1200,y:height,z,groundY:height};r.snapshot={tick:0,world:hill,units:[u],buildings:[],flags:[],resources:[],gasNodes:[],projectiles:[]};r.begin();r.withWorldSpriteDepth(anchor,()=>r.drawUnitSafely(u,{skipShadow:true,visibilityChecked:true,worldPosition:anchor}));return Array.from(r.frame.view())};
 const hits=r.unitBodyMeshCacheHits,misses=r.unitBodyMeshCacheMisses,cold=probe(600),warm=probe(600),middle=probe(680);cache={hits:r.unitBodyMeshCacheHits-hits,misses:r.unitBodyMeshCacheMisses-misses,coldVertices:cold.length/7,warmVertices:warm.length/7,middleVertices:middle.length/7,bodyDepthValues:[...new Set(cold.filter((_,i)=>i%7===2))],middleDepthValues:[...new Set(middle.filter((_,i)=>i%7===2))],identicalColdWarm:JSON.stringify(cold)===JSON.stringify(warm)};
 }finally{UnitVisualLookup.cachePolicy=cachePolicy}
 const nav=TerrainNavigation.forState({world:hill,units:[],buildings:[]});
 const y=hill.terrain.surfaces.heightAt(1200,600),anchor={x:1200,y,z:600,groundY:y};r.world=hill;r.role='host';r.begin();r.withWorldSpriteDepth(anchor,()=>r.withRenderDepth(.123,()=>r.tri(0,0,10,0,0,10,[1,0,0,1])));const nestedDepthPreserved=Array.from({length:r.frame.length/7},(_,i)=>r.frame.data[i*7+2]).every(d=>Math.abs(d-.123)<1e-7);
 const projectionInvariant=['host','guest'].map(role=>{r.role=role;const lo={x:1200,y:0,z:600,groundY:0},hi={...lo,y:48,groundY:48},a=r.projectRenderWorldPosition(lo),b=r.projectRenderWorldPosition(hi);return{role,lowDepth:r.renderDepthForWorld(lo),highDepth:r.renderDepthForWorld(hi),screenShift:b.y-a.y,expectedShift:-48*window.__groundDepthQA.BattlefieldProjection.heightScale*r.sc()}});
 const pipeline=(()=>{
 const clear=()=>{gl.viewport(0,0,270,360);gl.useProgram(r.p);gl.uniform2f(r.r,270,360);gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.depthMask(true);gl.colorMask(true,true,true,true);gl.clearColor(0,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);r.begin()};
 const tri=(depth,color)=>r.withRenderDepth(depth,()=>r.tri(40,40,230,40,135,320,color));
 const pixel=()=>{const p=new Uint8Array(4);gl.readPixels(135,180,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);return Array.from(p)};
 const ordered=reverse=>{clear();for(const [depth,color] of (reverse?[[-.2,[0,1,0,1]],[.2,[1,0,0,1]]]:[[.2,[1,0,0,1]],[-.2,[0,1,0,1]]]))tri(depth,color);r.flush(r.frame,true);return pixel()};
 const opaqueForward=ordered(false),solidCutoff=gl.getUniform(r.spriteProgram,r.alphaCutoff),opaqueReverse=ordered(true);
 clear();tri(-.6,[1,0,0,.4]);r.flush(r.frame,true);const ghostCutoff=gl.getUniform(r.spriteProgram,r.alphaCutoff),ghostVisible=pixel();r.begin();tri(.2,[0,1,0,1]);r.flush(r.frame,true);const opaqueBehindGhost=pixel();
 // Exercise the actual shader's discard guard independently of run classification:
 // upload a solid triangle, retain cutoff .5, then replay its buffer with alpha .4.
 clear();tri(-.2,[1,0,0,1]);r.flush(r.frame,true);const transparentData=new Float32Array(r.frame.view());for(let i=6;i<transparentData.length;i+=7)transparentData[i]=.4;
 gl.depthMask(true);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.useProgram(r.spriteProgram);gl.bindBuffer(gl.ARRAY_BUFFER,r.buf);gl.bufferSubData(gl.ARRAY_BUFFER,0,transparentData);gl.drawArrays(gl.TRIANGLES,0,transparentData.length/7);const discarded=pixel();
 gl.depthMask(false);gl.uniform1f(r.alphaCutoff,0);gl.drawArrays(gl.TRIANGLES,0,transparentData.length/7);const alphaAllowed=pixel();
 return{opaqueForward,opaqueReverse,solidCutoff,ghostCutoff,ghostVisible,opaqueBehindGhost,discarded,alphaAllowed,glError:gl.getError()};
 })();
 return{cases:rows,cache,pipeline,projectionInvariant,centerTraverse:nav.segmentClear(1200,580,1200,780,10),nestedDepthPreserved,depthBits:gl.getParameter(gl.DEPTH_BITS),renderer:rendererInfo?gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)};
 });
 await page.screenshot({path:path.join(output,'ground-depth-contact-sheet.png'),fullPage:true});fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));
 const gpu=result.fixtures.pipeline;assert.equal(gpu.glError,0);assert.deepEqual(gpu.opaqueForward,gpu.opaqueReverse,'Opaque overlapping depth is submission-independent');assert(gpu.opaqueForward[1]>240&&gpu.opaqueForward[0]<5,'Nearer opaque triangle wins');assert.equal(gpu.solidCutoff,.5);assert.equal(gpu.ghostCutoff,0);assert(gpu.ghostVisible[0]>50,'Transparent ghost blends visibly');assert(gpu.opaqueBehindGhost[1]>240&&gpu.opaqueBehindGhost[0]<5,'Ghost does not write an invisible occluder');assert.deepEqual(gpu.discarded,[0,0,0,255],'Actual shader alpha .4 discarded under solid cutoff .5');assert(gpu.alphaAllowed[0]>50,'Actual shader alpha .4 retained in alpha pass');
 assert(result.fixtures.centerTraverse);assert(result.fixtures.nestedDepthPreserved);assert(result.fixtures.cache.hits>0);assert(result.fixtures.cache.misses>0);assert(result.fixtures.cache.identicalColdWarm);assert.equal(result.fixtures.cache.coldVertices,result.fixtures.cache.middleVertices);assert.equal(result.fixtures.cache.bodyDepthValues.length,1);assert(Math.abs(result.fixtures.cache.bodyDepthValues[0]-(.88-600/2400*1.72-.0005))<1e-7,"body keeps minimal foot-depth bias");assert.equal(result.fixtures.cache.middleDepthValues.length,1);for(const p of result.fixtures.projectionInvariant){assert.equal(p.lowDepth,p.highDepth,p.role+" ground-axis depth");assert(Math.abs(p.screenShift-p.expectedShift)<1e-7,p.role+" existing screen height projection")}
 for(const f of result.fixtures.cases){assert.equal(f.glError,0,f.label);assert.deepEqual(f.errors,[],f.label);assert(f.repeatedDifference<=3,f.label+' repeated hardware edge pixels '+f.repeatedDifference);if(f.expectClear){assert(f.shadowDoesNotDarkenBody,f.label+' '+f.role+' own shadow must not darken opaque torso');assert(f.clippedPixels<=3,f.label+' '+f.role+' unintended clipping '+f.clippedPixels);assert(f.shadowClippedPixels<=3,f.label+' '+f.role+' unintended shadow clipping '+f.shadowClippedPixels)}}
 for(const f of result.fixtures.cases.filter(f=>f.expectOcclusion))assert(f.clippedPixels>0,f.label+' '+f.role+' must occlude body');
 await page.close();
    if(process.env.QA_GROUND_DEPTH_UI!=='0'){
      const ui=await browser.newPage({viewport:{width:1280,height:900}});ui.on('pageerror',e=>result.pageErrors.push(e.message));ui.on('dialog',d=>d.accept());
      await ui.goto(url);await ui.locator('#gameStartBtn').click();await ui.locator('#campaignBtn').click();await ui.locator('[data-mission-id="frontier-02-rear-fire"]').click();await ui.locator('#campaignStartBtn').click();
      await ui.waitForFunction(()=>window.__groundDepthQA.ActiveViewState.snap?.tick>20,null,{timeout:30000});
      await ui.evaluate(()=>{window.__hillMovement=[];window.__hillSeen=new Set();window.__hillLeg='enter';window.__hillObserver=setInterval(()=>{const q=window.__groundDepthQA,s=q.ActiveViewState.snap,a=q.ActiveViewState.renderer.world.terrain.surfaces;for(const u of s?.units||[]){if(u.side!==0||!u.alive||u.type==='worker')continue;const p=a.sample(u.x,u.y),kind=p.ramp&&p.elevation>.01&&p.elevation<47.99?'slope':p.elevation===48?'plateau':p.elevation===0?'ground':'other',key=[window.__hillLeg,u.id,p.id,kind].join(':');if(window.__hillSeen.has(key))continue;window.__hillSeen.add(key);window.__hillMovement.push({leg:window.__hillLeg,tick:s.tick,id:u.id,x:u.x,z:u.y,height:p.elevation,surface:p.id,kind})}},100)});
      const position=await ui.evaluate(async()=>(await window.__groundDepthQA.CampaignBuiltinCatalog.manifest()).campaigns[0].missions[1].mission.regions.archers.center);
      await rally(ui,position);await ui.waitForFunction(()=>window.__groundDepthQA.ActiveViewState.snap.decks[0].includes('archer'),null,{timeout:90000});
      await ui.waitForFunction(()=>window.__hillMovement.some(p=>p.leg==='enter'&&p.surface==='archer-ramp'&&p.kind==='slope')&&window.__hillMovement.some(p=>p.leg==='enter'&&p.surface==='archer-high'&&p.kind==='plateau'),null,{timeout:60000});
      await ui.screenshot({path:path.join(output,'campaign-2-ramp-rescue.png')});
      const beforeHp=await ui.evaluate(()=>Object.fromEntries(window.__groundDepthQA.ActiveViewState.snap.units.filter(u=>u.alive&&u.type!=='worker').map(u=>[u.id,u.hp])));
      const choke=await ui.evaluate(async()=>(await window.__groundDepthQA.CampaignBuiltinCatalog.manifest()).campaigns[0].missions[1].mission.regions.choke.center);
      await rally(ui,choke);
      try{await ui.waitForFunction(before=>{const units=window.__groundDepthQA.ActiveViewState.snap.units;return Object.entries(before).some(([id,hp])=>{const u=units.find(u=>u.id===id);return !u||u.alive===false||u.hp<hp})},beforeHp,{timeout:30000})}catch(error){await ui.screenshot({path:path.join(output,'combat-wait.png')});fs.writeFileSync(path.join(output,'combat-wait.json'),JSON.stringify(await ui.evaluate(()=>({tick:window.__groundDepthQA.ActiveViewState.snap.tick,flags:window.__groundDepthQA.ActiveViewState.snap.flags,units:window.__groundDepthQA.ActiveViewState.snap.units,movement:window.__hillMovement})),null,2));throw error}
      await ui.screenshot({path:path.join(output,'campaign-2-combat.png')});
      await ui.evaluate(()=>window.__hillLeg='exit');
      const exitRoute=await ui.evaluate(()=>{const r=window.__groundDepthQA.ActiveViewState.renderer,a=r.world.terrain.surfaces.ramps.find(q=>q.id==='archer-exit');return{high:[((a.highA.x+a.highB.x)/2+a.nx*60)/r.world.width,((a.highA.y+a.highB.y)/2+a.ny*60)/r.world.height],low:[((a.lowA.x+a.lowB.x)/2-a.nx*60)/r.world.width,((a.lowA.y+a.lowB.y)/2-a.ny*60)/r.world.height]}});
      await rally(ui,exitRoute.high);
      await ui.waitForFunction(()=>{const q=window.__groundDepthQA,s=q.ActiveViewState.snap,a=q.ActiveViewState.renderer.world.terrain.surfaces;return s.units.some(u=>u.alive&&u.side===0&&u.type!=='worker'&&a.sample(u.x,u.y).id==='archer-high')},null,{timeout:60000});
      await rally(ui,exitRoute.low);
      await ui.waitForFunction(()=>window.__hillMovement.some(p=>p.leg==='exit'&&p.surface==='archer-exit'&&p.kind==='slope'),null,{timeout:90000});
      await rally(ui,[.37,.44]);
      await ui.waitForFunction(()=>window.__hillMovement.some(p=>p.leg==='exit'&&p.surface==='archer-exit'&&p.kind==='slope')&&window.__hillMovement.some(p=>p.leg==='exit'&&p.z<1995&&p.kind==='ground'),null,{timeout:90000});
      await ui.screenshot({path:path.join(output,'campaign-2-ramp-exit.png')});
      result.ui=await ui.evaluate(()=>{const q=window.__groundDepthQA;clearInterval(window.__hillObserver);return{tick:q.ActiveViewState.snap.tick,backend:q.ActiveViewState.renderer.backend,archerRescued:true,combatDamageObserved:true,movement:window.__hillMovement,errors:[...(q.ActiveViewState.renderer.entityRenderErrors||[])]}});
      result.ui.traversingUnitIds=[...new Set(result.ui.movement.map(p=>p.id))].filter(id=>{const samples=result.ui.movement.filter(p=>p.id===id);return samples.some(p=>p.surface==='archer-ramp'&&p.kind==='slope')&&samples.some(p=>p.surface==='archer-high'&&p.kind==='plateau')&&samples.some(p=>p.surface==='archer-exit'&&p.kind==='slope')&&samples.some(p=>p.leg==='exit'&&p.z<1995&&p.kind==='ground')});
      fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));assert(result.ui.traversingUnitIds.length>0,'The same player unit crossed both ramps and the plateau');
      assert.deepEqual(result.ui.errors,[]);
      await ui.locator('#matchMenuBtnGame').click();await ui.locator('#matchMenuSurrenderBtn').click();await ui.locator('#result').waitFor({state:'visible'});await ui.screenshot({path:path.join(output,'campaign-2-result.png')});await ui.locator('#rematchBtn').click();await ui.locator('#gameStartBtn').waitFor({state:'visible'});result.ui.returnedToLobby=true;
    }
    assert.deepEqual(result.pageErrors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  }finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
}
async function rally(page,position){
  const mini=await page.evaluate(position=>{const r=window.__groundDepthQA.ActiveViewState.renderer,m=window.__groundDepthQA.ActiveViewState.minimap,b=m.contentRect();return{x:b.left+r.viewX(position[0]*r.world.width)/r.world.width*b.width,y:b.top+r.viewY(position[1]*r.world.height)/r.world.height*b.height}},position);
  await page.mouse.click(mini.x,mini.y);await page.waitForTimeout(250);
  const point=await page.evaluate(position=>{const r=window.__groundDepthQA.ActiveViewState.renderer,b=r.canvas.getBoundingClientRect(),x=position[0]*r.world.width,z=position[1]*r.world.height,p=r.projectRenderWorldPosition({x,y:r.world.terrain.surfaces.heightAt(x,z),z,groundY:0});return{x:b.left+p.x*b.width/r.canvas.width,y:b.top+p.y*b.height/r.canvas.height}},position);
  await page.mouse.click(point.x,point.y);
}
run().catch(error=>{console.error(error.stack);process.exitCode=1});
