import { RallyGamekit } from '../core/gamekit.js';
import { createPresentationView } from '../render/presentation-effects.js';
import { prepareTitleShowcase } from './title-showcase.js';

// The card and title previews mount this through createShowcaseHost; the debug scenes open one directly.
export function createShowcaseSurface(createRenderer) {
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

async function prepareShowcaseScene({ surface, scene, signal, present }) {
    const { renderer } = surface;
    let prepare = prepareTitleShowcase;
    if (scene.kind !== 'title') {
        const scenes = await import('./unit-showcase.js');
        prepare =
            scene.kind === 'campaign-opening'
                ? scenes.prepareCampaignOpening
                : scenes.prepareUnitShowcase;
    }
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
            onLaunch: scene.onLaunch,
            onComplete: scene.onComplete,
        });
    } catch (error) {
        release();
        throw error;
    }
    let onFirstFrame = () => {
        onFirstFrame = null;
        present();
    };
    return {
        play() {
            if (!ownsRenderer()) return;
            renderer.playShowcase(onError, onFirstFrame);
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
