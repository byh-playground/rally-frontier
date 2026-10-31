// Dedicated module Worker that hosts a simulation session off the main thread.
// main.js detects the Worker realm, skips UI boot and installs SimWorkerHost.
// Its UI section still evaluates, so it gets an inert DOM: every node, context
// and call resolves to the same no-op object.
const fatal=error=>self.postMessage({type:'fatal',message:String(error?.message||error),stack:String(error?.stack||'')});
self.__RALLY_PRESENT_FATAL__=detail=>fatal(detail?.message||detail);
self.addEventListener('unhandledrejection',e=>fatal(e.reason));
self.addEventListener('error',e=>fatal(e.error||e.message));

const inert=new Proxy(function(){},{
  get(_,key){
    if(key===Symbol.toPrimitive)return()=>0;
    if(key===Symbol.iterator)return function*(){};
    if(key==='then'||typeof key==='symbol')return undefined;
    return inert;
  },
  set:()=>true,has:()=>false,deleteProperty:()=>true,
  apply:()=>inert,construct:()=>inert
});
self.document??=inert;
for(const name of ['MutationObserver','ResizeObserver','IntersectionObserver','Image','HTMLElement','HTMLCanvasElement','Element','Node','matchMedia','getComputedStyle','AudioContext','webkitAudioContext','Audio','screen','visualViewport','history','innerWidth','innerHeight','devicePixelRatio','scrollTo','alert','confirm','prompt','open'])if(!(name in self))self[name]=inert;
const memoryStorage=new Map();
self.localStorage??={getItem:k=>memoryStorage.has(k)?memoryStorage.get(k):null,setItem:(k,v)=>void memoryStorage.set(k,String(v)),removeItem:k=>void memoryStorage.delete(k),clear:()=>memoryStorage.clear(),key:i=>[...memoryStorage.keys()][i]??null,get length(){return memoryStorage.size}};
self.sessionStorage??=self.localStorage;
// GameKit's bundled anime.js picks set/clearImmediate outside the browser; it never ticks here.
self.setImmediate??=callback=>setTimeout(callback,0);
self.clearImmediate??=clearTimeout;
try{await import('./main.js')}catch(error){fatal(error)}
