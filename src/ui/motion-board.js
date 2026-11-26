/**
 * 병종 동작 디스플레이(`?debug=1&board=motion`): 같은 전투를 두 번 실제 경기 렌더러로 돌려 왼쪽은 선언형 동작
 * (sprite 계약의 `motion`)을 끈 모습, 오른쪽은 지금 모습을 실시간으로 반복해 나란히 보인다. 병종 목록은 `motion`을
 * 선언한 병종에서 만든다. 눈으로 보는 확인 도구이고 판정은 하지 않는다. 일반 실행에서는 불러오지 않는다.
 * 주소 선택: `unit=<id>`(한 병종), `group=<n>`(6병종씩), `speed=0.25`.
 */
import { UNITS } from '../units/index.js';
import { GRAIN_SPRITES } from '../render/grain-sprite-registry.js';
import { StrategySim } from '../sim/strategy-sim.js';
import { UnitDefinition } from '../definitions/units.js';
import { buildOutpost, centerCamera, placeBlock, prepareSimScene } from './sim-scene.js';
import { createShowcaseSurface } from './showcase-host.js';
import { useDebugStyle } from './debug-style.js';

const SEED = 12345,
    GROUP_SIZE = 6,
    LOOP_MS = 7000,
    // A lane is one small fight: this far apart, so neighbouring lanes do not join in.
    LANE_X = 400,
    LANE_Y = 300,
    // Half the distance between the two sides of a lane when it starts.
    GAP = 75,
    COUNT = 5,
    FOES = 6,
    SPEEDS = Object.freeze([1, 0.5, 0.25]);

// A flat open field with both bases far off and silent, and one fight per unit in a two-column grid.
function createLanes(units) {
    const foes = units.map((id) => (id === 'pea' ? 'rice' : 'pea'));
    const sim = new StrategySim(SEED, undefined, [units, [...new Set(foes)]]);
    const { x, y } = sim.world.center;
    const columns = units.length > 1 ? 2 : 1,
        rows = Math.ceil(units.length / columns);
    const state = sim.exportState();
    const host = { x: x - 1500, y },
        guest = { x: x + 1500, y };
    state.mapDescriptor = {
        ...state.mapDescriptor,
        spawns: { host, guest },
        capturePoints: [],
        laneControlPoints: { top: [], mid: [host, guest], bot: [] },
        terrain: {
            layers: [],
            ramps: [],
            blockers: [],
            riverPath: [],
            riverBranches: [],
            riverPolygon: [],
            riverBranchPolygons: [],
            riverHalfWidth: 0,
            bridges: [],
        },
    };
    state.capturePoints = [];
    state.flags = [
        { ...guest, forced: false },
        { ...host, forced: false },
    ];
    for (const building of state.buildings) {
        Object.assign(building, building.side === 0 ? host : guest);
        building.cooldownUntil = Number.MAX_SAFE_INTEGER;
    }
    sim.importState(state);
    units.forEach((id, i) => {
        const cx = x + ((i % columns) - (columns - 1) / 2) * LANE_X,
            cy = y + (Math.floor(i / columns) - (rows - 1) / 2) * LANE_Y;
        placeBlock(sim, 0, [id], COUNT, { x: cx - GAP, y: cy }, { x: 1, y: 0 });
        // A unit that only attacks buildings gets a silent enemy outpost to batter instead of soldiers.
        if (UnitDefinition.onlyAttacksBuildings(id)) {
            const outpost = buildOutpost(sim, { id: `board-${i}`, x: cx + GAP, y: cy }, 1);
            outpost.cooldownUntil = Number.MAX_SAFE_INTEGER;
        } else placeBlock(sim, 1, [foes[i]], FOES, { x: cx + GAP, y: cy }, { x: -1, y: 0 });
    });
    return {
        sim,
        center: { x, y },
        width: columns * LANE_X - 130,
        height: rows * LANE_Y - 80,
    };
}

export function openMotionBoard({ createRenderer, createScenario, createPresentationView }) {
    const declared = UNITS.map((card) => card.id).filter((id) => GRAIN_SPRITES[id]?.motion),
        names = new Map(UNITS.map((card) => [card.id, card.unit.name])),
        groups = [];
    for (let i = 0; i < declared.length; i += GROUP_SIZE)
        groups.push(declared.slice(i, i + GROUP_SIZE));

    const query = new URLSearchParams(location.search);
    // The scenes read a clock this page owns, so slow motion and pause slow everything they draw.
    const realNow = performance.now.bind(performance);
    let clock = realNow();
    performance.now = () => clock;
    let speed = SPEEDS.includes(Number(query.get('speed'))) ? Number(query.get('speed')) : 1,
        paused = false,
        runs = [],
        owed = 0,
        last = null;

    useDebugStyle();

    const page = document.createElement('div');
    page.className = 'motion-board';
    page.innerHTML = '<nav></nav><nav></nav><div class="mb-panels"></div>';
    document.body.append(page);
    const [pick, controls, panels] = page.children;
    const back = document.createElement('a');
    back.className = 'mb-back';
    back.href = `${location.pathname}?debug=1`;
    back.textContent = '‹ 디버그';
    pick.append(back);

    const button = (bar, label, onClick) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.onclick = onClick;
        bar.append(b);
        return b;
    };
    const press = (list, chosen) => {
        for (const b of list) b.setAttribute('aria-pressed', String(b === chosen));
    };

    const sides = ['개편 전', '지금'].map((label, index) => {
        const figure = document.createElement('figure');
        figure.innerHTML = '<figcaption></figcaption><div class="mb-stage"></div>';
        figure.firstChild.textContent = label;
        panels.append(figure);
        const surface = createShowcaseSurface(createRenderer);
        figure.lastChild.append(surface.element);
        const { renderer } = surface;
        renderer.motionDisabled = index === 0;
        renderer.role = 'host';
        renderer.replayObserverAll = true;
        renderer.prepareGameResources();
        renderer.resize();
        return renderer;
    });

    const fail = (error) => {
        console.error(error);
        paused = true;
        controls.textContent = `장면 오류: ${error.message}`;
    };

    const show = (units) => {
        for (const run of runs) run.scene.dispose();
        runs = sides.map((renderer) => {
            renderer.stopLoop();
            renderer.resize();
            const lanes = createLanes(units);
            // The zoom at which the whole grid of lanes fills this canvas.
            renderer.replayZoom =
                Math.min(
                    renderer.canvas.width / lanes.width,
                    renderer.canvas.height / lanes.height,
                ) / renderer.baseSc();
            const camera = () => centerCamera(renderer, lanes.center.x, lanes.center.y);
            const scene = prepareSimScene({
                renderer,
                createScenario,
                createPresentationView,
                sim: lanes.sim,
                seed: SEED,
                endTick: lanes.sim.time.ceilTicks(LOOP_MS),
                loop: true,
                start: camera,
                render: camera,
                onError: fail,
            });
            scene.play({ automatic: false });
            renderer.playShowcase(fail);
            return { scene, tickMs: 1000 / lanes.sim.tps };
        });
        owed = 0;
    };

    const unitButtons = [];
    const choose = (b, units) => () => {
        press(unitButtons, b);
        show(units);
    };
    const addChoice = (label, units) => {
        const b = button(pick, label, null);
        b.onclick = choose(b, units);
        unitButtons.push(b);
        return b;
    };
    const groupButtons = groups.map((units, i) =>
        addChoice(groups.length > 1 ? `모아 보기 ${i + 1}` : '모아 보기', units),
    );
    const oneButtons = new Map(declared.map((id) => [id, addChoice(names.get(id), [id])]));

    const speedButtons = SPEEDS.map((value) =>
        button(controls, value === 1 ? '실제 속도' : `${value}배`, null),
    );
    speedButtons.forEach((b, i) => {
        b.onclick = () => {
            speed = SPEEDS[i];
            press(speedButtons, b);
        };
    });
    press(speedButtons, speedButtons[SPEEDS.indexOf(speed)]);
    const pause = button(controls, '멈춤', () => {
        paused = !paused;
        pause.setAttribute('aria-pressed', String(paused));
    });

    const first =
        oneButtons.get(query.get('unit')) ??
        groupButtons[Number(query.get('group') || 1) - 1] ??
        groupButtons[0];
    first.click();

    const frame = () => {
        const now = realNow(),
            passed = last === null ? 0 : Math.min(100, now - last);
        last = now;
        if (!paused) {
            clock += passed * speed;
            owed += passed * speed;
        }
        for (const run of runs) run.scene.render();
        while (runs.length && owed >= runs[0].tickMs) {
            owed -= runs[0].tickMs;
            for (const run of runs) run.scene.step();
        }
        requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
}
