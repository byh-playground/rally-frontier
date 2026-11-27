// The launch shells painted as their own art: the crop bundled, wrapped or netted, never the soldier itself.
// One atlas image (assets/shells/atlas.png) holds them all. Every picture points its front to +x, and the shell is
// drawn nose first along its flight (and broken apart where it lands, like any launch shell).
import { fetchAsset, requireAsset } from '../core/required-asset.js';

const ROOT = new URL('../../assets/shells/', import.meta.url);
const FILE = 'atlas.png';
// Each shell's rectangle [x, y, width, height] in the atlas. Heroes' shells are drawn larger.
const SLOTS = Object.freeze({
    rice: [3, 21, 250, 149],
    pea: [259, 33, 250, 126],
    redbean: [515, 33, 250, 125],
    chili: [771, 27, 250, 138],
    walnut: [1027, 15, 250, 161],
    coconut: [3, 213, 250, 150],
    potato: [259, 212, 250, 152],
    buckwheat: [515, 221, 250, 134],
    sesame: [771, 220, 250, 136],
    cotton: [1027, 198, 250, 180],
    dandelion: [3, 398, 250, 164],
    'sticky-rice': [259, 412, 250, 136],
    peanut: [515, 394, 250, 172],
    acorn: [771, 408, 250, 143],
    watermelon: [1027, 389, 250, 182],
    banana: [3, 586, 250, 172],
    grape: [259, 597, 250, 149],
});
// A shell's width in launch shell lengths (the length every shell is drawn by).
const WIDTH = 1.1,
    HERO_WIDTH = 1.45;
const HEROES = Object.freeze(['watermelon', 'banana', 'grape']);

export async function loadPaintedShellImage() {
    const manifest = new URL('manifest.json', ROOT);
    const entry = await requireAsset(manifest, async () => {
        const response = await fetchAsset(manifest, { cache: 'no-store' });
        const entry = (await response.json())?.assets?.[FILE];
        if (!Number.isSafeInteger(entry?.bytes) || !/^[a-f0-9]{64}$/.test(entry.sha256 || ''))
            throw new Error('포탄 그림 목록이 올바르지 않습니다.');
        return entry;
    });
    const atlas = new URL(FILE, ROOT);
    return requireAsset(atlas, async () => {
        const response = await fetchAsset(atlas, { cache: 'no-cache' });
        const bytes = await response.arrayBuffer();
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) =>
            v.toString(16).padStart(2, '0'),
        ).join('');
        if (bytes.byteLength !== entry.bytes || hash !== entry.sha256)
            throw new Error('포탄 그림 무결성 오류');
        const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
        try {
            const image = new Image();
            image.src = url;
            await image.decode();
            return image;
        } finally {
            URL.revokeObjectURL(url);
        }
    });
}

export class PaintedShells {
    static has(type) {
        return Object.hasOwn(SLOTS, type);
    }
    static get types() {
        return Object.keys(SLOTS);
    }

    constructor(context, image) {
        this.context = context;
        const region = context.device.textureAtlas.allocate(image.width, image.height, {
            filter: 'linear',
        });
        try {
            context.device.textureAtlas.upload(region, image);
        } catch (error) {
            context.device.textureAtlas.release(region);
            throw error;
        }
        this.region = region;
        const { width, height } = region.atlas;
        // Each shell as a launch shell record (main.js launchAmmoRecord): its matrix unit is the shell length.
        this.records = new Map(
            Object.entries(SLOTS).map(([type, [x, y, w, h]]) => {
                const drawn = HEROES.includes(type) ? HERO_WIDTH : WIDTH,
                    tall = (drawn * h) / w;
                const quad = {
                    uvRects: Float32Array.of(
                        (region.x + x) / width,
                        (region.y + y) / height,
                        w / width,
                        h / height,
                    ),
                    localRects: Float32Array.of(-drawn / 2, -tall / 2, drawn, tall),
                };
                return [
                    type,
                    Object.freeze({
                        shell: Object.freeze({ draw: 'drawAmmo', depthTest: true }),
                        renderer: { drawAmmo: (matrix, depth) => this.draw(quad, matrix, depth) },
                    }),
                ];
            }),
        );
        context.onDispose(() => this.dispose());
    }

    record(type) {
        return this.records.get(type);
    }

    draw(quad, matrix, depth) {
        this.context.depth = depth;
        this.context.drawQuads({
            layer: this.region.layer,
            filter: this.region.filter,
            ...quad,
            matrix,
        });
    }

    dispose() {
        if (this.disposed) return false;
        this.disposed = true;
        this.context.device.textureAtlas.release(this.region);
        return true;
    }
}
