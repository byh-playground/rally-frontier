const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// Optional HTML argument lets the same Canvas checks reproduce the pre-fix defect.
const htmlPath = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..', 'index.html');
const artifactDir = process.env.QA_ARTIFACT_DIR || path.resolve(__dirname, '..', '.qa', 'minimap-bridge');
async function run() {
  let html = fs.readFileSync(htmlPath, 'utf8');
  const end = html.lastIndexOf('})();');
  assert.ok(end >= 0);
  html = html.slice(0, end) + `window.__miniQA={MiniMap,GLRenderer,WorldContext,TerrainPresentation,DraftPresentation,UiRegistry,ActiveViewState,UiController};` + html.slice(end);
  const browser = await chromium.launch({ channel: process.env.QA_BROWSER_CHANNEL || 'msedge', headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://mini-qa.local/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
    await page.goto('http://mini-qa.local/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__miniQA);
    const result = await page.evaluate(() => {
      const { MiniMap, GLRenderer, WorldContext, TerrainPresentation, DraftPresentation, UiRegistry, ActiveViewState, UiController } = window.__miniQA;
      const rect = (x0,y0,x1,y1) => [{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}];
      const descriptor = { width: 3200, height: 4096, laneControlPoints: {top:[],mid:[],bot:[]},
        terrain: { layers: [{id:'river-bank',level:-1,points:rect(800,900,2400,3000),innerPoints:rect(960,1060,2240,2840)}],
          ramps:[],blockers:[],roads:[{width:10,points:[]}],riverPolygon:rect(960,1060,2240,2840),
          bridges:[{id:'crossing',x:1600,y:1800,angle:.18,halfLength:880,halfWidth:80,level:0}] } };
      const world = WorldContext.fromMap(descriptor);
      const canvas = document.createElement('canvas'); canvas.width=390;canvas.height=650;
      const renderer = new GLRenderer(canvas); renderer.world=world; renderer.replayObserverAll=true;
      renderer.snapshot={world,mapDescriptor:descriptor,units:[],buildings:[],resources:[],gasNodes:[],camps:[],capturePoints:[]};
      const mini = new MiniMap(UiRegistry.refs.minimapCanvas); mini.set(renderer,renderer.snapshot);
      const events=[];
      const originals = {};
      for (const name of ['drawSurfaceMini','drawMiniBridges']) {
        originals[name]=TerrainPresentation[name];
        if (originals[name]) TerrainPresentation[name]=function(...args){events.push(name);return originals[name].apply(this,args)};
      }
      const images=[];
      function inspect(target,consumer,role,expected,point) {
        const pixel=[...target.getContext('2d').getImageData(Math.floor(point[0]),Math.floor(point[1]),1,1).data];
        const bridge=events.lastIndexOf('drawMiniBridges'),surface=events.lastIndexOf('drawSurfaceMini');
        images.push({consumer,role,width:target.width,height:target.height,pixel,expected,bridgeAfterSurface:bridge>surface,
          image:target.toDataURL('image/png')});
      }
      for (const role of ['host','guest']) {
        renderer.role=role; ActiveViewState.role=role;
        UiController.setUiScreen('game');
        events.length=0; mini.draw();
        inspect(mini.canvas,'minimap',role,[154,122,71,255],mini.point(1600,1800));
        UiController.setUiScreen('finale');
        // Show the existing finale overlay to exercise its real layout and fit box.
        DraftPresentation.setDraftCountdownValue(3,'QA');
        events.length=0; DraftPresentation.drawDraftMapPreview(descriptor);
        const preview=UiRegistry.refs.draftMapPreviewCanvas;
        inspect(preview,'draft',role,[161,128,76,255],[(role==='guest'?1600:1600)/3200*preview.width,(role==='guest'?4096-1800:1800)/4096*preview.height]);
      }
      for (const name of Object.keys(originals)) if(originals[name]) TerrainPresentation[name]=originals[name];
      return images;
    });
    fs.mkdirSync(artifactDir,{recursive:true});
    for (const image of result) {
      const filename=path.join(artifactDir,`${image.consumer}-${image.role}.png`);
      fs.writeFileSync(filename,Buffer.from(image.image.split(',')[1],'base64'));
      delete image.image; image.artifact=filename;
    }
    console.log(JSON.stringify({cases:result,pageErrors:errors},null,2));
    assert.deepEqual(errors,[]);
    for (const item of result) {
      assert.ok(item.width>30 && item.height>30,`${item.consumer} uses actual visible dimensions`);
      assert.deepEqual(item.pixel,item.expected,`${item.consumer}/${item.role} bridge center preserves deck color`);
      assert.equal(item.bridgeAfterSurface,true,`${item.consumer}/${item.role} draws bridge after terrain`);
    }
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode=1; });
