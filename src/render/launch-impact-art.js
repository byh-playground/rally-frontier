// Presentation of authoritative launch motion. Positions, height and control recovery belong to the simulation.
const clamp01=value=>Math.max(0,Math.min(1,value));
const smooth=value=>{const t=clamp01(value);return t*t*(3-2*t)};
const hash=(seed,index)=>{let h=(Number(seed)>>>0)^Math.imul(index+1,0x9e3779b1);h=Math.imul(h^(h>>>16),0x85ebca6b);h=Math.imul(h^(h>>>13),0xc2b2ae35);return(h^(h>>>16))>>>0};
const identity=()=>({height:0,rotation:0,scaleX:1,scaleY:1,active:false,expression:null});
const HUSK_COLORS=Object.freeze({rice:['#e8c078','#bd8744'],soybean:['#a7c466','#698b38'],redbean:['#c76a60','#8a393a']});

class LaunchImpactArt{
  static unitPose(unit,renderTick,tps=20){
    const motion=unit?.impactMotion;
    if(!motion||!['deploy','knockback'].includes(motion.kind))return identity();
    const tick=Number(renderTick),start=Number(motion.startTick),end=Number(motion.endTick),recover=Number(motion.recoverUntilTick);
    const heightFP=Number(motion.heightFP);
    if(![tick,start,end,recover,heightFP].every(Number.isFinite)||end<start||recover<end||tick<start||tick>=recover)return identity();
    const height=Math.max(0,heightFP)/100;
    const duration=Math.max(1,end-start),flight=clamp01((tick-start)/duration);
    const driftX=(Number(unit.x)||0)-(Number(motion.originX)||0),turn= Math.abs(driftX)>.1?driftX:Number(motion.vxFP)||Number(motion.vyFP)||1;
    const direction=turn<0?-1:1;
    const deployed=motion.kind==='deploy';
    // A fixed quarter/half turn reads as tumbling without spinning every body through several revolutions.
    const airborne=height>.01;
    const recovery=clamp01((tick-end)/Math.max(1,recover-end));
    const rate=Number.isFinite(Number(tps))?Math.max(1,Number(tps)):20;
    const ageMs=Math.max(0,tick-start)*1000/rate;
    const open=deployed?smooth(ageMs/95):1;
    const settle=1-smooth(recovery);
    return{
      height,
      rotation:direction*(airborne?Math.sin(flight*Math.PI)*(.95+(deployed?.35:0)):.26*settle),
      scaleX:airborne?1.06:1+.15*settle,
      scaleY:airborne?(.72+.28*open):1-.22*settle,
      active:true,
      expression:deployed?'neutral':'hurt',
    };
  }

  // Retain the arriving bundle briefly: impact compression, opening and disappearance into its visible contents.
  // Draw the original ammo asset at this pose before drawBurst, centred at the impact's ground point.
  static bundlePose(ageMs){
    const age=Math.max(0,Number(ageMs)||0),life=180;
    if(age>=life)return{visible:false,scaleX:1,scaleY:1,rotation:0};
    const hit=smooth(age/45),open=smooth((age-45)/(life-45));
    return{visible:true,scaleX:1+.24*hit+.38*open,scaleY:1-.48*hit-.35*open,rotation:-.05*Math.sin(age/life*Math.PI)};
  }

  static drawBurst(ctx,{x,y,ageMs,scale=1,seed=0,grainType='rice',power=1}){
    const age=Number(ageMs)||0;
    if(age<0||age>680)return;
    const time=age/1000,size=Math.max(.01,scale),strength=.8+.2*clamp01(Number(power)||0);
    const colors=HUSK_COLORS[grainType]||HUSK_COLORS.rice;
    ctx.save();ctx.translate(x,y);ctx.scale(size,size);ctx.lineJoin='round';ctx.lineCap='round';
    // Short strokes remain on the ground: a small contact mark, never an opaque explosion over the soldiers.
    if(age<150){
      const fade=1-age/150;
      ctx.globalAlpha=.6*fade;ctx.strokeStyle='#7c623b';ctx.lineWidth=2;
      for(let i=0;i<7;i++){
        const a=(hash(seed,i)%6283)/1000,r=8+((hash(seed,i+9)>>>8)%16);
        ctx.beginPath();ctx.moveTo(Math.cos(a)*r,Math.sin(a)*r*.45);ctx.lineTo(Math.cos(a)*(r+9),Math.sin(a)*(r+9)*.45);ctx.stroke();
      }
    }
    // Packaging straps break radially and fall. The same seed and time always produce the same fragments.
    const fragmentAge=Math.max(0,age-25),ft=fragmentAge/1000;
    if(age>=25)for(let i=0;i<12;i++){
      const h=hash(seed,i+23),a=(h%6283)/1000,speed=(45+((h>>>9)%85))*strength;
      const distance=speed*ft,px=Math.cos(a)*distance,ground=Math.sin(a)*distance*.5;
      const lift=Math.max(0,(90+((h>>>17)%65))*ft-300*ft*ft),py=ground-lift;
      const fade=1-smooth((fragmentAge-260)/360);
      if(!fade)continue;
      ctx.save();ctx.translate(px,py);ctx.rotate(a+ft*(i%2?5:-5));ctx.globalAlpha=fade;
      if(i<5){
        ctx.strokeStyle='#75512c';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(-9,0);ctx.quadraticCurveTo(0,-5,11,2);ctx.stroke();
        ctx.strokeStyle='#e6be74';ctx.lineWidth=1.4;ctx.stroke();
      }else{
        ctx.fillStyle=colors[0];ctx.strokeStyle=colors[1];ctx.lineWidth=1.5;
        ctx.beginPath();ctx.moveTo(-7,0);ctx.quadraticCurveTo(-1,-7,8,1);ctx.quadraticCurveTo(0,6,-7,0);ctx.fill();ctx.stroke();
      }
      ctx.restore();
    }
    // Sparse low-opacity dust leaves gaps so the physical shove and rolling bodies stay readable.
    for(let i=0;i<7;i++){
      const h=hash(seed,i+61),a=(h%6283)/1000,d=(12+((h>>>10)%27))*(1-Math.exp(-time*6));
      const radius=(3+time*9)*(1+((h>>>20)%5)/5),fade=1-smooth(age/580);
      ctx.globalAlpha=.19*fade;ctx.fillStyle=i%2?'#d5bd91':'#aa8e63';ctx.beginPath();ctx.ellipse(Math.cos(a)*d,Math.sin(a)*d*.42-time*9,radius,radius*.6,0,0,Math.PI*2);ctx.fill();
    }
    ctx.restore();
  }
}

export{LaunchImpactArt};
