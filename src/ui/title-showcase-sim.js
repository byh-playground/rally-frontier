import { StrategySim } from '../sim/strategy-sim.js';
import { PRODUCT_VERSION } from '../core/product-version.js';
import { LaunchRules } from '../sim/launch-rules.js';

export function createTitleRun(seed) {
    const sim = new StrategySim(seed);
    for (const side of [0, 1]) {
        for (let level = 0; level < 2; level++) {
            sim.creditResources(side, LaunchRules.walletCap);
            if (!sim.upgradeLaunchRange(side))
                throw new Error('타이틀 사거리 강화를 적용하지 못했습니다.');
        }
    }
    let counts = [0, 0];
    let seq = 0;
    const types = ['rice', 'pea', 'millet', 'corn', 'chestnut', 'redbean'];
    const advance = () => {
        if (sim.tick % 20 === 1) {
            for (let side = 0; side < 2; side++) {
                const cannon = sim
                    .launchCannons(side)
                    .sort(
                        (a, b) =>
                            (a.x - sim.world.center.x) ** 2 +
                            (a.y - sim.world.center.y) ** 2 -
                            ((b.x - sim.world.center.x) ** 2 + (b.y - sim.world.center.y) ** 2),
                    )[0];
                if (!cannon) continue;
                sim.creditResources(side, LaunchRules.walletCap);
                sim.creditResources(side, LaunchRules.premiumWalletCap, 'premium');
                const target =
                    sim.units
                        .filter((unit) => unit.alive && unit.side !== side)
                        .sort(
                            (a, b) =>
                                (a.x - cannon.x) ** 2 +
                                (a.y - cannon.y) ** 2 -
                                ((b.x - cannon.x) ** 2 + (b.y - cannon.y) ** 2),
                        )[0] || sim.world.center;
                const type = types[counts[side] % types.length];
                sim.queueCommand({
                    tick: sim.tick + 1,
                    seq: ++seq,
                    actor: side ? 'guest' : 'host',
                    action: {
                        type: 'LAUNCH',
                        cannonId: cannon.id,
                        unitType: type,
                        holdMs: 1500,
                        x: target.x,
                        y: target.y,
                    },
                });
            }
        }
        sim.stepSimulation();
        for (const receipt of sim.commandReceipts || []) {
            if (receipt.applied && receipt.tick === sim.tick)
                counts[receipt.actor === 'guest' ? 1 : 0]++;
        }
    };
    return {
        sim,
        advance,
        save: () => ({
            state: structuredClone(sim.exportState()),
            counts: [...counts],
            seq,
            checksum: sim.checksum(),
        }),
        restore(checkpoint) {
            sim.importState(structuredClone(checkpoint.state));
            counts = [...checkpoint.counts];
            seq = checkpoint.seq;
        },
    };
}

// Reusable authoring operation; called by the generator when game version changes.
export async function generateTitleCheckpoints() {
    const run = createTitleRun(12349);
    const checkpoints = [];
    for (const tick of [296, 508, 826]) {
        while (run.sim.tick < tick) {
            run.advance();
            if (run.sim.tick % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
        }
        checkpoints.push(run.save());
    }
    run.sim.dispose?.('title-authoring');
    return { productVersion: PRODUCT_VERSION, seed: 12349, checkpoints };
}
