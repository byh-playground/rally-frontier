// The blight's spore cloud (포자 구름): when the wind blows a cloud of spores drifts in, and blighted soldiers stand
// where it settles. A blighted stage declares its clouds (campaign.js):
//     sporeClouds: [{ atMs: 10_000, everyMs: 30_000, warnMs: 5_000, times: 4,
//                     formations: [{ type: 'rice', x: 1400, y: 1700, count: 10, columns: 5 }] }]
// A cloud is a defence wave (campaign-mission.js `waves: [{ atMs, formations }]`) that repeats and is announced: its
// soldiers first appear `atMs` after the match starts and again every `everyMs`, `times` times in all (without
// `times`, for as long as the match runs), and each arrival is announced `warnMs` before it. The soldiers are
// ordinary enemy soldiers, blighted as every unit created for the blight's side is (Blight.mark), and march on the
// player as a wave's do: they are spawned by the wave's own CampaignMission.spawnFormations, at the wave's place in
// the tick (before the tick's commands). Their head counts follow the stage's pace as a wave's do
// (campaign-pace.js `scaleFormations`), so the difficulty reaches a stage whose enemy only comes by cloud.
// The cloud itself is presentation only and judges nothing. The simulation knows two ticks of each arrival, both
// taken from the match's ms on the wave's rule (`ceilTicks`, never a tick count added up) on the mission's clock
// (CampaignMission.clock, held while a practice runs): the tick its warning begins (`sporeCloudWarn`) and the tick its
// soldiers appear (`sporeCloudArrive`).
// `sim.sporeCloud { arrived }` is the only state: how many times each declared cloud has arrived. It exists only in
// a stage that declares clouds, so every other match's state and checksum are what they were.
import { UnitDefinition } from '../definitions/units.js';
import { Blight } from './blight.js';
import { scaleFormations } from '../definitions/campaign-pace.js';
import { CampaignMission } from './campaign-mission.js';
import { LaunchRules } from './launch-rules.js';

export class SporeCloud {
    // The stage's declared clouds, checked, or null: only a blighted stage has them.
    static declared(sim) {
        const clouds = sim.rules.campaign?.sporeClouds;
        if (clouds === undefined) return null;
        if (!Blight.declared(sim))
            throw new Error('포자 구름은 감염(blight: true)을 선언한 판에만 둘 수 있습니다.');
        if (!Array.isArray(clouds) || !clouds.length)
            throw new Error('포자 구름 선언은 비어 있지 않은 목록이어야 합니다.');
        for (const cloud of clouds) {
            const { atMs, everyMs, warnMs, times, formations } = cloud ?? {};
            if (
                !Number.isFinite(warnMs) ||
                warnMs <= 0 ||
                !Number.isFinite(atMs) ||
                atMs < warnMs ||
                !Number.isFinite(everyMs) ||
                everyMs < warnMs
            )
                throw new Error(
                    '포자 구름 선언에는 양수 warnMs와 그 이상인 atMs, everyMs가 필요합니다.',
                );
            if (times !== undefined && (!Number.isSafeInteger(times) || times < 1))
                throw new Error(`포자 구름의 횟수(times)는 1 이상의 정수여야 합니다: ${times}`);
            if (!Array.isArray(formations) || !formations.length)
                throw new Error('포자 구름 선언에는 비어 있지 않은 formations 목록이 필요합니다.');
            for (const formation of formations) {
                const { type, x, y, count, side, hold } = formation ?? {};
                if (
                    !UnitDefinition.get(type) ||
                    LaunchRules.isHeroType(type) ||
                    !Number.isSafeInteger(count) ||
                    count < 1 ||
                    side !== undefined ||
                    hold !== undefined
                )
                    throw new Error(
                        `포자 구름에서 나올 수 없는 병사 선언입니다: ${type} × ${count}`,
                    );
                if (
                    !Number.isFinite(x) ||
                    !Number.isFinite(y) ||
                    x < 0 ||
                    y < 0 ||
                    x > sim.world.width ||
                    y > sim.world.height
                )
                    throw new Error('포자 구름의 formations에는 맵 안의 x, y가 필요합니다.');
            }
        }
        return clouds;
    }

    // Match start (StrategySim constructor): no cloud has arrived.
    static initialize(sim) {
        const clouds = this.declared(sim);
        if (clouds) sim.sporeCloud = { arrived: clouds.map(() => 0) };
    }

    // The tick the cloud's arrival number `index` (0 the first) appears, and the tick its warning begins, both on the
    // mission's clock (CampaignMission.clock: the match tick unless a practice held the mission back).
    static arriveTick(sim, cloud, index) {
        return Math.max(1, sim.time.ceilTicks(cloud.atMs + index * cloud.everyMs));
    }
    static warnTick(sim, cloud, index) {
        return Math.max(1, sim.time.ceilTicks(cloud.atMs + index * cloud.everyMs - cloud.warnMs));
    }

    // One tick (StrategySim.stepSimulation, with the mission's waves, before the tick's commands): each cloud's
    // next arrival is announced on its warning tick and its soldiers appear on its arrival tick.
    static beforeCommands(sim) {
        const state = sim.sporeCloud;
        if (!state) return;
        const clouds = sim.rules.campaign.sporeClouds,
            clock = CampaignMission.clock(sim),
            start = CampaignMission.startTick(sim);
        for (let i = 0; i < clouds.length; i++) {
            const cloud = clouds[i];
            while (cloud.times === undefined || state.arrived[i] < cloud.times) {
                const arriveTick = this.arriveTick(sim, cloud, state.arrived[i]);
                if (clock < arriveTick) {
                    if (clock === this.warnTick(sim, cloud, state.arrived[i]))
                        sim.events.push({
                            type: 'sporeCloudWarn',
                            cloud: i,
                            arriveTick: start + arriveTick,
                        });
                    break;
                }
                CampaignMission.spawnFormations(
                    sim,
                    scaleFormations(cloud.formations, sim.rules.campaign.pace),
                );
                state.arrived[i]++;
                for (const formation of cloud.formations)
                    sim.events.push({
                        type: 'sporeCloudArrive',
                        cloud: i,
                        side: Blight.ENEMY_SIDE,
                        x: formation.x,
                        y: formation.y,
                        radius: CampaignMission.formationRadius(formation),
                    });
            }
        }
    }

    // What the renderer reads (StrategySim.snapshot): the clouds drifting in now, one per formation of each
    // arrival under warning, with the match tick its warning began and the match tick it arrives.
    static view(sim) {
        const state = sim.sporeCloud;
        if (!state) return undefined;
        const coming = [],
            clouds = sim.rules.campaign.sporeClouds,
            clock = CampaignMission.clock(sim),
            start = CampaignMission.startTick(sim);
        for (let i = 0; i < clouds.length; i++) {
            const cloud = clouds[i];
            if (cloud.times !== undefined && state.arrived[i] >= cloud.times) continue;
            const warnTick = this.warnTick(sim, cloud, state.arrived[i]);
            if (clock < warnTick) continue;
            const arriveTick = this.arriveTick(sim, cloud, state.arrived[i]);
            for (const formation of cloud.formations)
                coming.push({
                    x: formation.x,
                    y: formation.y,
                    radius: CampaignMission.formationRadius(formation),
                    warnTick: start + warnTick,
                    arriveTick: start + arriveTick,
                });
        }
        return { coming };
    }
}
