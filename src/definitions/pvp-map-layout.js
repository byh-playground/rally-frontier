// Shared pieces of the fixed PvP maps, each laid out from its host half and turned 180° for the guest.

const OPPOSITE_LANE = Object.freeze({ top: 'bot', mid: 'mid', bot: 'top' });

// The map turned half a turn about its centre: the guest's half of every authored host-side piece.
export function halfTurn(width, height) {
    return ({ x, y }) => ({ x: width - x, y: height - y });
}

// Each row [id, laneKey, label, position, resourceType] is a host-side point (stage 1); its half turn is the
// guest's point (stage 2) on the opposite lane.
export function pairedCapturePoints(turn, rows) {
    return rows.flatMap(([id, laneKey, label, position, resourceType]) => [
        capturePoint(`${id}-1`, laneKey, label, 1, resourceType, position),
        capturePoint(`${id}-2`, OPPOSITE_LANE[laneKey], label, 2, resourceType, turn(position)),
    ]);
}

// A point both sides contest (stage 0).
export function neutralCapturePoint(id, laneKey, label, resourceType, position) {
    return capturePoint(id, laneKey, label, 0, resourceType, position);
}

function capturePoint(id, laneKey, label, stage, resourceType, { x, y }) {
    return { id, lane: laneKey.toUpperCase(), laneKey, label, stage, resourceType, x, y };
}

// A lane drawn from the host to the guest, and the same road walked by the other side.
export function turnedLane(turn, lane) {
    return lane.map(turn).reverse();
}

// The water fields of a map without water.
export function noWater() {
    return {
        riverPath: [],
        riverBranches: [],
        riverPolygon: [],
        riverBranchPolygons: [],
        riverHalfWidth: 0,
        bridges: [],
    };
}
