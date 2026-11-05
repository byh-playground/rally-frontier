// Rice texture regions and motion use the approved part artwork.  Pose evaluation
// remains in GameKit; the game supplies only pivots, clips and display state.
const assetRoot = new URL('../../assets/sprites/rice/', import.meta.url);
const assetFiles = Object.freeze({body:'body-hat.png',parts:'parts.png',expressions:'expressions.png'});

// The source crops reproduce the reviewed mockup. One-pixel transparent gutters
// keep linear filtering from sampling a neighbouring part in the shared atlas.
const pieces = Object.freeze({
  body:{source:'body',crop:[338,140,640,900],atlas:[1,1,228,322],rect:[-114,-197,228,322],part:0},
  legL:{source:'parts',crop:[1208,658,110,116],atlas:[232,1,48,55],rect:[-67,91.5,48,55],part:1},
  legR:{source:'parts',crop:[1340,658,115,116],atlas:[282,1,48,55],rect:[19,91.5,48,55],part:2},
  armL:{source:'parts',crop:[1196,510,110,125],atlas:[332,1,48,58],rect:[-122,13,48,58],part:3},
  armR:{source:'parts',crop:[1362,510,115,125],atlas:[382,1,48,58],rect:[75,19,48,58],part:5},
  sickle:{source:'parts',crop:[1518,486,150,240],atlas:[232,62,65,94],rect:[91.5,-34,65,94],part:6},
  eyeL:{source:'parts',crop:[1268,369,52,57],atlas:[300,62,26,29],rect:[-49,-51.5,26,29],part:7,ellipse:true},
  eyeR:{source:'parts',crop:[1410,369,52,57],atlas:[328,62,26,29],rect:[23,-51.5,26,29],part:7,ellipse:true},
  angryEyes:{source:'expressions',crop:[1150,642,290,110],atlas:[357,62,106,38],rect:[-53,-56,106,38],part:7},
  cheekL:{source:'parts',crop:[1227,412,63,47],atlas:[300,103,32,23],rect:[-70,-29.5,32,23],part:7,ellipse:true},
  cheekR:{source:'parts',crop:[1440,412,63,47],atlas:[334,103,32,23],rect:[38,-29.5,32,23],part:7,ellipse:true},
  smile:{source:'parts',crop:[1333,412,65,34],atlas:[368,103,34,22],rect:[-17,-32,34,22],part:7},
  surprise:{source:'expressions',crop:[596,842,112,125],atlas:[404,103,25,25],rect:[-12.5,-33.5,25,25],part:7},
});

const parts = [
  {id:'body',parent:null,pivot:[0,0]},
  {id:'legL',parent:'body',pivot:[-43,119]}, {id:'legR',parent:'body',pivot:[43,119]},
  {id:'armL',parent:'body',pivot:[-98,42]}, {id:'hand',parent:'body',pivot:[91,35]},
  {id:'armR',parent:'hand',pivot:[99,48]}, {id:'sickle',parent:'hand',pivot:[124,13]},
  {id:'face',parent:'body',pivot:[0,0]},
];
const key=(timeMs,body,hand=0,legL=0,legR=0,armL=0,easing='inOutSine')=>({timeMs,easing,parts:{body,hand:{rotation:hand},legL:{rotation:legL},legR:{rotation:legR},armL:{rotation:armL}}});
const body=(x=0,y=0,rotation=0,scaleX=1,scaleY=1)=>({x:x*.6,y:y*.6,rotation,scaleX,scaleY});
export const RICE_RIG=Object.freeze({parts,clips:{
  idle:{durationMs:1200,loop:'repeat',keyframes:[key(0,body(0,2.94,0,1.012,.97),.02),key(600,body(1.18,-2.94,.012,.985,1.03),-.025),key(1200,body(0,2.94,0,1.012,.97),.02)]},
  walk:{durationMs:480,loop:'repeat',keyframes:[key(0,body(-4.9,5.88,-.05,1.06,.94),-.11),key(120,body(-1.96,-15.86,-.02,.95,1.07),0,.2,-.2,-.12),key(240,body(4.9,5.88,.05,1.06,.94),.11),key(360,body(1.96,-15.86,.02,.95,1.07),0,-.2,.2,.12),key(480,body(-4.9,5.88,-.05,1.06,.94),-.11)]},
  fire:{durationMs:1030,loop:'once',keyframes:[key(0,body()),key(280,body(-4,3,-.07),-.65),key(605,body(8,3,.09),.85),key(780,body(8,3,.09),.85),key(1030,body())]},
  hit:{durationMs:295,loop:'once',keyframes:[key(0,body(),0,0,0,0,'outQuad'),key(35,body(15.61,-17.72,.16,.88,1.14),-.18,0,0,0,'outQuad'),key(113,body(-8.81,9.8,-.09,1.1,.9),.018,0,0,0,'outQuad'),key(204,body(2.94,-1.96,.03,.98,1.02),.105,0,0,0,'outQuad'),key(295,body(),0,0,0,0,'outQuad')]},
}});

export async function loadRiceSpriteImages(){
  const manifestResponse=await fetch(new URL('manifest.json',assetRoot),{cache:'no-store'});
  if(!manifestResponse.ok)throw new Error('쌀 스프라이트 목록을 불러오지 못했습니다.');
  const manifest=await manifestResponse.json();
  if(manifest?.schemaVersion!==1||!manifest.assets||Object.keys(manifest.assets).sort().join(',')!==Object.keys(assetFiles).sort().join(','))throw new Error('쌀 스프라이트 목록이 올바르지 않습니다.');
  return Object.fromEntries(await Promise.all(Object.entries(assetFiles).map(async ([name,file])=>{
    const entry=manifest.assets[name];
    if(!entry||entry.file!==file||!Number.isSafeInteger(entry.bytes)||entry.bytes<1||entry.bytes>2*1024*1024||!/^[a-f0-9]{64}$/.test(entry.sha256||''))throw new Error(`쌀 스프라이트 정보가 잘못되었습니다: ${name}`);
    const response=await fetch(new URL(file,assetRoot),{cache:'no-cache'});if(!response.ok)throw new Error(`쌀 스프라이트를 불러오지 못했습니다: ${name}`);
    const bytes=await response.arrayBuffer();if(bytes.byteLength!==entry.bytes)throw new Error(`쌀 스프라이트 크기가 다릅니다: ${name}`);
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
    if(hash!==entry.sha256)throw new Error(`쌀 스프라이트 해시가 다릅니다: ${name}`);
    const url=URL.createObjectURL(new Blob([bytes],{type:'image/png'}));
    try{const image=new Image();image.src=url;await image.decode();return [name,image]}finally{URL.revokeObjectURL(url)}
  })));
}

export function buildRiceSpriteCanvas(images){
  const canvas=document.createElement('canvas');canvas.width=canvas.height=512;
  const ctx=canvas.getContext('2d');
  for(const piece of Object.values(pieces)){
    const [x,y,w,h]=piece.atlas;
    ctx.save();if(piece.ellipse){ctx.beginPath();ctx.ellipse(x+w/2,y+h/2,w*.49,h*.49,0,0,Math.PI*2);ctx.clip()}
    ctx.drawImage(images[piece.source],...piece.crop,x,y,w,h);ctx.restore();
  }
  return canvas;
}

// Title/card portraits use exactly the atlas pieces used by the battlefield.
export function riceSpritePortrait(atlasCanvas,width){
  const canvas=document.createElement('canvas'),scale=width/320;
  canvas.width=width;canvas.height=Math.round(360*scale);
  const ctx=canvas.getContext('2d');ctx.setTransform(scale,0,0,scale,width/2,200*scale);
  for(const name of ['legL','legR','armL','body','eyeL','eyeR','cheekL','cheekR','smile','sickle','armR']){
    const p=pieces[name];ctx.drawImage(atlasCanvas,...p.atlas,...p.rect);
  }
  return canvas.toDataURL('image/png');
}

export function prepareRiceSpriteAtlas(device, canvas){
  const region=device.textureAtlas.allocate(canvas.width,canvas.height,{filter:'linear'});
  try{device.textureAtlas.upload(region,canvas)}catch(error){device.textureAtlas.release(region);throw error}
  const atlas=region.atlas;
  const drawData=(names)=>{
    const uv=[],local=[],indices=[];
    for(const name of names){const p=pieces[name],[x,y,w,h]=p.atlas;uv.push((region.x+x)/atlas.width,(region.y+y)/atlas.height,w/atlas.width,h/atlas.height);local.push(...p.rect);indices.push(p.part)}
    return {uvRects:Float32Array.from(uv),localRects:Float32Array.from(local),parts:Float32Array.from(indices)};
  };
  return {region,back:drawData(['legL','legR','armL','body']),front:{
    neutral:drawData(['eyeL','eyeR','cheekL','cheekR','smile','sickle','armR']),
    attack:drawData(['angryEyes','cheekL','cheekR','smile','sickle','armR']),
    hurt:drawData(['eyeL','eyeR','cheekL','cheekR','surprise','sickle','armR']),
  }};
}

// GPU pose handles are prepared for all visible characters before any quads are
// submitted. One shared atlas and pose source serve every instance.
export class RiceSpriteRenderer{
  constructor(context,canvas,gamekit){
    this.context=context;this.mesh=context.acquireMeshRenderer();this.actors=new Set();
    this.atlas=prepareRiceSpriteAtlas(context.device,canvas);
    try{this.source=this.mesh.createPoseSource(gamekit.compilePoseChannels(RICE_RIG))}
    catch(error){context.device.textureAtlas.release(this.atlas.region);throw error}
    this.base=parts.map((_,i)=>({x:0,y:0,rotation:i===3?-.2:i===5?.2:i===6?-.3:0,scaleX:1,scaleY:1,opacity:1}));
    this.visible=parts.map(()=>true);this.morph=[0,0];
    this.disposed=false;context.onDispose(()=>this.dispose());
  }
  createActor(){
    const owner=this,instance=this.mesh.createPoseInstance(this.source);
    const actor={currentClip:'idle',startedAt:0,elapsed:0,pose:null,disposed:false,
      play(clip){this.currentClip=clip;this.startedAt=clip==='idle'||clip==='walk'?0:null;return this},
      // attackFlash is published at contact, so start at the authored contact
      // key instead of inventing a windup after damage has already happened.
      seek(time){if(this.startedAt===null)this.startedAt=time-(this.currentClip==='fire'?605:0);this.elapsed=Math.max(0,time-this.startedAt);return this},
      preparePose(){this.pose=owner.mesh.preparePose(instance,{clipName:this.currentClip,elapsedMs:this.elapsed,basePoses:owner.base,visible:owner.visible,morph:owner.morph});if(!this.pose)throw new Error('쌀 스프라이트에 GPU 포즈를 사용할 수 없습니다.');return this.pose},
      dispose(){if(this.disposed)return false;this.disposed=true;owner.actors.delete(this);return owner.mesh.deletePoseInstance(instance)},
    };
    this.actors.add(actor);return actor;
  }
  draw(data,actor,matrix,depth,{depthWriteAlphaThreshold=0}={}){
    const C=this.context;C.depth=depth;
    C.drawQuads({layer:this.atlas.region.layer,filter:this.atlas.region.filter,...data,pose:actor.pose,matrix,depthWriteAlphaThreshold});
  }
  drawBody(actor,matrix,depth){this.draw(this.atlas.back,actor,matrix,depth,{depthWriteAlphaThreshold:.05})}
  drawFace(actor,matrix,depth,face){this.draw(this.atlas.front[face]||this.atlas.front.neutral,actor,matrix,depth)}
  dispose(){if(this.disposed)return false;this.disposed=true;for(const actor of [...this.actors])actor.dispose();this.mesh.deletePoseSource(this.source);this.context.device.textureAtlas.release(this.atlas.region);return true}
}
