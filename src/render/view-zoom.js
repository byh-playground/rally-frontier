import { RangeUtil } from '../core/game-rules.js';

// User camera range, shared by live wheel/pinch and replay zoom controls.
export const DEFAULT_LIVE_ZOOM = 1.5;
export const MAX_VIEW_ZOOM = 3.5;

export function formatViewZoom(value) {
    return Math.round(value * 100) + '%';
}

export function clampViewZoom(value) {
    return RangeUtil.clamp(Number(value) || 1, 0.6, MAX_VIEW_ZOOM);
}
