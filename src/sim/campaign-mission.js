import { scaleFormations } from '../definitions/campaign-pace.js';
// The gap between the soldiers of a formation that names none.
const FORMATION_SPACING = 34;

// Authored campaign beats issue ordinary spawns, captures and launch commands.
// Their progress belongs to the authoritative simulation and rolls back with it.
export class CampaignMission {
    static initialize(sim) {
        const mission = sim.rules.campaign?.mission;
        if (!mission) return null;

        if (mission.startingPremium)
            for (const [side, amount] of mission.startingPremium.entries())
                sim.creditResources(side, amount, 'premium');
        this.spawnFormations(sim, mission.formations);
        if (mission.guardPoint && this.point(sim, mission.guardPoint).owner !== 0)
            throw new Error(
                `캠페인 지킬 거점은 아군 시작 거점이어야 합니다: ${mission.guardPoint}`,
            );

        // A survival defence keeps every timing in ticks of the mission's clock (`clock`) converted once from the
        // stage's ms.
        return {
            firstCaptureComplete:
                !mission.firstCapture || this.point(sim, mission.firstCapture).owner === 0,
            waveIndex: -1,
            phase: mission.surviveMs ? 'defend' : 'complete',
            nextWaveTick: mission.waves?.length ? this.waveTick(sim, mission.waves[0]) : null,
            endTick: mission.surviveMs ? Math.max(1, sim.time.ceilTicks(mission.surviveMs)) : null,
            guardLost: false,
        };
    }

    static point(sim, id) {
        const point = sim.capturePoints.find((candidate) => candidate.id === id);
        if (!point) throw new Error(`캠페인 임무 거점이 없습니다: ${id}`);
        return point;
    }

    static spawnFormations(sim, formations = []) {
        const enemies = [];
        for (const formation of formations) {
            const {
                type,
                x,
                y,
                count,
                columns = count,
                spacing = FORMATION_SPACING,
                side = 1,
                hold,
            } = formation;
            const rows = Math.ceil(count / columns);
            for (let i = 0; i < count; i++) {
                const row = Math.floor(i / columns),
                    rowCount = Math.min(columns, count - row * columns),
                    dx = ((i % columns) - (rowCount - 1) / 2) * spacing,
                    dy = (row - (rows - 1) / 2) * spacing;
                const unit = sim.spawnUnit(side, type, x + dx, y + dy);
                // A garrison keeps its post and fights what comes into reach; it does not march on the base.
                if (hold) unit.holdPost = { x: unit.x, y: unit.y };
                if (side === 1) enemies.push(unit.id);
            }
        }
        return enemies;
    }

    // The ground one formation stands on, as a circle around its middle (what a spore cloud covers, SporeCloud).
    static formationRadius({ count, columns = count, spacing = FORMATION_SPACING }) {
        return (Math.hypot(Math.min(columns, count), Math.ceil(count / columns)) * spacing) / 2;
    }

    // The mission's clock, the one place every mission timing a stage declares in ms reads its tick from (defence
    // waves, the survival countdown, spore clouds, blight field growth, the enemy AI's start, a side goal's time).
    // `startTick` is the match tick the mission started: 0, or in a stage with a practice (CampaignPractice) the tick
    // the practice ended, null while it runs. `clock` is the ticks since then: the match tick itself in every match
    // without a practice, held at 0 while a practice runs. Both read `tick` and `campaignPractice` only, so they take
    // the simulation, its saved state or its snapshot alike.
    static startTick(sim) {
        return sim.campaignPractice ? sim.campaignPractice.doneTick : 0;
    }
    static clock(sim) {
        const start = this.startTick(sim);
        return start === null ? 0 : sim.tick - start;
    }

    // A wave's tick on the mission's clock.
    static waveTick(sim, wave) {
        return Math.max(1, sim.time.ceilTicks(wave.atMs));
    }

    // Attacks arrive on the clock: each wave spawns at its own `atMs` whether or not the earlier ones still stand.
    static beforeCommands(sim) {
        const state = sim.campaignMission;
        if (!state) return;
        const waves = sim.rules.campaign.mission.waves,
            clock = this.clock(sim);
        while (state.nextWaveTick !== null && clock >= state.nextWaveTick) {
            state.waveIndex++;
            this.spawnFormations(
                sim,
                scaleFormations(waves[state.waveIndex].formations, sim.rules.campaign.pace),
            );
            const next = waves[state.waveIndex + 1];
            state.nextWaveTick = next ? this.waveTick(sim, next) : null;
        }
    }

    static resolve(sim, winner) {
        const state = sim.campaignMission;
        if (!state || winner === 'guest' || winner === 'draw') return winner;
        const campaign = sim.rules.campaign,
            mission = campaign.mission;
        if (!state.firstCaptureComplete && this.point(sim, mission.firstCapture).owner === 0)
            state.firstCaptureComplete = true;

        if (state.phase === 'defend') {
            // Losing the guarded outpost loses the defence; the enemy base falling does not end it early.
            if (mission.guardPoint && this.point(sim, mission.guardPoint).owner !== 0) {
                state.guardLost = true;
                return 'guest';
            }
            if (this.clock(sim) < state.endTick) return null;
            state.phase = 'complete';
        }
        if (mission.surviveMs) return 'host';

        if (!state.firstCaptureComplete) return null;
        return winner;
    }

    static snapshot(state) {
        if (!state) return null;
        const { firstCaptureComplete, waveIndex, phase, nextWaveTick, endTick, guardLost } = state;
        return {
            firstCaptureComplete,
            waveIndex,
            phase,
            nextWaveTick,
            endTick,
            guardLost,
        };
    }

    static validate(state, mission) {
        const value = state.campaignMission;
        if (!mission) {
            if (value == null) return;
            throw new Error('게임 snapshot에 캠페인 임무 상태가 있습니다.');
        }
        const waveCount = mission.waves?.length ?? 0;
        const survive = !!mission.surviveMs;
        if (
            !value ||
            typeof value.firstCaptureComplete !== 'boolean' ||
            (!mission.firstCapture && !value.firstCaptureComplete) ||
            !Number.isSafeInteger(value.waveIndex) ||
            value.waveIndex < -1 ||
            value.waveIndex >= waveCount ||
            !['defend', 'complete'].includes(value.phase) ||
            (!survive && value.phase !== 'complete') ||
            (value.waveIndex + 1 < waveCount
                ? !Number.isSafeInteger(value.nextWaveTick) ||
                  value.nextWaveTick <= this.clock(state)
                : value.nextWaveTick !== null) ||
            (survive
                ? !Number.isSafeInteger(value.endTick) || value.endTick < 1
                : value.endTick !== null) ||
            typeof value.guardLost !== 'boolean' ||
            (value.guardLost && (!mission.guardPoint || value.phase !== 'defend'))
        )
            throw new Error('게임 snapshot의 캠페인 임무 상태가 잘못되었습니다.');
    }
}
