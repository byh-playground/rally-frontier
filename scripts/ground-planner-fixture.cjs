/* Shared fixture, injected into the production app IIFE to resolve private game classes. */
function installFixture(cfg){
  MatchLifecycle.singleRoomToken=()=> 'GROUNDBENCH20261003';
  BotController.prototype.handleSnapshot=function(){};
  for(const d of Object.values(UnitDefinition.all))if(d.layer!=='AIR'&&!d.economyWorker)d.navigationPlanner=cfg.mode;
  if(!Object.prototype.hasOwnProperty.call(UnitDefinition.all,cfg.unit)||UnitDefinition.get(cfg.unit).layer==='AIR'||UnitDefinition.get(cfg.unit).economyWorker)throw Error('Fixture requires ordinary ground combat unit');
  const rect=(id,x,y,w,h)=>({id,points:[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}]});
  MapGeneration.generateMapDescriptor=function({rules}={}){
    const map=StateValue.copy(MapGeneration.fixedStandardMapDescriptor(rules,20261003,1));
    map.width=4200;map.height=4800;map.seed=20261003;map.generator='ground-benchmark';
    map.resources=[];map.gasNodes=[];map.camps=[];map.capturePoints=[];map.authoredStructures=[];
    map.spawns={host:{x:300,y:4400},guest:{x:3900,y:400}};
    map.flags=[{x:3500,y:2400,forced:true},{x:650,y:2400,forced:true}];
    const layers=[{...rect('start-height',250,1800,750,1200),level:1},{...rect('goal-height',3300,1600,700,1600),level:2}];
    if(cfg.complexity!=='low')layers.push({...rect('north-pit',1350,850,650,550),level:-1},{...rect('south-height',2300,3200,650,800),level:1});
    if(cfg.complexity==='high')layers.push({...rect('south-pit',1200,3100,500,900),level:-1},{...rect('north-height',2300,700,600,650),level:1},{...rect('near-height',1300,1800,450,400),level:1},{...rect('near-pit',2350,1800,550,400),level:-1});
    const ramps=[],rampBounds=[];
    for(const layer of layers){const p=layer.points,x0=p[0].x,x1=p[1].x,y0=p[0].y,y1=p[2].y;
      const edges=layer.id==='start-height'?[1]:layer.id==='goal-height'?[3]:[1,3],run=layer.id==='start-height'?160:layer.id==='goal-height'?256:96;
      for(const edge of edges){const t0=layer.id==='start-height'?.15:.25,t1=1-t0;ramps.push({id:layer.id+'-ramp-'+edge,layerId:layer.id,edge,t0,t1,run});rampBounds.push({x0:edge===1?x1:x0-run,x1:edge===1?x1+run:x0,y0:y0+(y1-y0)*t0,y1:y0+(y1-y0)*t1});}
    }
    const extra=[];
    for(const x of [1200,1420,1640,2300,2520,2740,2960])for(let row=0;row<9;row++){
      const y=1400+row*230;if(rampBounds.some(r=>x<r.x1+30&&x+125>r.x0-30&&y<r.y1+30&&y+140>r.y0-30))continue;
      extra.push(rect('grid-'+x+'-'+row,x,y,125,140));
    }
    const selected=cfg.complexity==='low'?[]:cfg.complexity==='medium'?extra.filter((_,i)=>i%4===0):extra;
    const blockers=[rect('central-wall',1900,1600,200,1600),...selected].filter(b=>cfg.scenario!=='battle'||!(b.points[0].x<1560&&b.points[1].x>470&&b.points[0].y<2780&&b.points[2].y>2220));
    map.terrain={blockers,layers,ramps,bridges:[]};
    return map;
  };
  const initialPoints=new WeakMap();
  StrategySim.prototype.applyDebugScenario=function(raw){
    const normalized=DebugScenarioHarness.normalize(raw);
    this.units=[];this.unitById.clear();this.unitIndexById.clear();this.runtimeIndexTick=-1;this.rebuildRuntimeIndexes();
    this.decks=[[cfg.unit],[cfg.unit]];this.defenseCards=[[],[]];this.abilities=[{},{}];this.specialResearch=[{},{}];this.tech=[1,1];
    this.productionPaused=[true,true];this.events=[];
    const points=[],cols=Math.ceil(Math.sqrt(cfg.scenario==='movement'?cfg.count:cfg.count/2)),rows=Math.ceil((cfg.scenario==='movement'?cfg.count:cfg.count/2)/cols);
    let clearCursor=0;
    const spawn=(side,i,n)=>{
      const col=i%cols,row=Math.floor(i/cols),radius=this.unitRadius(cfg.unit),spacing=cfg.formation==='clear'?2*radius+8:30;
      let x=cfg.scenario==='movement'?1100-col*spacing:(side===0?1050-col*spacing:1090+col*spacing);
      let y=(cfg.scenario==='movement'?2400:2500)+(row-(rows-1)/2)*spacing;
      if(cfg.formation==='clear'){const front=1000+radius+4+2*spacing,clearCols=Math.floor((front-radius-2)/spacing)+1,clearRows=Math.ceil(cfg.count/clearCols)+2;do{if(clearCursor>=clearCols*clearRows)throw Error('Clear formation exceeds fixture bounds');x=front-(clearCursor%clearCols)*spacing;y=2400+(Math.floor(clearCursor/clearCols)-(clearRows-1)/2)*spacing;clearCursor++;}while(!this.navigation.pointClear(x,y,radius+1));}
      const u=this.spawnUnit(side,cfg.unit,x,y);
      if(!u||Math.hypot(u.x-x,u.y-y)>1e-4)throw Error('Fixture spawn was projected: '+JSON.stringify({x,y,actual:u&&{x:u.x,y:u.y}}));
      points.push({id:u.id,type:u.type,side,x:u.x,y:u.y,hp:u.hp,height:this.world.terrain.surfaces.heightAt(u.x,u.y)});
    };
    if(cfg.scenario==='movement')for(let i=0;i<cfg.count;i++)spawn(0,i,cfg.count);
    else for(const side of [0,1])for(let i=0;i<cfg.count/2;i++)spawn(side,i,cfg.count/2);
    this.flags=cfg.scenario==='movement'?[{x:3500,y:2400,forced:true},{x:650,y:2400,forced:true}]:[{x:1070,y:2500,forced:false},{x:1070,y:2500,forced:false}];
    this.rebuildRuntimeIndexes();initialPoints.set(this,points);return normalized;
  };
  const renderSnapshot=GLRenderer.prototype.setSnapshot;
  GLRenderer.prototype.setSnapshot=function(...args){const result=renderSnapshot.apply(this,args);const point=cfg.scenario==='movement'?{x:650,y:2400}:{x:1070,y:2500};
    this.cameraLeft=RangeUtil.clamp(this.viewX(point.x)-this.viewWorldW()/2,0,Math.max(0,this.world.width-this.viewWorldW()));
    this.cameraTop=this.clampCameraTop(BattlefieldProjection.planarY(this.viewY(point.y),this.world.terrain.surfaces.heightAt(point.x,point.y))-this.viewWorldH()/2);
    if(ViewRuntimeState.byRole?.host){ViewRuntimeState.byRole.host.cameraLeft=this.cameraLeft;ViewRuntimeState.byRole.host.cameraTop=this.cameraTop;}return result;
  };
  return {initialPoints};
}
module.exports={installFixture};
