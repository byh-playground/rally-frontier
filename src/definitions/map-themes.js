// Map themes: how a map looks. A map definition names one theme (`theme: 'paddy'`) and nothing else about its looks;
// the ground, roads, yards, boundary, outside scenery, rocks, decoration and landmarks are all derived from the map's
// own geometry by these rules (src/render/map-look-layout.js). Terrain is the same: the map says where its layers,
// ramps, water and bridges are (`terrain`), the theme says how a hilltop, a sunken floor, a retaining wall, a ramp, a
// river and a bridge look.
// A theme is a palette plus rule numbers: no coordinates.
// Lengths are world units, `per1000Edge` counts are per 1000 units of map boundary, `perMillion` per 1,000,000 units²
// of map area, and shares/chances are 0..1.
// A theme picks its motifs by `kind` (and by which rules it has), never by its own name: the patches beside the
// roads (`dirt.kind`), the marks along a road (`lanes.marks`), a yard (`yards.*.kind`), a base's border
// (`base.border`), the scenery beyond the map (`outside.paddy` fields, `outside.canopy` treetops), and every
// decoration, prop and landmark by its kind name.

// 논두렁: a grass field with dirt roads and straw yards, banked off from flooded rice paddies.
const paddy = {
    palette: {
        // Far scenery fades into this colour; the screen beyond the baked ground is cleared with it.
        haze: '#c3c8aa',
        grass: {
            base: '#8fa66a',
            light: '#a0b476',
            dark: '#7a9158',
            bladeLight: '#b0c27e',
            bladeDark: '#688048',
        },
        dirt: { rim: '#aa9f6c', fill: '#c5b986', light: '#d3c89a' },
        // Raised ground (terrain layers and ramps): a wash of lighter grass on a hilltop; a retaining wall of
        // earth (foot to top) under courses of stone (lowest first), its parapet and cap stones; the shadows it
        // casts; a ramp of bare earth from its foot to its head, with log treads.
        terrain: {
            top: '#d4e28c',
            // Ground below the field (a negative terrain level): a wash of damper grass on its floor, and a
            // sloped bank (a layer with an inner outline) from damp earth at its foot up into the grass.
            low: '#587648',
            bank: '#8a8458',
            earth: ['#6f5f41', '#9b8558'],
            courses: [
                ['#8f8974', '#9a937c'],
                ['#b3ab92', '#a59d85'],
            ],
            stoneLight: '#e2dcc4',
            foot: '#3a3422',
            parapet: '#7b7058',
            caps: ['#c3bda5', '#b2ac94', '#cfc9b2'],
            capShade: '#403c2a',
            capLight: '#f0ecd8',
            shadow: '#30381c',
            shade: '#2e361a',
            rampMouth: '#b4a06e',
            rampLow: '#96804f',
            rampHigh: '#c8b17e',
            tread: '#705834',
            treadLight: '#e2d0a0',
        },
        // A river: wet earth along its shore, shallows fading into the deeper middle, a bright line where the
        // water meets the shore, short ripples, and the pale shallows where a road wades through.
        water: {
            shore: '#8f8a62',
            deep: '#7da69d',
            shallow: '#a6c2b0',
            edge: '#d6e6d6',
            ripple: '#dbeadf',
            rippleShade: '#6a968e',
            ford: '#bcc8a4',
        },
        // A timber bridge: its shadow on what lies under it, dark gaps between planks of three tones, a beam
        // along each side, and the timber and piles of a side seen where the deck stands above its ground.
        bridge: {
            shadow: '#34402e',
            gap: '#6e5636',
            planks: ['#b08a58', '#a37e50', '#b89462'],
            beam: '#84653e',
            beamLight: '#d2b382',
            side: '#7a5e3a',
            pile: '#5a452c',
        },
        road: {
            shoulder: '#b2ac70',
            edge: '#9c8457',
            fill: '#b49c69',
            crown: '#c4b484',
            rut: '#8c744a',
        },
        bank: {
            shadow: '#46502d',
            side: '#8b8457',
            top: '#a99f6c',
            lip: '#96aa64',
            light: '#cec494',
            foot: '#555f37',
        },
        base: { rim: '#968a5c', fill: '#c4b385', light: '#d6ca9e', rut: '#806a42' },
        straw: {
            rim: '#968c5a',
            fill: '#c9bb80',
            bandLight: '#d6c992',
            bandDark: '#b2a068',
            weave: '#a08c56',
            rope: '#96804e',
            ropeLight: '#d6c48c',
            light: '#e8deb0',
            mark: '#a8925a',
        },
        paving: {
            shadow: '#50482a',
            rim: '#ad9567',
            fill: '#c6b085',
            stones: ['#cdb88c', '#c7b184', '#d4c097'],
            stoneLight: '#e2d0a8',
            light: '#ecdcb0',
            shade: '#5a4224',
            mark: '#4a3824',
            markLight: '#d2ba82',
            markBed: '#826842',
        },
        rock: {
            bed: '#96875c',
            shadow: '#3a3e24',
            warm: ['#686252', '#c4bca2'],
            cool: ['#606258', '#bcbcaa'],
            line: '#4e4a3c',
        },
        outside: {
            grass: '#9aaa78',
            ring: '#93a672',
            bund: '#a7a874',
            bundShade: '#7f8a5c',
            water: '#94ae98',
            waterGlint: '#b4c8b4',
            waterRow: '#789c60',
            green: '#93ab6a',
            greenRow: '#7f9c5a',
            fallow: '#b8ae82',
            fallowRow: '#a69c70',
        },
        decor: {
            tuft: ['#6f8c4b', '#7b9756'],
            straw: ['#cdbd84', '#bba86e'],
            pebble: ['#a9a48d', '#bbb39a'],
            pebbleLight: '#e6e0c8',
        },
        prop: {
            shadow: '#30381e',
            trunk: '#7d6443',
            trunkLine: '#4e3e2a',
            leaf: '#6f8a4c',
            leafLine: '#46592f',
            leafLight: '#88a35d',
            leafTop: '#9db56f',
            straw: '#bfae74',
            strawLight: '#d6c891',
            strawLine: '#7f6c3c',
            strawTie: '#8a7442',
            reed: ['#7d9655', '#90a865'],
            reedHead: '#8b6b45',
            wood: '#a57c4c',
            woodDark: '#8d6a40',
            woodLine: '#5a4128',
            rail: '#a2845a',
            post: '#8d6f48',
            metal: '#7b7d74',
            cloth: '#a0675a',
            face: '#e6d9b0',
            hat: '#c9b46e',
            wall: '#d2c4a0',
            wallShade: '#b9a982',
            wallLine: '#7c6a4a',
            roof: '#8a6a46',
            door: '#6c5236',
            sail: '#efe6cc',
            sailLine: '#a4906a',
            hub: '#5b4630',
            barnWall: '#a7784c',
            barnShade: '#8f6640',
            barnLine: '#5e4129',
            thatch: '#c9b77a',
            thatchLight: '#dccc92',
            thatchLine: '#a8955c',
            pole: '#6d5638',
            finial: '#d9c99a',
        },
    },
    lanes: {
        // The road follows the lane control points; the middle lane is the main road.
        width: { mid: 136, side: 96 },
        shoulder: 64,
        wobble: 13,
        // What marks a road's surface: 'ruts' (two wheel ruts) or 'roots' (roots reaching in from its edges).
        marks: 'ruts',
    },
    grass: { blotchesPerMillion: 3.2, blotchRadius: [180, 560], bladeSpacing: 110 },
    dirt: {
        // Patches beside the roads, clear of the bases. 'earth': trodden, dried ground, small, light and
        // crisp-edged. 'leaves': fallen leaves (`leaves` of them a lobe, each `leafSize` long).
        kind: 'earth',
        patchesPerMillion: 1.4,
        spacing: 380,
        laneSpread: 700,
        radius: [62, 128],
        baseClearance: 300,
        yardClearance: 130,
        terrainClearance: 160,
    },
    // Raised ground. Heights are the map's own (a terrain level), these are only how a wall and a ramp are built.
    terrain: {
        // How strongly the hilltop wash covers the grass (0..1), and the wash of a sunken floor.
        topTint: 0.52,
        lowTint: 0.56,
        // A wall face: one course of stones per this much height, stones this long, and a parapet this high
        // above the ground the wall holds up.
        wall: { courseHeight: 24, stone: [44, 78], parapet: 15 },
        // Cap stones along the parapet: their length, the gap between two, their thickness on screen.
        cap: { length: [26, 44], gap: 4, thickness: 11 },
        // A wall's shadow on the low ground (offset on screen, towards the lower right), and the shade behind a
        // wall seen from its back.
        shadow: {
            offset: [24, 20],
            width: 40,
            feather: 24,
            alpha: 0.34,
            backFeather: 46,
            backAlpha: 0.36,
        },
        // Log treads this far apart up a ramp, and how far the bare earth spreads from its foot.
        ramp: { treadSpacing: 34, mouth: 64 },
        // Decoration stays this far from a cliff, a ramp wall, a ramp, a bank, water and a bridge.
        decorClearance: 60,
    },
    // Water (the map's river polygons). Its shore band, how far the shallows reach in from the shore, ripples
    // per 1,000,000 units² of water (their length, the gap between two, their distance from the shore), and
    // how softly a ford's edge fades.
    water: {
        shore: { width: 30, feather: 14 },
        shallows: 46,
        ripples: { perMillion: 70, length: [26, 54], spacing: 70, clearance: 28 },
        ford: { feather: 26 },
    },
    // A bridge deck (the map's bridges): planks this long across it, a beam this wide along each side, piles
    // this far apart under a raised side, a railing this far in from each side with posts this far apart, and
    // the deck's shadow (offset on screen, towards the lower right).
    bridges: {
        plank: 24,
        beam: 9,
        pileSpacing: 70,
        rail: { inset: 7, postSpacing: 90 },
        shadow: { offset: [16, 14], feather: 14, alpha: 0.26 },
    },
    base: {
        radius: 245,
        ruts: [112, 128, 150],
        band: { inset: 16, width: 20, exitGap: 0.34 },
        flags: { count: 3, spread: 0.75, inset: 14 },
    },
    // The yard under a capture point, by its resource; a contested point (no owner side) is set apart.
    yards: {
        basic: { kind: 'straw', radius: 215, variants: 3 },
        premium: { kind: 'paving', radius: 195, contested: { radius: 215, sides: 8 } },
    },
    boundary: {
        bank: { offset: 34, width: 70, height: 22 },
        // One fence per map side, on the stretch farthest from every road.
        fences: { length: 0.32, offset: 130, postSpacing: 110 },
    },
    // A blocker is filled with piles of stones that never leave its polygon. A polygon thicker than
    // `stoneScale.thickness` (its area over half its outline) gets bigger stones, up to `stoneScale.max` times;
    // one pile of these stones goes on every `pileArea` units² of it (scaled with the stones, at least one).
    blockers: {
        pileArea: 60000,
        stoneScale: { thickness: 150, max: 1.5 },
        // A polygon with scaled stones also gets a row of its smallest stones just inside its outline, so no
        // bare bed is left between the piles and the edge that blocks.
        edgeStones: 6,
        stoneRadii: [74, 68, 62, 58, 54, 50, 46, 42, 38, 34, 30, 28, 26, 24, 22, 20],
        stacked: 4,
        // One farm tool leaning inside the first blocker.
        tools: ['hoe'],
    },
    decor: {
        clustersPer1000Edge: 6,
        // Where the small clusters go: outside and on the boundary, around blockers, in the open field.
        share: { outside: 0.7, blockers: 0.25, field: 0.05 },
        kinds: { tuft: 0.5, straw: 0.28, pebble: 0.22 },
    },
    outside: {
        // How far beyond the boundary the scenery reaches before it has dissolved into the haze: to the left and
        // right (`side`), and up and down the map (`far`, the direction a zoomed-out camera can look past the map).
        margin: { side: 640, far: 2600 },
        // Fog over unseen scenery beyond the map: its strength against the fog on the map (0..1), reached this
        // far from the map's edge.
        fog: { strength: 0.45, fadeDistance: 128 },
        paddy: {
            width: [470, 630],
            depth: [360, 480],
            clearance: 175,
            bund: 17,
            water: 0.62,
            fallow: 0.14,
        },
        // Standing props beyond the boundary, each at its own distance from the map edge.
        props: [
            { kind: 'tree', per1000Edge: 0.6, distance: [240, 340], scale: [0.9, 1.2] },
            { kind: 'stack', per1000Edge: 0.15, distance: [170, 270], scale: [0.9, 1] },
            { kind: 'reeds', per1000Edge: 0.23, distance: [150, 200], scale: [0.9, 1] },
            { kind: 'cart', count: 1, distance: [200, 240], scale: [1, 1] },
            { kind: 'scarecrow', count: 1, distance: [240, 280], scale: [1, 1] },
        ],
    },
    // One landmark behind each base, beyond the map edge that base backs onto, in spawn order.
    landmarks: { kinds: ['windmill', 'barn'], offset: 260, inset: 400 },
    // The match camera may go past each map edge until this share of the view (0..1) shows the scenery outside.
    camera: { margin: 0.2 },
};

// 견과 숲: a cool, mossy forest floor with pale trodden paths, fallen leaves beside them, log-section yards and
// flat stone paving, ringed by tall trees whose crowns stay beyond the map.
// The floor is a cool green and the paths a pale grey sand: the nut soldiers are red-browns, so nothing they
// fight on is brown.
const nutForest = {
    ...paddy,
    palette: {
        haze: '#a9c0b0',
        grass: {
            base: '#6f9d80',
            light: '#80ac8c',
            dark: '#5f8d74',
            bladeLight: '#98bf96',
            bladeDark: '#4d7c64',
        },
        // Fallen leaves beside the paths: a faint warm bed under scattered leaves of a few tones, each with a rib.
        litter: {
            bed: '#8ea870',
            leaves: ['#e0953e', '#d2ac48', '#c4703a', '#e6bd62'],
            rib: '#9a6030',
        },
        // Mossy rock walls: damp earth under courses of grey-green stone, capped with moss.
        terrain: {
            top: '#b9d8a0',
            low: '#4c7a68',
            bank: '#5a7c5e',
            earth: ['#4c5648', '#6c7862'],
            courses: [
                ['#7c887a', '#889482'],
                ['#9aa692', '#a8b29e'],
            ],
            stoneLight: '#d0dac4',
            foot: '#28342a',
            parapet: '#587050',
            caps: ['#8cae76', '#7c9f6a', '#a0ba88'],
            capShade: '#2f452f',
            capLight: '#d2e6b6',
            shadow: '#20382c',
            shade: '#1e342a',
            rampMouth: '#b4b498',
            rampLow: '#939278',
            rampHigh: '#bebca0',
            tread: '#7a5c3a',
            treadLight: '#dcc294',
        },
        // A forest stream: clearer and bluer than paddy water.
        water: {
            shore: '#6c8c70',
            deep: '#5e9ea0',
            shallow: '#8cbfb6',
            edge: '#d2ece4',
            ripple: '#d8f0ea',
            rippleShade: '#3c7c88',
            ford: '#a8ccbc',
        },
        // A bridge of weathered logs laid side by side: grey, so tan soldiers crossing it stay clear of it.
        bridge: {
            shadow: '#223a30',
            gap: '#5e5646',
            planks: ['#a69c84', '#998f78', '#b3a990'],
            beam: '#6e4e30',
            beamLight: '#caa272',
            side: '#6a4c2e',
            pile: '#4a3520',
        },
        road: {
            shoulder: '#8eaa84',
            edge: '#8c927a',
            fill: '#bcba9e',
            crown: '#cdcbb0',
            root: '#8a7052',
        },
        bank: {
            shadow: '#2a4434',
            side: '#587a5a',
            top: '#789c6a',
            lip: '#8cb27a',
            light: '#b2d09a',
            foot: '#32503c',
        },
        base: {
            rim: '#86907a',
            fill: '#c3bfa2',
            light: '#d8d5bc',
            rut: '#8d8a70',
            log: '#9c7648',
            logLight: '#cca676',
            logEnd: '#e2cc9c',
            logLine: '#5c4028',
        },
        // A yard cut from a great trunk: bark round it, weathered grey wood with growth rings, a few cracks from the
        // heart. Grey, not fresh tan: walnuts and peanuts fight on it.
        rings: {
            shadow: '#284030',
            bark: '#7c5c3c',
            barkLight: '#a47e54',
            fill: '#c4c0a2',
            ringLight: '#d2cfb2',
            ringDark: '#b0ac92',
            line: '#90927c',
            crack: '#7c7e68',
            light: '#ecead6',
            mark: '#8a6c40',
            markLight: '#e2ca92',
            markBed: '#9c7e4e',
        },
        // Flat grey stones with moss in the joints.
        paving: {
            shadow: '#284030',
            rim: '#6a8478',
            fill: '#7e9a92',
            stones: ['#aebcb8', '#a2b2b0', '#bac8c4'],
            stoneLight: '#dfe4d4',
            light: '#eaeedf',
            shade: '#3c4a3a',
            mark: '#3a3c32',
            markLight: '#cdd1be',
            markBed: '#6c786a',
        },
        rock: {
            bed: '#5c826a',
            shadow: '#22382c',
            warm: ['#5a6254', '#b6bca6'],
            cool: ['#545f58', '#acb6aa'],
            line: '#3c463a',
            moss: ['#6c9a5c', '#90ba76'],
        },
        outside: {
            grass: '#648f74',
            ring: '#5c886e',
            canopy: ['#4a7c5e', '#447458', '#528564'],
            canopyLight: '#66996e',
            canopyShade: '#33604a',
        },
        decor: {
            tuft: ['#4c805a', '#5a8e64'],
            pebble: ['#a2aa9a', '#b4baa8'],
            pebbleLight: '#e2e8d8',
            mushroomCap: ['#dc644c', '#e2a454'],
            mushroomStem: '#f0e8d4',
            mushroomSpot: '#fff6e4',
            acorn: ['#bc864c', '#a4703e'],
            acornCap: '#6c4a2c',
            acornLight: '#e2b47c',
        },
        prop: {
            ...paddy.palette.prop,
            shadow: '#20382c',
            trunk: '#7a5a3c',
            trunkLine: '#4a3624',
            leaf: '#4e8762',
            leafLine: '#2e5a46',
            leafLight: '#66a274',
            leafTop: '#86ba84',
            pine: '#3e775a',
            pineLight: '#56926c',
            pineLine: '#28503e',
            wood: '#a27c4e',
            woodDark: '#86623c',
            woodLine: '#563c24',
            woodEnd: '#dec696',
            woodRing: '#b8965e',
            moss: '#74a062',
            hollow: '#3a2a1e',
            rail: '#a07c50',
            post: '#86663e',
            cabinRoof: '#5c8060',
            cabinRoofLight: '#76996e',
            cabinRoofLine: '#3c5a44',
            door: '#5c4028',
            window: '#f0d890',
            chimney: '#8c9284',
            pole: '#6a5238',
            finial: '#dccc9c',
        },
    },
    lanes: { ...paddy.lanes, marks: 'roots' },
    grass: { ...paddy.grass, bladeSpacing: 100 },
    // Leaf litter where paddy has dried earth: the same placement, a little more of it.
    dirt: {
        ...paddy.dirt,
        kind: 'leaves',
        patchesPerMillion: 2,
        leaves: [10, 16],
        leafSize: [13, 20],
    },
    bridges: { ...paddy.bridges, plank: 30 },
    // Packed earth inside a border of logs laid end to end (each this long and thick), open where the roads leave.
    base: { ...paddy.base, border: { log: 64, width: 16 } },
    yards: {
        // Bark this wide round the wood, and a mark for the resource in the middle.
        basic: { kind: 'rings', radius: 215, bark: 9, roots: 0, mark: 'grain' },
        // The contested point is a great stump: thicker bark and roots flaring out of it.
        premium: {
            kind: 'paving',
            radius: 195,
            contested: { kind: 'rings', radius: 215, bark: 20, roots: 7, mark: 'oil' },
        },
    },
    // Share of a blocker's stones with moss on top; no tool leans on them.
    blockers: { ...paddy.blockers, tools: [], moss: 0.7 },
    decor: {
        clustersPer1000Edge: 7,
        share: paddy.decor.share,
        kinds: { tuft: 0.4, mushroom: 0.25, acorn: 0.2, pebble: 0.15 },
    },
    outside: {
        margin: paddy.outside.margin,
        fog: paddy.outside.fog,
        // Treetops seen from above, painted on the ground beyond the map: one every `spacing`, this wide, none
        // nearer the map than `clearance` (the standing trees fill that band).
        canopy: { spacing: 215, radius: [125, 175], clearance: 400 },
        // Standing trees in two rows (the taller the farther, so no crown reaches over the map), fallen logs and
        // stumps at the forest's edge.
        props: [
            { kind: 'pine', per1000Edge: 2.4, distance: [300, 370], scale: [0.9, 1.15] },
            { kind: 'tree', per1000Edge: 2.2, distance: [440, 540], scale: [1, 1.3] },
            { kind: 'log', per1000Edge: 0.3, distance: [160, 210], scale: [0.9, 1.1] },
            { kind: 'stump', per1000Edge: 0.35, distance: [150, 220], scale: [0.85, 1.1] },
        ],
    },
    landmarks: { kinds: ['hollowTree', 'cabin'], offset: 260, inset: 400 },
};

// 밭 마을: sunny farmland round a village. A warm olive meadow with clay roads, tilled plots for yards, hedged
// crop fields beyond the boundary (green crops, golden wheat, turned earth) with cottages and a silo behind the
// bases. The roads are a pale clay, not brown: grain soldiers are tan and gold.
const fieldTown = {
    ...paddy,
    palette: {
        ...paddy.palette,
        haze: '#d8d2a6',
        grass: {
            base: '#a2b466',
            light: '#b4c576',
            dark: '#8da057',
            bladeLight: '#bccd80',
            bladeDark: '#7a8f48',
        },
        terrain: { ...paddy.palette.terrain, top: '#e0e69a', low: '#6b8650' },
        road: {
            shoulder: '#b8b672',
            edge: '#b69c72',
            fill: '#cdb48a',
            crown: '#dcc69e',
            rut: '#a98e66',
        },
        base: { rim: '#a8946a', fill: '#d2bd92', light: '#e0cfa6', rut: '#a38a62' },
        // A tilled plot: soil, dark furrows, pale ridges, and three crops.
        furrows: {
            rim: '#9a8456',
            soil: '#b99468',
            furrow: '#8a6a46',
            ridge: '#cba879',
            sprout: '#6f9a46',
            sproutLight: '#a9cc6e',
            grain: '#d2b24c',
            grainLight: '#ecd27a',
            cabbage: '#86b06a',
            cabbageLight: '#b8d890',
            border: '#8c8570',
            borderLight: '#cfc8b0',
            light: '#f0e6c0',
            mark: '#8a6a40',
        },
        paving: {
            ...paddy.palette.paving,
            rim: '#9a9482',
            fill: '#b4ad98',
            stones: ['#cfc8b4', '#c4bda8', '#d8d2c0'],
            stoneLight: '#ece6d4',
            light: '#f4efde',
        },
        outside: {
            grass: '#a8b878',
            ring: '#a0b270',
            // The hedges between the fields.
            bund: '#6f8f4a',
            bundShade: '#557236',
            // Wheat, in the cells the paddy theme floods.
            water: '#dcc46c',
            waterGlint: '#f0e0a0',
            waterRow: '#c8ae56',
            green: '#a4b85a',
            greenRow: '#8ea446',
            // Turned earth.
            fallow: '#b08a60',
            fallowRow: '#97734c',
        },
        prop: {
            ...paddy.palette.prop,
            wall: '#ece0c0',
            wallShade: '#d2c49e',
            wallLine: '#8a7652',
            door: '#7a5436',
            window: '#f2dc8c',
            tile: '#b9573c',
            tileLight: '#d4704f',
            tileLine: '#7e3826',
            chimneyBrick: '#9a5a44',
            chimneyCap: '#6e6c64',
            siloWall: '#cfc8ae',
            siloShade: '#b4ac92',
            siloLine: '#8e866c',
            siloCap: '#8f9690',
            siloCapLight: '#bcc2bc',
        },
    },
    dirt: { ...paddy.dirt, patchesPerMillion: 1.1 },
    yards: {
        basic: { kind: 'furrows', radius: 215, variants: 3 },
        premium: { kind: 'paving', radius: 195, contested: { radius: 215, sides: 8 } },
    },
    outside: {
        ...paddy.outside,
        paddy: { ...paddy.outside.paddy, water: 0.34, fallow: 0.3 },
        props: [
            { kind: 'tree', per1000Edge: 0.6, distance: [240, 340], scale: [0.9, 1.2] },
            { kind: 'stack', per1000Edge: 0.3, distance: [170, 270], scale: [0.9, 1.1] },
            { kind: 'cart', count: 1, distance: [200, 240], scale: [1, 1] },
            { kind: 'scarecrow', count: 2, distance: [240, 300], scale: [1, 1] },
        ],
    },
    landmarks: { kinds: ['cottage', 'silo'], offset: 260, inset: 400 },
};

// 바람 언덕: an airy highland. Bright minty grass, pale stone roads and yards, heather and bare rock in the
// pasture beyond the boundary, windmills and a hilltop beacon behind the bases.
const windHill = {
    ...paddy,
    palette: {
        ...paddy.palette,
        haze: '#d2e2da',
        grass: {
            base: '#9cc08a',
            light: '#aed49a',
            dark: '#86aa76',
            bladeLight: '#bfe0a8',
            bladeDark: '#6f9660',
        },
        dirt: { rim: '#bdb690', fill: '#d9d2ae', light: '#e6e0c0' },
        terrain: { ...paddy.palette.terrain, top: '#d4f0aa', low: '#5f8f78' },
        road: {
            shoulder: '#a8c68e',
            edge: '#bab69a',
            fill: '#d9d5c0',
            crown: '#e8e5d4',
            rut: '#b6b29a',
        },
        base: { rim: '#b4b098', fill: '#ddd8c4', light: '#ebe7d6', rut: '#b0ac94' },
        straw: {
            ...paddy.palette.straw,
            fill: '#dccf94',
            bandLight: '#e8dca6',
            bandDark: '#cbbd82',
        },
        paving: {
            ...paddy.palette.paving,
            rim: '#a8a894',
            fill: '#bcbcaa',
            stones: ['#d4d4c6', '#c8c8b8', '#dedecf'],
            stoneLight: '#eeeee2',
            light: '#f6f6ea',
            shade: '#4a4e44',
        },
        outside: {
            grass: '#a4c490',
            ring: '#9cbc88',
            // Stone walls between the pastures.
            bund: '#b4b49c',
            bundShade: '#8c8c78',
            // Heather.
            water: '#b79ac4',
            waterGlint: '#d8c4e2',
            waterRow: '#a283b2',
            green: '#9cc080',
            greenRow: '#86a86c',
            // Bare rock.
            fallow: '#b8b8a8',
            fallowRow: '#a4a494',
        },
        prop: {
            ...paddy.palette.prop,
            beaconWall: '#d8d4c2',
            beaconShade: '#b8b4a2',
            beaconLine: '#8e8a76',
            beaconRim: '#8c8a80',
            beaconFire: '#f0883c',
            beaconFireLight: '#ffd36a',
            sail: '#f6f0dc',
            wall: '#e4dcc0',
            pine: '#5a8a62',
            pineLight: '#78a878',
            pineLine: '#3e6446',
        },
    },
    dirt: { ...paddy.dirt, patchesPerMillion: 0.9 },
    blockers: { ...paddy.blockers, tools: [] },
    outside: {
        ...paddy.outside,
        paddy: { ...paddy.outside.paddy, water: 0.3, fallow: 0.22 },
        props: [
            { kind: 'tree', per1000Edge: 0.35, distance: [240, 340], scale: [0.8, 1] },
            { kind: 'pine', per1000Edge: 0.3, distance: [220, 320], scale: [0.8, 1] },
            { kind: 'reeds', per1000Edge: 0.4, distance: [150, 220], scale: [0.9, 1] },
        ],
    },
    landmarks: { kinds: ['windmill', 'beacon'], offset: 260, inset: 400 },
};

// 검은 곳간: ground the blight has taken. Cold ash-violet earth, dead crops, spore ponds and black barns; the
// plots still glow a sickly green-violet. The ground stays mid-dark and cool so bright soldiers stand out.
const blackGranary = {
    ...paddy,
    palette: {
        ...paddy.palette,
        haze: '#5a5568',
        grass: {
            base: '#6e6a7a',
            light: '#7c778a',
            dark: '#5e5a6a',
            bladeLight: '#8a8498',
            bladeDark: '#4c4858',
        },
        dirt: { rim: '#4e4a58', fill: '#58546a', light: '#686480' },
        terrain: {
            ...paddy.palette.terrain,
            top: '#86829a',
            low: '#3e3a4c',
            bank: '#4a465a',
            earth: ['#3e3a4c', '#524e64'],
            courses: [
                ['#5e5a70', '#68647c'],
                ['#7a768e', '#6e6a82'],
            ],
            stoneLight: '#b4b0c8',
            foot: '#1c1a28',
            parapet: '#58546a',
            caps: ['#8a869c', '#7c788e', '#9692a8'],
            capShade: '#1e1c2a',
            capLight: '#c4c0d8',
            shadow: '#1a1826',
            shade: '#181624',
            rampMouth: '#7a7690',
            rampLow: '#5e5a72',
            rampHigh: '#8a86a0',
            tread: '#4a4256',
            treadLight: '#8a82a0',
        },
        bank: {
            shadow: '#1e1c2a',
            side: '#46425a',
            top: '#58546e',
            lip: '#6a6684',
            light: '#8a86a2',
            foot: '#2c2a3a',
        },
        rock: {
            bed: '#4a4658',
            shadow: '#1c1a28',
            warm: ['#4a4658', '#9a96ac'],
            cool: ['#46465a', '#948fa8'],
            line: '#2c2a3a',
        },
        road: {
            shoulder: '#625e70',
            edge: '#7a7488',
            fill: '#8a859a',
            crown: '#9a96aa',
            rut: '#6e6a7e',
        },
        base: { rim: '#6a6678', fill: '#9a96a8', light: '#aaa6b8', rut: '#78748a' },
        furrows: {
            rim: '#403c4e',
            soil: '#4a465a',
            furrow: '#34303f',
            ridge: '#5a566c',
            sprout: '#7a9a52',
            sproutLight: '#c6a4f0',
            grain: '#8a7a56',
            grainLight: '#b6a478',
            cabbage: '#6e6a8a',
            cabbageLight: '#a49ec4',
            border: '#5a566a',
            borderLight: '#8a869c',
            light: '#7e7a94',
            mark: '#a48cd0',
        },
        paving: {
            ...paddy.palette.paving,
            rim: '#5e5a6e',
            fill: '#6e6a80',
            stones: ['#8c889c', '#807c92', '#9894a8'],
            stoneLight: '#b4b0c6',
            light: '#c4c0d6',
            shade: '#2c2a38',
        },
        water: {
            shore: '#5a5468',
            deep: '#5e4a7e',
            shallow: '#7c64a2',
            edge: '#c4aee6',
            ripple: '#d2c2f0',
            rippleShade: '#4a3a68',
            ford: '#8e7aae',
        },
        outside: {
            grass: '#605c70',
            ring: '#5a566a',
            bund: '#4a4658',
            bundShade: '#38354a',
            // Spore ponds.
            water: '#7a5ca0',
            waterGlint: '#c8a8f0',
            waterRow: '#654a88',
            green: '#5c6a52',
            greenRow: '#4a5642',
            // Ash.
            fallow: '#4e4a58',
            fallowRow: '#3e3a48',
        },
        prop: {
            ...paddy.palette.prop,
            shadow: '#1e1c2a',
            trunk: '#4a4254',
            trunkLine: '#2c2636',
            leaf: '#4c4660',
            leafLine: '#2e2a40',
            leafLight: '#625c7a',
            leafTop: '#726c8c',
            barnWall: '#3c3846',
            barnShade: '#2e2a38',
            barnLine: '#1c1a26',
            roof: '#2c2836',
            thatch: '#3a3446',
            thatchLight: '#4a4458',
            thatchLine: '#26222f',
            rail: '#5a566a',
            post: '#4a465a',
            wood: '#5c566a',
            woodDark: '#48445a',
            woodLine: '#2a2636',
            straw: '#6a6078',
            strawLight: '#807694',
            strawLine: '#403a50',
        },
    },
    yards: {
        basic: { kind: 'furrows', radius: 215, variants: 3 },
        premium: { kind: 'paving', radius: 195, contested: { radius: 215, sides: 8 } },
    },
    dirt: { ...paddy.dirt, patchesPerMillion: 1.2 },
    outside: {
        ...paddy.outside,
        paddy: { ...paddy.outside.paddy, water: 0.3, fallow: 0.4 },
        props: [
            { kind: 'tree', per1000Edge: 0.6, distance: [240, 340], scale: [0.9, 1.2] },
            { kind: 'stack', per1000Edge: 0.2, distance: [170, 270], scale: [0.9, 1] },
            { kind: 'scarecrow', count: 2, distance: [240, 300], scale: [1, 1] },
        ],
    },
    landmarks: { kinds: ['barn', 'barn'], offset: 260, inset: 400 },
};

export const MAP_THEMES = Object.freeze({
    paddy,
    'nut-forest': nutForest,
    'field-town': fieldTown,
    'wind-hill': windHill,
    'black-granary': blackGranary,
});
