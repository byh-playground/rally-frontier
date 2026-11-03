// Session pulse, catch-up, reconnection and lockstep delay constants.
import { STATE_PUBLISH_INTERVAL_MS } from './config.js';

// wall-clock driver 한 pulse의 bounded catch-up. 논리 dt와 tick sequence는 Core가 유지한다.
const MAX_CATCHUP_STEPS_PER_PULSE=3;
const SIM_SUSPENSION_THRESHOLD_MS=3000;
const LOCKSTEP_INPUT_DELAY_BASE_MS=100;
const LOCKSTEP_INPUT_DELAY_MAX_MS=300;

// DataChannel reconnection / authoritative session recovery.
const P2P_RECONNECT_MIN_MS=350;
const P2P_CONNECT_ATTEMPT_TIMEOUT_MS=4500;
const DISCONNECT_GRACE_MS=60*1000;

const NETWORK_HEALTH_POLL_MS=100;

// Simulation is not tied to requestAnimationFrame.
// Worker/main-thread pulses schedule bounded work; Core holds an ahead peer.
const BACKGROUND_TICK_PULSE_MS=25;
const SNAPSHOT_EMIT_INTERVAL_MS=STATE_PUBLISH_INTERVAL_MS;

export { BACKGROUND_TICK_PULSE_MS, DISCONNECT_GRACE_MS, LOCKSTEP_INPUT_DELAY_BASE_MS, LOCKSTEP_INPUT_DELAY_MAX_MS, MAX_CATCHUP_STEPS_PER_PULSE, NETWORK_HEALTH_POLL_MS, P2P_CONNECT_ATTEMPT_TIMEOUT_MS, P2P_RECONNECT_MIN_MS, SIM_SUSPENSION_THRESHOLD_MS, SNAPSHOT_EMIT_INTERVAL_MS };
