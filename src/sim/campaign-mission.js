const HERO_LESSON_STEPS = ['launch', 'skill', 'cast', 'recover', 'redeploy', 'done'];

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

        return {
            firstCaptureComplete:
                !mission.firstCapture || this.point(sim, mission.firstCapture).owner === 0,
            waveIndex: -1,
            phase: mission.waves?.length ? 'waiting' : 'complete',
            nextWaveTick: mission.waves?.length
                ? sim.msTicks(mission.waves[0].delayMs, { min: 1 })
                : null,
            waveUnitIds: [],
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

    static beforeCommands(sim) {
        const state = sim.campaignMission;
        if (!state) return;
        const mission = sim.rules.campaign.mission;
        if (state.phase === 'waiting' && sim.tick >= state.nextWaveTick) {
            state.waveIndex++;
            state.phase = 'wave';
            state.nextWaveTick = null;
            state.waveUnitIds = this.spawnFormations(
                sim,
                mission.waves[state.waveIndex].formations,
            );
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

        if (
            state.phase === 'wave' &&
            state.waveUnitIds.every((id) => !sim.unitById.get(id)?.alive)
        ) {
            state.waveUnitIds = [];
            const nextWave = mission.waves[state.waveIndex + 1];
            if (nextWave) {
                state.phase = 'waiting';
                state.nextWaveTick = sim.tick + sim.msTicks(nextWave.delayMs, { min: 1 });
            } else state.phase = 'complete';
        }

        if (!state.firstCaptureComplete || state.phase === 'waiting' || state.phase === 'wave')
            return null;
        return mission.waves?.length && campaign.mode === 'defend' ? 'host' : winner;
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

        if (state.step === 'launch' && landed) state.step = 'skill';
        if (state.step === 'skill' && heroEvent('heroSkillStarted')) state.step = 'cast';
        if (state.step === 'cast') {
            const unit = sim.unitById.get(hero?.unitId),
                fruit = unit?.fruitAttack;
            if (
                !unit?.heroRoll &&
                !fruit?.active &&
                !fruit?.projectiles.some(({ mode }) => mode === 'active')
            )
                state.step = lesson.recover ? 'recover' : 'done';
        }
        if (state.step === 'recover' && heroEvent('heroRecovered')) state.step = 'redeploy';
        if (state.step === 'redeploy' && landed) state.step = 'done';
        if (state.step === 'done') return 'host';

        if (
            (state.step === 'launch' || state.step === 'skill') &&
            state.targets.every(({ id }) => !sim.unitById.get(id)?.alive)
        )
            return 'guest';
        return null;
    }

    static volleyGoalContains(goal, position) {
        return Math.hypot(position.x - goal.x, position.y - goal.y) <= goal.radius;
    }

    static snapshot(state) {
        if (!state) return null;
        const { firstCaptureComplete, waveIndex, phase, nextWaveTick, heroLesson } = state;
        return {
            firstCaptureComplete,
            waveIndex,
            phase,
            nextWaveTick,
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
        const phases = ['waiting', 'wave', 'complete'];
        if (
            !value ||
            typeof value.firstCaptureComplete !== 'boolean' ||
            (!mission.firstCapture && !value.firstCaptureComplete) ||
            !Number.isSafeInteger(value.waveIndex) ||
            value.waveIndex < -1 ||
            value.waveIndex >= waveCount ||
            !phases.includes(value.phase) ||
            (!waveCount && value.phase !== 'complete') ||
            (value.phase === 'waiting'
                ? !Number.isSafeInteger(value.nextWaveTick) ||
                  value.nextWaveTick <= state.tick ||
                  value.waveIndex + 1 >= waveCount
                : value.nextWaveTick !== null) ||
            (value.phase === 'wave' && value.waveIndex < 0) ||
            (value.phase === 'complete' && value.waveIndex !== waveCount - 1) ||
            !Array.isArray(value.waveUnitIds) ||
            value.waveUnitIds.some((id) => typeof id !== 'string' || !id) ||
            new Set(value.waveUnitIds).size !== value.waveUnitIds.length ||
            (value.phase !== 'wave' && value.waveUnitIds.length !== 0)
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
