// Map themes: how a map looks. A map definition names one theme (`theme: 'paddy'`) and nothing else about its looks;
// the ground, roads, yards, boundary, outside scenery, rocks, decoration and landmarks are all derived from the map's
// own geometry by these rules (src/render/map-look-layout.js). A theme is a palette plus rule numbers: no coordinates.
// Lengths are world units, `per1000Edge` counts are per 1000 units of map boundary, `perMillion` per 1,000,000 units²
// of map area, and shares/chances are 0..1.
export const MAP_THEMES = Object.freeze({
    // 논두렁: a grass field with dirt roads and straw yards, banked off from flooded rice paddies.
    paddy: {
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
            // Raised ground (terrain layers and ramps): the top of a plateau, a depression's floor, a cliff face
            // (lit by its direction) and a ramp from its foot to its head.
            terrain: {
                lowGround: '#8fa66a',
                highGround: '#9aab66',
                cliff: '#74805a',
                rampLow: '#b0a070',
                rampHigh: '#b8ad78',
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
        },
        grass: { blotchesPerMillion: 3.2, blotchRadius: [180, 560], bladeSpacing: 110 },
        dirt: {
            // Trodden, dried ground beside the roads: small, light and crisp-edged, clear of the bases.
            patchesPerMillion: 1.4,
            spacing: 380,
            laneSpread: 700,
            radius: [62, 128],
            baseClearance: 300,
            yardClearance: 130,
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
        // A blocker is filled with a pile of stones that never leaves its polygon.
        blockers: {
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
    },
});
