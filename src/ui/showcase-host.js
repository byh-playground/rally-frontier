import { RallyGamekit } from '../core/gamekit.js';
import { createPresentationView } from '../render/presentation-effects.js';
import { prepareTitleShowcase } from './title-showcase.js';

function createShowcaseSurface(createRenderer) {
    const element = document.createElement('div');
    element.className = 'launch-showcase-surface';
    element.setAttribute('aria-hidden', 'true');
    const canvas = document.createElement('canvas');
    const fxCanvas = document.createElement('canvas');
    fxCanvas.className = 'fx-canvas';
    element.append(canvas, fxCanvas);
    // Both renderers consume the same loaded vector assets and decoded sprite canvases.
    const renderer = createRenderer(canvas, fxCanvas);
    return {
        element,
        renderer,
        dispose() {
            this.sceneOwner = null;
            renderer.disposeShowcase();
        },
    };
}

async function prepareShowcaseScene({ surface, scene, signal }) {
    const { renderer } = surface;
    const prepare =
        scene.kind === 'title'
            ? prepareTitleShowcase
            : (await import('./unit-showcase.js')).prepareUnitShowcase;
    signal.throwIfAborted();
    const owner = {};
    surface.sceneOwner = owner;
    const ownsRenderer = () => surface.sceneOwner === owner;
    const release = () => {
        if (!ownsRenderer()) return;
        surface.sceneOwner = null;
        renderer.releaseShowcaseScene();
    };
    const onError = (error) => {
        if (!ownsRenderer()) return;
        console.error(error);
        scene.onError?.(error);
    };
    let scenario;
    try {
        renderer.prepareGameResources();
        renderer.resize();
        scenario = await prepare({
            renderer,
            createScenario: RallyGamekit.createScenario,
            createPresentationView,
            unitType: scene.unitType,
            signal,
            onError,
        });
    } catch (error) {
        release();
        throw error;
    }
    return {
        play() {
            if (!ownsRenderer()) return;
            renderer.playShowcase(onError);
            scenario.play();
        },
        pause() {
            scenario.pause();
            if (ownsRenderer()) renderer.stopLoop();
        },
        dispose() {
            try {
                scenario.dispose();
            } finally {
                release();
            }
        },
    };
}

export function createShowcaseHost(createRenderer) {
    return RallyGamekit.createScenarioSurface({
        createSurface: () => createShowcaseSurface(createRenderer),
        prepare: prepareShowcaseScene,
    });
}
