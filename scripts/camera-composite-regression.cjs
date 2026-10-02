const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// Actual WebGL pixels: stable terrain/Fog first, final screen translation second.
async function run() {
  let html = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
  const end = html.lastIndexOf('})();');
  html = html.slice(0, end) + 'window.__compositeQA={GLRenderer,WorldContext,TerrainPresentation};' + html.slice(end);
  const nativeGpu=process.env.QA_NATIVE_GPU==='1';
  const browser = await chromium.launch({ channel: process.env.QA_BROWSER_CHANNEL || 'msedge', headless: true,
    ...(nativeGpu?{}:{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}) });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('http://composite-qa.local/**', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('http://composite-qa.local/');
    const result = await page.evaluate(nativeGpu => {
      const { GLRenderer, WorldContext, TerrainPresentation } = window.__compositeQA;
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:320px;height:480px';
      document.body.append(canvas);
      const r = new GLRenderer(canvas), gl = r.gl;
      const check = (ok, message) => { if (!ok) throw new Error(message); };
      const hash = data => { let h = 2166136261; for (const x of data) h = Math.imul(h ^ x, 16777619); return h >>> 0; };
      const read = () => { const a = new Uint8Array(canvas.width * canvas.height * 4); gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, a); return a; };
      const world = WorldContext.fromMap({ width: 2560, height: 3840, terrain: {
        layers: [{ id: 'high', level: 2, points: [{x:1024,y:1281},{x:2048,y:1281},{x:2048,y:2305},{x:1024,y:2305}] }],
        ramps: [{ id: 'ramp', layerId: 'high', edge: 0, t0: .125, t1: .375, run: 128 }]
      }});
      r.world = world; r.snapshot = { tick: 12, world, units: [], buildings: [] }; r._framePresentationAt = 1000;
      const out = { nativeGpu, antialias: gl.getContextAttributes().antialias, samples: gl.getParameter(gl.SAMPLES), cases: [] };
      check(out.antialias && out.samples > 0, 'Default framebuffer MSAA remains enabled');
      let allocations = 0;
      const upload = gl.texImage2D.bind(gl);
      gl.texImage2D = (...args) => { allocations++; return upload(...args); };
      let streams=[];
      const bufferUpload=gl.bufferSubData.bind(gl);
      gl.bufferSubData=(target,offset,data)=>{
        streams.push(hash(new Uint8Array(data.buffer,data.byteOffset,data.byteLength)));
        return bufferUpload(target,offset,data);
      };
      function draw() {
        streams=[];
        gl.viewport(0,0,canvas.width,canvas.height); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
        gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA); gl.clearColor(.13,.19,.23,1); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
        gl.useProgram(r.p); gl.uniform2f(r.r,canvas.width,canvas.height); r.begin(); TerrainPresentation.drawSurfaces(r); r.flush(); r.drawFog();
      }
      for (const [w,h] of [[320,480],[413,619]]) for (const role of ['host','guest']) for (const level of [0,2]) {
        canvas.width=w; canvas.height=h; r.role=role;
        const side=role==='guest'?1:0,source={x:1280,y:level?1450:1216,level,r:450,detect:0,air:false,ignoresTerrainVision:false};
        r.visionSourcesBySide=[[],[]];r.visionSourcesBySide[side]=[source];r.visionGridBySide=[new Map(),new Map()];
        for(let y=0;y<=12;y++)for(let x=0;x<=8;x++)r.visionGridBySide[side].set(`${x},${y}`,[source]);
        const target={x:1280,y:world.terrain.surfaces.heightAt(1280,1340),z:1340,groundY:0};
        r.cameraLeft=r.viewX(target.x)-450;r.cameraTop=r.viewY(target.z)-target.y*.6-700;
        r._fogMaskContext=null; r.frameShakeX=0;r.frameShakeY=0;draw();
        const stable=read(),stableStreams=JSON.stringify(streams),projection=r.projectRenderWorldPosition(target), visibility=hash(r.fogMaskRecords.get('level:2').target);
        if(r.renderCameraShakePass){r.renderCameraShakePass();check(gl.getError()===gl.NO_ERROR,'Identity warmup remains valid')}
        const allocationsBefore=allocations;let maxError=0;
        for(const [sx,sy] of [[17,11],[-13,-9],[.375,-.625],[0,0]]) {
          r.frameShakeX=sx;r.frameShakeY=sy;draw();
          const scene=read();
          check(JSON.stringify(streams)===stableStreams,'Every scene vertex/UV/color upload is independent of shake');
          // Repeated native draws can differ at a few raster samples even with
          // identical uploads. Compare the actual source and its composed result;
          // the deterministic backend additionally requires exact raw pixels.
          if(!nativeGpu)check(hash(scene)===hash(stable),'Pre-composition pixels must be independent of shake');
          check(JSON.stringify(r.projectRenderWorldPosition(target))===JSON.stringify(projection),'World projection is stable');
          check(hash(r.fogMaskRecords.get('level:2').target)===visibility,'Fog visibility stable');
          const shown=r.displayCoordinatesAtScene(projection.x,projection.y),rect=canvas.getBoundingClientRect();
          const pick=r.pxToWorld(rect.left+shown.x/w*rect.width,rect.top+shown.y/h*rect.height);
          check(Math.hypot(pick[0]-r.viewX(target.x),pick[1]-r.viewY(target.z))<.001,'Picking inverses composition exactly once '+JSON.stringify({role,level,shown,pick,target,w,h}));
          if(sx||sy)for(const [x,y] of [[2,2],[w-2,h-2]]){
            const sample=r.sceneCoordinatesAtDisplay(x,y,{sampled:true});
            check(sample.x===Math.max(.5,Math.min(w-.5,x-sx))&&sample.y===Math.max(.5,Math.min(h-.5,y-sy)),'Display edge uses actual clamped source texel');
            const edge=r.surfaceAtScreen(sample.x,sample.y),clicked=r.pxToWorld(rect.left+x/w*rect.width,rect.top+y/h*rect.height);
            check(Math.hypot(clicked[0]-r.viewX(edge.x),clicked[1]-r.viewY(edge.z))<.001,'Edge picking matches visible repeated border');
          }
          r.renderCameraShakePass(); check(gl.getError()===gl.NO_ERROR,"Composition GL error"); const composed=read();
          for(let y=0;y<h;y++)for(let x=0;x<w;x++)for(let channel=0;channel<4;channel++) {
            const fx=x-sx,fy=y+sy,ix=Math.floor(fx),iy=Math.floor(fy),tx=fx-ix,ty=fy-iy;
            const sample=(a,b)=>scene[(Math.max(0,Math.min(h-1,b))*w+Math.max(0,Math.min(w-1,a)))*4+channel];
            const expected=(sample(ix,iy)*(1-tx)+sample(ix+1,iy)*tx)*(1-ty)+(sample(ix,iy+1)*(1-tx)+sample(ix+1,iy+1)*tx)*ty;
            const error=Math.abs(composed[(y*w+x)*4+channel]-expected); if(error>maxError){maxError=error;window.maxPixel={x,y,channel,sx,sy,actual:composed[(y*w+x)*4+channel],expected,source:sample(ix,iy)}}
          }
          check(maxError<=2,'Composition matches clamped bilinear reference including viewport edges: '+maxError+' '+JSON.stringify(window.maxPixel));
          check(gl.getError()===gl.NO_ERROR,'GL state and sampling valid');
        }
        // Same texture allocation reused across every shake frame of a size.
        check(allocations-allocationsBefore<=1,'Composition allocation only on initial use or resize');
        out.cases.push({w,h,role,level,stableHash:hash(stable),maxError});
      }
      r.frameShakeX=0;r.frameShakeY=0;r.renderCameraShakePass();
      check(new DOMMatrix(getComputedStyle(r.fxCanvas).transform).m41===0&&new DOMMatrix(getComputedStyle(r.fxCanvas).transform).m42===0,'Overlay resets on zero shake');
      out.allocations=allocations;out.glError=gl.getError();return out;
    },nativeGpu);
    assert.deepEqual(errors, []);assert.equal(result.glError,0);
    console.log(JSON.stringify({...result,assertions:'PASS'},null,2));
  } finally { await browser.close(); }
}
run().catch(e=>{console.error(e.stack);process.exitCode=1;});
