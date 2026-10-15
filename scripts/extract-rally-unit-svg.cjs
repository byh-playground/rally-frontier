const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const htmlPath = path.join(root, '_site', 'index.html');
const outputRoot = path.join(root, 'assets', 'units');
const source = fs.readFileSync(htmlPath, 'utf8');
const close = source.lastIndexOf('})();');
assert.ok(close > 0, 'Built Rally IIFE exists');
const capture = `
window.__RALLY_CAPTURE_UNIT_SVGS__=function(){
  const renderer=ActiveViewState.renderer,session=MatchLifecycle.activeSession();
  if(!renderer||!session?.sim)throw new Error('A live Rally renderer and simulation are required');
  const palette=UnitFactionPalette.get('friendly');
  const markerRows=[['body',palette.body,'#fefefe'],['dark',palette.dark,'#555555'],['light',palette.light,'#bfbfbf'],['ring',palette.ring,'#999999']];
  const rgbHex=color=>color.slice(0,3).map(value=>Math.round(Math.max(0,Math.min(1,value))*255).toString(16).padStart(2,'0')).join('');
  const markerByHex=new Map(markerRows.map(([,color,marker])=>[rgbHex(color),marker]));
  const format=value=>{const rounded=Math.round(value*1000)/1000;return Object.is(rounded,-0)?'0':String(rounded)};
  const pathForTriangles=triangles=>{
    const runs=[];let run=null;
    for(const triangle of triangles){
      const color=triangle[0].color,hex=rgbHex(color),marker=markerByHex.get(hex)||('#'+hex),opacity=Math.round(color[3]*1000)/1000;
      const key=marker+'|'+opacity;
      if(!run||run.key!==key){run={key,fill:marker,opacity,paths:[]};runs.push(run)}
      const [a,b,c]=triangle;
      run.paths.push('M'+format(a.x)+' '+format(a.y)+'L'+format(b.x)+' '+format(b.y)+'L'+format(c.x)+' '+format(c.y)+'Z');
    }
    return runs.map((item,index)=>'<path id="shape-'+index+'" fill="'+item.fill+'"'+(item.opacity<.999?' fill-opacity="'+item.opacity+'"':'')+' d="'+item.paths.join('')+'"/>').join('');
  };
  const xmlEscape=value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const unitTemplate=session.sim.units.find(unit=>unit.alive)||{id:'capture',side:0,x:session.sim.world.width*.5,y:session.sim.world.height*.5,health:1,maxHealth:1,movement:{}};
  const oldV=renderer.v,oldFacing=renderer._unitFacingTransform,oldDepth=renderer._renderDepth,oldAlpha=renderer._unitRenderAlphaMul;
  const assets=[],errors=[];
  try{
    for(const type of Object.keys(UnitDefinition.all).sort()){
      const definition=UnitDefinition.get(type),render=UnitVisualLookup.renderer(type);
      if(!definition||definition.layer==='AIR'||!render)continue;
      const triangles=[],pending=[];
      renderer.v=function(x,y,color){
        if(this._unitFacingTransform)[x,y]=this.unitFacingPoint(x,y);
        pending.push({x,y,color:[color[0],color[1],color[2],color[3]??1]});
        if(pending.length===3){triangles.push(pending.splice(0,3));}
      };
      renderer._unitFacingTransform=null;renderer._renderDepth=0;renderer._unitRenderAlphaMul=1;
      const u={...unitTemplate,id:'svg-'+type,type,alive:true,side:0,x:unitTemplate.x??0,y:unitTemplate.y??0,health:1,maxHealth:1,hitFlash:0,attackFlash:0,
        movement:{...(unitTemplate.movement||{})},behaviorState:{...(unitTemplate.behaviorState||{})}};
      const x=128,y=128,r=40,sc=1,own=true,neutral=false,team=palette.body,teamDark=palette.dark,teamLight=palette.light;
      const ctx={u,own,d:definition,sc,neutral,worldPos:{x:u.x,y:0,z:u.y,groundY:0,motion:'ground'},bodyPos:{x,y},groundWorld:{x:u.x,y:0,z:u.y,groundY:0,motion:'ground'},
        groundProjection:{x,y},groundPos:[x,y],x,y,airborne:false,airUnit:false,r,workerBuildAnim:null,ownStealthAlpha:1,cloaked:false,team,teamDark,teamLight,
        factionPalette:palette,ink:[.09,.12,.16,1],metal:[.23,.28,.34,1],gold:[.96,.72,.24,1],accent:UnitVisualDefinition.get(type)?.accent||teamLight,hit:false,attack:false,dir:-1};
      try{
        if(!definition.objectiveKind&&UnitVisualDefinition.get(type)?.commonGroundBody!==false)renderer.drawUnitCommonBody(ctx);
        render(renderer,ctx);
        if(pending.length)throw new Error('Renderer left a partial triangle');
        if(!triangles.length)throw new Error('Renderer emitted no body triangles');
      }catch(error){errors.push({type,message:String(error?.stack||error)});continue}
      const body=pathForTriangles(triangles);
      const metadata={schemaVersion:1,id:'unit-'+type,defaultExpression:'default',parts:[
        {id:'body',parent:null,pivot:[128,128]},{id:'hit',parent:null,pivot:[128,128]},{id:'attack',parent:null,pivot:[128,128]}],
        expressions:{default:{show:['body'],hide:['hit','attack']},hit:{show:['body','hit'],hide:['attack']},attack:{show:['body','attack'],hide:['hit']},'hit-attack':{show:['body','hit','attack'],hide:[]}},sockets:{},clips:{idle:{durationMs:1000,loop:'repeat',easing:'linear',keyframes:[
          {timeMs:0,easing:'linear',parts:{body:{x:0}}},{timeMs:1000,easing:'linear',parts:{body:{x:0}}}]}}};
      const svg='<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><metadata id="vector-asset">'+xmlEscape(JSON.stringify(metadata))+'</metadata>'+
        '<g id="body">'+body+'</g><g id="hit"><circle id="hit-glow" cx="128" cy="128" r="56.8" fill="#fff0bf" fill-opacity="0.18"/></g>'+
        '<g id="attack"><circle id="attack-glow" cx="128" cy="128" r="48.8" fill="#ffba38" fill-opacity="0.07"/></g></svg>';
      assets.push({type,triangles:triangles.length,svg});
    }
  }finally{renderer.v=oldV;renderer._unitFacingTransform=oldFacing;renderer._renderDepth=oldDepth;renderer._unitRenderAlphaMul=oldAlpha;}
  return {assets,errors,role:session.role,tps:session.sim.tps};
};
window.__RALLY_CAPTURE_UNIT_SVGS__.stopBot=()=>MatchLifecycle.singleMatch?.bot?.stop();
window.__RALLY_CAPTURE_UNIT_SVGS__.isReady=()=>{const active=MatchLifecycle.activeSession();return !!active&&active.sim?.tick>=8&&active.sim.tps===10};
`;
const html = source.slice(0, close) + capture + source.slice(close);
// The production bundler validates the app scripts before capture.
(async()=>{
  fs.mkdirSync(outputRoot,{recursive:true});
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:1});
    page.on('pageerror',error=>console.error('pageerror:',error.message));
    page.on('console',message=>{if(message.type()==='error')console.error('console:',message.text())});
    await page.route('http://rally.local/**',route=>route.request().isNavigationRequest()?route.fulfill({status:200,contentType:'text/html',body:html}):route.abort());
    await page.goto('http://rally.local/',{waitUntil:'domcontentloaded'});
    await page.locator('#gameStartBtn').click();
    await page.locator('#advancedTestSettings summary').click();
    await page.locator('#unitTestAllyType').selectOption('swordsman');
    await page.locator('#unitTestAllyCount').fill('24');
    await page.locator('#unitTestEnemyType').selectOption('medic');
    await page.locator('#unitTestEnemyCount').fill('1');
    await page.locator('#unitTestResearch').uncheck();
    await page.locator('#unitTestBtn').click();
    await page.locator('#singleHostBtn').click();
    await page.locator('#gameScreen').waitFor({state:'visible',timeout:45000});
    await page.evaluate(()=>window.__RALLY_CAPTURE_UNIT_SVGS__.stopBot());
    await page.waitForFunction(()=>window.__RALLY_CAPTURE_UNIT_SVGS__.isReady(),null,{timeout:45000});
    const result=await page.evaluate(()=>window.__RALLY_CAPTURE_UNIT_SVGS__());
    if(result.errors.length)throw new Error('SVG source extraction failed: '+JSON.stringify(result.errors));
    for(const item of result.assets){
      const file=path.resolve(outputRoot,item.type+'.svg');
      if(path.dirname(file)!==outputRoot)throw new Error('Asset path escapes output directory');
      fs.writeFileSync(file,item.svg,'utf8');
    }
    console.log(JSON.stringify({role:result.role,tps:result.tps,assetCount:result.assets.length,assets:result.assets.map(({type,triangles,svg})=>({type,triangles,bytes:Buffer.byteLength(svg)}))},null,2));
    await page.close();
  }finally{await browser.close()}
})().catch(error=>{console.error(error.stack||error);process.exitCode=1});
