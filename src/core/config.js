// Engine, protocol and cadence constants shared by simulation, session and UI.

/* =========================
   1. Definitions
   ========================= */
const FP=100,SIM_VERSION=204;
// Local session policy, deliberately outside canonical gameplay/save rules.
// A session captures this setting once; changing it only affects the next match.
// single.botWorker runs the AI peer's whole session in src/sim-worker.js.
const CONFIG={netcode:{mode:'lockstep'},single:{botWorker:true}};
function netcodeMode(value=CONFIG.netcode.mode){
  if(value!=='lockstep'&&value!=='rollback')throw new Error('지원하지 않는 동기화 모드: '+value);
  return value;
}

// Authoritative time contract:
// - balance/design data uses integer milliseconds
// - fixed-duration runtime state uses absolute tick deadlines (Until/readyTick)
 // - elapsed/progress state uses StartedAt or explicit work progress, never decrementing countdowns
 // - repeating intervals use integer phase/remainder so low TPS does not accumulate drift

// Game-rule schema: engine/network contracts stay as constants above/below, while
// gameplay-tunable values live here so future modes/custom matches can override
// them without scattering `if(mode===...)` branches through the simulation.

// Cadence contract:
// - command apply / heavy UI snapshot publish: 10 Hz
// - deterministic simulation + lightweight Render State targets: selected SIM TPS
// - WebGL presentation: requestAnimationFrame (typically 60 Hz+)
// A launch press arms after this hold; dragging farther first cancels it.
const LAUNCH_HOLD_ARM_MS=250;
const LAUNCH_HOLD_DRAG_PX=10;
const STATE_PUBLISH_HZ=10;
const STATE_PUBLISH_INTERVAL_MS=1000/STATE_PUBLISH_HZ;

export { CONFIG, FP, LAUNCH_HOLD_ARM_MS, LAUNCH_HOLD_DRAG_PX, SIM_VERSION, STATE_PUBLISH_HZ, STATE_PUBLISH_INTERVAL_MS, netcodeMode };
