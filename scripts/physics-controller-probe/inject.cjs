const fs=require('node:fs'),path=require('node:path');
const VERSIONS={matter:'0.20.0',rapier:'0.21.0'};
function inject(root,{variant='original',allLibraries=false}={}){
  let html=require('../bundle-gamekit.cjs').bundleGame(root,fs.readFileSync(path.join(root,'index.html'),'utf8'));
  if(variant!=='original'){
    const kinds=['matter-full-1','matter-full-6','rapier-full-1','rapier-full-6','matter-guarded','rapier-guarded','matter-guarded-lite','rapier-guarded-lite'],ordinal=kinds.indexOf(variant)+1;
    if(!ordinal)throw Error('Unknown QA physics variant');
    html=html.replace(/SIM_VERSION=(\d+);/,(_,version)=>'SIM_VERSION='+(Number(version)*100+ordinal)+';');
  }
  const end=html.lastIndexOf('})();');if(end<0)throw Error('Game IIFE not found');
  const vendor=path.join(root,'.qa/physics-vendors/node_modules');let code='\nglobalThis.PhysicsControllerProbe={};\n';
  if(allLibraries||variant.startsWith('matter')){
    const pkg=JSON.parse(fs.readFileSync(path.join(vendor,'matter-js/package.json'),'utf8'));if(pkg.version!==VERSIONS.matter)throw Error('Pinned Matter version required');
    const lib=fs.readFileSync(path.join(vendor,'matter-js/build/matter.min.js'),'utf8');
    code+='globalThis.Matter=(function(){const module={exports:{}};const exports=module.exports;'+lib+'\n;return module.exports})();\n';
    code+=fs.readFileSync(path.join(__dirname,'matter-controller.js'),'utf8')+'\n';
  }
  if(allLibraries||variant.startsWith('rapier')){
    const pkg=JSON.parse(fs.readFileSync(path.join(vendor,'@dimforge/rapier2d-compat/package.json'),'utf8'));if(pkg.version!==VERSIONS.rapier)throw Error('Pinned Rapier version required');
    const lib=fs.readFileSync(path.join(vendor,'@dimforge/rapier2d-compat/dist/rapier.mjs'));
    code+='globalThis.RAPIER=await import('+JSON.stringify('data:text/javascript;base64,'+lib.toString('base64'))+');await globalThis.RAPIER.init();\n';
    code+=fs.readFileSync(path.join(__dirname,'rapier-controller.js'),'utf8')+'\n';
  }
  code+=fs.readFileSync(path.join(__dirname,'integration.js'),'utf8')+'\n';
  code+='PhysicsProbe.defaultVariant='+JSON.stringify(variant)+';\n';
  return html.slice(0,end)+code+html.slice(end);
}
module.exports={inject,VERSIONS};
if(require.main===module){const root=path.resolve(__dirname,'../..'),variant=process.argv[2]||'original',dest=process.argv[3];if(!dest)throw Error('Usage: node scripts/physics-controller-probe/inject.cjs <variant> <output.html>');fs.writeFileSync(path.resolve(dest),inject(root,{variant}));}
