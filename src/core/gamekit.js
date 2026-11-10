// Both realms load the pinned simulation and session SDK; the page also prepares its art.
// prettier-ignore
const RALLY_GAMEKIT_MODULES=Object.freeze({"rollback":"rollback.js","deterministic":"deterministic.js","simloop":"simloop.js","transport":"transport.js","interpolation":"interpolation.js","input":"input.js","rendering":"rendering.js","vectorAssets":"vector-assets.js","camera":"camera.js","events":"presentation-events.js","hud":"hud.js","debug":"debug-tools.js","vectorAssetsLoader":"vector-assets-loader.js","navigation":"navigation.js","objectPool":"object-pool.js","geometry":"geometry.js","spatial":"spatial.js","face":"face.js","pathfield":"pathfield.js","vision":"vision.js","scenario":"scenario.js","boot":"boot.js"});
const SESSION_MODULE_NAMES = new Set([
    'rollback',
    'deterministic',
    'simloop',
    'events',
    'geometry',
    'spatial',
    'pathfield',
    'vision',
    'boot',
]);
const SIM_WORKER = typeof WorkerGlobalScope !== 'undefined';
// Resolve from this module so the page and the Worker realm load the same files.
// prettier-ignore
const RALLY_ASSET_ROOT=new URL('../../',import.meta.url);
// prettier-ignore
const RALLY_GAMEKIT_SOURCE=Object.freeze({lock:new URL('gamekit.lock.json',RALLY_ASSET_ROOT).href});
const RALLY_VECTOR_ASSET_MANIFEST_URL = new URL('assets/units/manifest.json', RALLY_ASSET_ROOT)
    .href;
let RALLY_NETCODE_URL = RALLY_GAMEKIT_SOURCE.lock;
let RallyNetcode, RallyGamekit, RallyBoot;
// Startup stages and their share of the bar: measured wall time on a desktop build, in tenths of a second, with the
// SDK raised for a real CDN. Counts are real work items; the bar never estimates time. `graphics` is one synchronous
// GPU frame, so it has no count and fills when it ends.
const RALLY_BOOT_STAGES = Object.freeze([
    { id: 'sdk', weight: 5 },
    { id: 'units', weight: 2 },
    { id: 'sprites', weight: 7 },
    { id: 'graphics', weight: 12 },
    { id: 'title', weight: 5 },
]);
const RALLY_BOOT_LABELS = Object.freeze({
    sdk: '게임 모듈',
    units: '유닛 그림',
    sprites: '병종 스프라이트',
    graphics: '그래픽 준비 중',
    title: '타이틀 장면 준비 중',
});
// boot.js itself has to arrive before it can report anything: verify and import this one file here.
async function importVerifiedModule(url, sha256, name) {
    const response = await fetch(url);
    if (!response.ok)
        throw new Error('Gamekit module load failed: ' + name + ' HTTP ' + response.status);
    const bytes = await response.arrayBuffer();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
        b.toString(16).padStart(2, '0'),
    ).join('');
    if (digest !== sha256) throw new Error('Gamekit module SHA-256 mismatch: ' + name);
    const objectURL = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
    try {
        return await import(objectURL);
    } finally {
        URL.revokeObjectURL(objectURL);
    }
}
async function loadRallyVectorAssets(loaderModule, boot) {
    const response = await fetch(RALLY_VECTOR_ASSET_MANIFEST_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error('Unit SVG manifest를 불러오지 못했습니다.');
    const manifest = await response.json();
    if (
        !manifest ||
        manifest.schemaVersion !== 1 ||
        !Array.isArray(manifest.assets) ||
        !manifest.assets.length ||
        manifest.assets.length > 1024
    )
        throw new Error('Unit SVG manifest 형식이 올바르지 않습니다.');
    const ids = new Set();
    for (const entry of manifest.assets) {
        if (
            !entry ||
            Object.keys(entry).sort().join(',') !== 'bytes,id,sha256,sourcePath,url' ||
            typeof entry.id !== 'string' ||
            !/^[a-z0-9][a-z0-9-]*$/.test(entry.id) ||
            ids.has(entry.id)
        )
            throw new Error('Unit SVG id가 올바르지 않거나 중복되었습니다.');
        ids.add(entry.id);
        const sourcePath = `assets/units/${entry.id}.svg`;
        if (
            entry.sourcePath !== sourcePath ||
            !Number.isSafeInteger(entry.bytes) ||
            entry.bytes < 1 ||
            entry.bytes > 524288 ||
            !/^[a-f0-9]{64}$/.test(entry.sha256 || '')
        )
            throw new Error('Unit SVG manifest entry가 올바르지 않습니다: ' + entry.id);
        if (entry.url !== `./${sourcePath}`)
            throw new Error('Unit SVG URL이 허용되지 않습니다: ' + entry.id);
    }
    if (typeof loaderModule?.createVectorAssetLoader !== 'function')
        throw new Error('Gamekit vector asset loader API가 없습니다.');
    const loader = loaderModule.createVectorAssetLoader({ maxEntries: manifest.assets.length });
    boot.begin('units', manifest.assets.length);
    // Preserve the pre-upgrade SVG geometry: curve16 and round-stroke arc12.
    const loaded = await Promise.all(
        manifest.assets.map(async (entry) => {
            const asset = await loader.load(new URL(entry.sourcePath, RALLY_ASSET_ROOT).href, {
                sourcePath: entry.sourcePath,
                expectedSha256: entry.sha256,
                maxBytes: entry.bytes,
                curveSegments: 16,
                strokeArcDivisions: 12,
                includeSourcePaths: false,
            });
            if (asset.sourceSha256 !== entry.sha256 || Object.hasOwn(asset, 'sourcePaths'))
                throw new Error(
                    'Unit SVG 무결성 또는 compiler output 검증에 실패했습니다: ' + entry.id,
                );
            boot.advance('units');
            return [entry.id, asset];
        }),
    );
    if (loader.size !== manifest.assets.length)
        throw new Error('Unit SVG cache 검증에 실패했습니다.');
    return { assets: Object.freeze(Object.fromEntries(loaded)), loader };
}
try {
    const lockResponse = await fetch(RALLY_GAMEKIT_SOURCE.lock, { cache: 'no-store' });
    if (!lockResponse.ok)
        throw new Error(
            'Gamekit lock를 불러오지 못했습니다. npm run setup:gamekit 후 HTTP 서버를 실행해 주세요.',
        );
    const gamekitLock = await lockResponse.json();
    if (
        gamekitLock.repository !== 'byh-playground/bloom-gamekit' ||
        !/^[a-f0-9]{40}$/.test(gamekitLock.sourceCommit || '') ||
        !/^[a-f0-9]{40}$/.test(gamekitLock.distCommit || '')
    )
        throw new Error('Gamekit lock 출처가 올바르지 않습니다.');
    const gamekitSource = Object.freeze({
        repository: gamekitLock.repository,
        sourceCommit: gamekitLock.sourceCommit,
        distCommit: gamekitLock.distCommit,
    });
    RALLY_NETCODE_URL = 'gamekit:' + gamekitSource.distCommit;
    // Import only immutable official ESM bytes from the pinned dist; keep source files unchanged.
    const moduleFiles = Object.entries(RALLY_GAMEKIT_MODULES).filter(
        ([name]) => !SIM_WORKER || SESSION_MODULE_NAMES.has(name),
    );
    for (const [name, file] of moduleFiles) {
        const entry = gamekitLock.modules[name];
        if (!entry || entry.file !== file || !/^[a-f0-9]{64}$/.test(entry.sha256 || ''))
            throw new Error('Gamekit lock entry mismatch: ' + name);
    }
    const base =
        'https://cdn.jsdelivr.net/gh/' +
        gamekitSource.repository +
        '@' +
        gamekitSource.distCommit +
        '/';
    const bootModule = await importVerifiedModule(
        base + gamekitLock.modules.boot.file,
        gamekitLock.modules.boot.sha256,
        'boot',
    );
    // The Worker realm only loads the session SDK; the page owns the visible bar and the art stages.
    RallyBoot = bootModule.createBoot({
        stages: SIM_WORKER ? RALLY_BOOT_STAGES.slice(0, 1) : RALLY_BOOT_STAGES,
    });
    if (!SIM_WORKER) {
        // The inline source-file counter (index.html) owned the status line until now.
        globalThis.__RALLY_SOURCE_PROGRESS__?.disconnect();
        bootModule.bindBootProgress(RallyBoot, {
            progress: document.getElementById('bootProgressBar'),
            label: document.getElementById('bootStatus'),
            labels: RALLY_BOOT_LABELS,
            done: '준비 완료',
        });
    }
    // boot receives, verifies (SHA-256) and imports the rest, advancing once per module.
    const namespaces = {
        boot: bootModule,
        ...(await RallyBoot.importPinnedModules(
            {
                base,
                modules: Object.fromEntries(
                    moduleFiles
                        .filter(([name]) => name !== 'boot')
                        .map(([name]) => [name, gamekitLock.modules[name]]),
                ),
            },
            { stage: 'sdk' },
        )),
    };
    const modules = moduleFiles.map(([name]) => [name, namespaces[name]]);
    if (!SIM_WORKER) {
        const loaded = await loadRallyVectorAssets(namespaces.vectorAssetsLoader, RallyBoot);
        const { loadGrainSpriteCanvases } = await import('../render/grain-sprite-registry.js');
        globalThis.RallyVectorAssets = loaded.assets;
        globalThis.RallyVectorAssetLoader = loaded.loader;
        // Registry order matches atlas allocation order; shared canvases count once.
        globalThis.RallySpriteCanvases = await loadGrainSpriteCanvases(RallyBoot);
    }
    RallyNetcode = Object.freeze({
        ...namespaces.rollback,
        ...namespaces.deterministic,
        ...namespaces.simloop,
        ...namespaces.transport,
    });
    RallyGamekit = Object.freeze(Object.assign({}, ...modules.map(([, module]) => module)));
    globalThis.RallyGamekit = RallyGamekit;
    const requiredGameKit = ['PresentationEventQueue'];
    if (!SIM_WORKER)
        requiredGameKit.push(
            'PresentationRuntime',
            'RenderObject',
            'WebGLDevice',
            'estimateTextureAtlasLayers',
            'createDOMInput',
            'CameraViewport',
            'resolveAnchorInto',
            'DiagnosticRing',
            'ReplayTimeline',
            'VectorContext',
            'createVectorActor',
            'holdVectorAsset',
            'createVectorAssetLoader',
            'compilePoseChannels',
            'ObjectPool',
            'createNavigation',
            'createScenario',
            'createScenarioSurface',
        );
    for (const name of requiredGameKit)
        if (typeof RallyGamekit[name] !== 'function')
            throw new Error('Gamekit module API missing: ' + name);
    const requiredPresentationMethods = [
        [
            RallyGamekit.PresentationEventQueue,
            ['configureDisplay', 'present', 'setPresentationActive'],
        ],
    ];
    if (!SIM_WORKER)
        requiredPresentationMethods.push([RallyGamekit.PresentationRuntime, ['setRate', 'finish']]);
    for (const [type, methods] of requiredPresentationMethods)
        for (const method of methods)
            if (typeof type.prototype[method] !== 'function')
                throw new Error('Gamekit presentation API missing: ' + method);
    if (!SIM_WORKER && !Array.isArray(RallyGamekit.VECTOR_RENDERER_ATLAS_REGIONS))
        throw new Error('Gamekit vector renderer atlas reservation API가 없습니다.');
    const requiredNetcode = [
        'createSession',
        'hashBytes',
        'createValueCodec',
        'createLoop',
        'runSyncTestAsync',
    ];
    if (!SIM_WORKER) requiredNetcode.push('WebRTCTransport', 'createNostrSignaler');
    for (const name of requiredNetcode) {
        if (typeof RallyNetcode[name] !== 'function')
            throw new Error(
                '공개 라이브러리에 필수 API ' +
                    name +
                    '가 없습니다. 라이브러리 배포 상태를 확인해 주세요.',
            );
    }
    if (
        typeof Object.getOwnPropertyDescriptor(
            RallyNetcode.SyncTestSession?.prototype || {},
            'metrics',
        )?.get !== 'function'
    )
        throw new Error(
            '공개 라이브러리에 Synctest metrics API가 없습니다. 라이브러리 배포 상태를 확인해 주세요.',
        );
    if (typeof RallyNetcode.RollbackSession?.prototype.exportSyncTestFrames !== 'function')
        throw new Error(
            '공개 라이브러리에 확정 입력 Synctest export API가 없습니다. 라이브러리 배포 상태를 확인해 주세요.',
        );
    globalThis.RallyNetcode = RallyNetcode;
    globalThis.RallyNetcodeSource = Object.freeze({
        url: RALLY_NETCODE_URL,
        version: RallyNetcode.VERSION,
        pinned: true,
        ...gamekitSource,
    });
} catch (error) {
    RallyBoot?.fail(error);
    globalThis.__RALLY_PRESENT_FATAL__({
        kind: 'RALLY_NETCODE_LOAD_FAILED',
        message:
            '넷코드 라이브러리를 불러오지 못해 게임을 시작할 수 없습니다. ' +
            String(error?.message || error),
        url: RALLY_NETCODE_URL,
    });
    // Dependent modules never evaluate, as the old IIFE `return` stopped the app.
    await new Promise(() => {});
}

export { RallyBoot, RallyGamekit, RallyNetcode };
