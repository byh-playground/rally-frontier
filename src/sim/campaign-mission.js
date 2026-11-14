const HERO_LESSON_STEPS = ['launch', 'fight', 'recover', 'redeploy', 'done'];

// Authored campaign beats issue ordinary spawns, captures and launch commands.
// Their progress belongs to the authoritative simulation and rolls back with it.
export class CampaignMission {
    static initialize(sim) {
        const mission = sim.rules.campaign?.mission;
        if (!mission) return null;

        if (mission.startingPremium)
            for (const [side, amount] of mission.startingPremium.entries())
                sim.creditResources(side, amount, 'premium');
        const targetIds = this.spawnFormations(sim, mission.formations);
        if (mission.guardPoint && this.point(sim, mission.guardPoint).owner !== 0)
            throw new Error(
                `캠페인 지킬 거점은 아군 시작 거점이어야 합니다: ${mission.guardPoint}`,
            );

        // A survival defence keeps every timing in sim ticks converted once from the stage's ms.
        return {
            firstCaptureComplete:
                !mission.firstCapture || this.point(sim, mission.firstCapture).owner === 0,
            waveIndex: -1,
            phase: mission.surviveMs ? 'defend' : 'complete',
            nextWaveTick: mission.waves?.length ? this.waveTick(sim, mission.waves[0]) : null,
            endTick: mission.surviveMs ? sim.msTicks(mission.surviveMs, { min: 1 }) : null,
            guardLost: false,
            ...(mission.heroLesson && {
                heroLesson: {
                    step: 'launch',
                    targets: sim.units
                        .filter(({ id }) => targetIds.includes(id))
                        .map((unit) => {
                            unit.status.terrainRevealUntil0 = Number.MAX_SAFE_INTEGER;
                            const { id, x, y } = unit;
                            return { id, x, y };
                        }),
                },
            }),
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
            const { type, x, y, count, columns = count, spacing = 34, side = 1, hold } = formation;
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

    static waveTick(sim, wave) {
        return sim.msTicks(wave.atMs, { min: 1 });
    }

    // Attacks arrive on the clock: each wave spawns at its own `atMs` whether or not the earlier ones still stand.
    static beforeCommands(sim) {
        const state = sim.campaignMission;
        if (!state) return;
        const waves = sim.rules.campaign.mission.waves;
        while (state.nextWaveTick !== null && sim.tick >= state.nextWaveTick) {
            state.waveIndex++;
            this.spawnFormations(sim, waves[state.waveIndex].formations);
            const next = waves[state.waveIndex + 1];
            state.nextWaveTick = next ? this.waveTick(sim, next) : null;
        }
    }

    static resolve(sim, winner) {
        const state = sim.campaignMission;
        if (!state || winner === 'guest' || winner === 'draw') return winner;
        const campaign = sim.rules.campaign,
            mission = campaign.mission;
        if (mission.heroLesson) return this.resolveHeroLesson(sim, mission.heroLesson);
        if (!state.firstCaptureComplete && this.point(sim, mission.firstCapture).owner === 0)
            state.firstCaptureComplete = true;

        if (state.phase === 'defend') {
            // Losing the guarded outpost loses the defence; the enemy base falling does not end it early.
            if (mission.guardPoint && this.point(sim, mission.guardPoint).owner !== 0) {
                state.guardLost = true;
                return 'guest';
            }
            if (sim.tick < state.endTick) return null;
            state.phase = 'complete';
        }
        if (mission.surviveMs) return 'host';

        if (!state.firstCaptureComplete) return null;
        return winner;
    }

    static heroLessonRallyPoint(sim, unit) {
        if (unit.side !== 1) return null;
        return sim.campaignMission?.heroLesson?.targets.find(({ id }) => id === unit.id) ?? null;
    }

    static resolveHeroLesson(sim, lesson) {
        const state = sim.campaignMission.heroLesson,
            hero = sim.heroes[0][lesson.type],
            landed = sim.events.some(
                (event) =>
                    event.type === 'launchLand' && event.side === 0 && event.unit === lesson.type,
            ),
            heroEvent = (type) =>
                sim.events.some(
                    (event) =>
                        event.type === type && event.side === 0 && event.heroType === lesson.type,
                );
        if (hero?.mode === 'dead') return 'guest';

        if (state.step === 'launch' && landed) state.step = 'fight';
        // The hero clears the training squad; its kills count toward its level (HeroGrowth).
        if (state.step === 'fight' && state.targets.every(({ id }) => !sim.unitById.get(id)?.alive))
            state.step = lesson.recover ? 'recover' : 'done';
        if (state.step === 'recover' && heroEvent('heroRecovered')) state.step = 'redeploy';
        if (state.step === 'redeploy' && landed) state.step = 'done';
        if (state.step === 'done') return 'host';
        return null;
    }

    static volleyGoalContains(goal, position) {
        return Math.hypot(position.x - goal.x, position.y - goal.y) <= goal.radius;
    }

    static snapshot(state) {
        if (!state) return null;
        const {
            firstCaptureComplete,
            waveIndex,
            phase,
            nextWaveTick,
            endTick,
            guardLost,
            heroLesson,
        } = state;
        return {
            firstCaptureComplete,
            waveIndex,
            phase,
            nextWaveTick,
            endTick,
            guardLost,
            ...(heroLesson && { heroLessonStep: heroLesson.step }),
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
                ? !Number.isSafeInteger(value.nextWaveTick) || value.nextWaveTick <= state.tick
                : value.nextWaveTick !== null) ||
            (survive
                ? !Number.isSafeInteger(value.endTick) || value.endTick < 1
                : value.endTick !== null) ||
            typeof value.guardLost !== 'boolean' ||
            (value.guardLost && (!mission.guardPoint || value.phase !== 'defend'))
        )
            throw new Error('게임 snapshot의 캠페인 임무 상태가 잘못되었습니다.');
        this.validateHeroLesson(value.heroLesson, mission.heroLesson);
    }

    static validateHeroLesson(value, lesson) {
        if (!lesson && value == null) return;
        if (
            !lesson ||
            !value ||
            !HERO_LESSON_STEPS.includes(value.step) ||
            (!lesson.recover && ['recover', 'redeploy'].includes(value.step)) ||
            !Array.isArray(value.targets) ||
            !value.targets.length ||
            value.targets.some(
                (target) =>
                    !target ||
                    typeof target.id !== 'string' ||
                    !target.id ||
                    !Number.isFinite(target.x) ||
                    !Number.isFinite(target.y),
            ) ||
            new Set(value.targets.map(({ id }) => id)).size !== value.targets.length
        )
            throw new Error('게임 snapshot의 영웅 훈련 상태가 잘못되었습니다.');
    }
}
