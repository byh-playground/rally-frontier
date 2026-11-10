// Approved bean artwork is assembled once into a shared texture; poses are evaluated by GameKit.
import { GRAIN_RIG as RICE_RIG } from './grain-rig.js';
const root = new URL('../../assets/sprites/beans/', import.meta.url);
const slots = Object.freeze({
    'pea-body': [1, 1, 290, 270],
    'red-body': [293, 1, 220, 265],
    'pea-arm-l': [515, 1, 68, 70],
    'pea-arm-r': [585, 1, 68, 70],
    'red-arm-l': [655, 1, 68, 70],
    'red-arm-r': [725, 1, 68, 70],
    'pea-leg-l': [515, 73, 58, 70],
    'pea-leg-r': [575, 73, 58, 70],
    'red-leg-l': [635, 73, 58, 70],
    'red-leg-r': [695, 73, 58, 70],
    'face-neutral': [1, 280, 148, 72],
    'face-happy': [151, 280, 148, 72],
    'face-hurt': [301, 280, 148, 72],
    'face-angry': [451, 280, 148, 72],
});
const cache = new WeakMap();
export async function loadBeanSpriteCanvases() {
    const response = await fetch(new URL('manifest.json', root), { cache: 'no-store' });
    if (!response.ok) throw new Error('콩·팥 스프라이트 목록을 불러오지 못했습니다.');
    const manifest = await response.json();
    const expected = Object.keys(slots)
        .map((name) => name + '.png')
        .sort();
    if (
        manifest?.schemaVersion !== 1 ||
        !manifest.assets ||
        JSON.stringify(Object.keys(manifest.assets).sort()) !== JSON.stringify(expected)
    )
        throw new Error('콩·팥 스프라이트 목록이 올바르지 않습니다.');
    const images = await Promise.all(
        Object.keys(slots).map(async (name) => {
            const file = name + '.png',
                entry = manifest.assets[file];
            if (
                !entry ||
                !Number.isSafeInteger(entry.bytes) ||
                entry.bytes < 1 ||
                entry.bytes > 524288 ||
                !/^[a-f0-9]{64}$/.test(entry.sha256 || '')
            )
                throw new Error('콩·팥 스프라이트 정보가 잘못되었습니다: ' + name);
            const result = await fetch(new URL(file, root), { cache: 'no-cache' });
            if (!result.ok) throw new Error('콩·팥 스프라이트를 불러오지 못했습니다: ' + name);
            const bytes = await result.arrayBuffer();
            const hash = Array.from(
                new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
                (b) => b.toString(16).padStart(2, '0'),
            ).join('');
            if (bytes.byteLength !== entry.bytes || hash !== entry.sha256)
                throw new Error('콩·팥 스프라이트 무결성 오류: ' + name);
            const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
            try {
                const image = new Image();
                image.src = url;
                await image.decode();
                return [name, image];
            } finally {
                URL.revokeObjectURL(url);
            }
        }),
    );
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 384;
    const context = canvas.getContext('2d');
    for (const [name, image] of images) context.drawImage(image, ...slots[name]);
    return canvas;
}
// `bean` is the unit's own placement on the shared sheet: { prefix, body, legY, face }.
function pieces(bean) {
    const { prefix, body, legY: ly, face } = bean;
    return {
        body: { name: prefix + '-body', rect: body, part: 0 },
        legL: { name: prefix + '-leg-l', rect: [-65, ly - 35, 58, 70], part: 1 },
        legR: { name: prefix + '-leg-r', rect: [7, ly - 35, 58, 70], part: 2 },
        armL: { name: prefix + '-arm-l', rect: [-146, -3, 68, 70], part: 3 },
        armR: { name: prefix + '-arm-r', rect: [78, -3, 68, 70], part: 5 },
        neutral: { name: 'face-neutral', rect: face, part: 7 },
        attack: { name: 'face-angry', rect: face, part: 7 },
        hurt: { name: 'face-hurt', rect: face, part: 7 },
    };
}
export function beanSpritePortrait(canvas, bean, width) {
    const p = pieces(bean),
        output = document.createElement('canvas'),
        scale = width / 320;
    output.width = width;
    output.height = Math.round(360 * scale);
    const c = output.getContext('2d');
    c.setTransform(scale, 0, 0, scale, width / 2, 200 * scale);
    for (const name of ['legL', 'legR', 'armL', 'armR', 'body', 'neutral']) {
        const item = p[name];
        c.drawImage(canvas, ...slots[item.name], ...item.rect);
    }
    return output.toDataURL('image/png');
}
function acquire(context, canvas) {
    let entry = cache.get(context);
    if (entry) {
        if (entry.canvas !== canvas) throw new Error('콩·팥 공유 아틀라스가 일치하지 않습니다.');
        entry.refs++;
        return entry;
    }
    const region = context.device.textureAtlas.allocate(canvas.width, canvas.height, {
        filter: 'linear',
    });
    try {
        context.device.textureAtlas.upload(region, canvas);
    } catch (error) {
        context.device.textureAtlas.release(region);
        throw error;
    }
    entry = { canvas, region, refs: 1 };
    cache.set(context, entry);
    return entry;
}
export class BeanSpriteRenderer {
    constructor(context, canvas, gamekit, bean) {
        this.context = context;
        this.mesh = context.acquireMeshRenderer();
        this.actors = new Set();
        this.shared = acquire(context, canvas);
        this.atlas = { region: this.shared.region };
        try {
            this.source = this.mesh.createPoseSource(gamekit.compilePoseChannels(RICE_RIG));
        } catch (error) {
            this.release();
            throw error;
        }
        this.base = RICE_RIG.parts.map(() => ({
            x: 0,
            y: 0,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            opacity: 1,
        }));
        this.visible = RICE_RIG.parts.map(() => true);
        this.morph = [0, 0];
        this.disposed = false;
        const all = pieces(bean),
            region = this.atlas.region,
            atlas = region.atlas;
        const data = (names) => {
            const uv = [],
                local = [],
                parts = [];
            for (const name of names) {
                const item = all[name],
                    [x, y, w, h] = slots[item.name];
                uv.push(
                    (region.x + x) / atlas.width,
                    (region.y + y) / atlas.height,
                    w / atlas.width,
                    h / atlas.height,
                );
                local.push(...item.rect);
                parts.push(item.part);
            }
            return {
                uvRects: Float32Array.from(uv),
                localRects: Float32Array.from(local),
                parts: Float32Array.from(parts),
            };
        };
        this.atlas.back = data(['legL', 'legR', 'armL', 'armR', 'body']);
        this.atlas.front = {
            neutral: data(['neutral']),
            attack: data(['attack']),
            hurt: data(['hurt']),
        };
        context.onDispose(() => this.dispose());
    }
    createActor() {
        const owner = this,
            instance = this.mesh.createPoseInstance(this.source);
        const actor = {
            currentClip: 'idle',
            startedAt: 0,
            elapsed: 0,
            pose: null,
            disposed: false,
            play(clip) {
                this.currentClip = clip;
                this.startedAt = clip === 'idle' || clip === 'walk' ? 0 : null;
                return this;
            },
            seek(time) {
                if (this.startedAt === null)
                    this.startedAt = time - (this.currentClip === 'fire' ? 605 : 0);
                this.elapsed = Math.max(0, time - this.startedAt);
                return this;
            },
            preparePose() {
                this.pose = owner.mesh.preparePose(instance, {
                    clipName: this.currentClip,
                    elapsedMs: this.elapsed,
                    basePoses: owner.base,
                    visible: owner.visible,
                    morph: owner.morph,
                });
                if (!this.pose)
                    throw new Error('콩·팥 스프라이트에 GPU 포즈를 사용할 수 없습니다.');
                return this.pose;
            },
            dispose() {
                if (this.disposed) return false;
                this.disposed = true;
                owner.actors.delete(this);
                return owner.mesh.deletePoseInstance(instance);
            },
        };
        this.actors.add(actor);
        return actor;
    }
    draw(data, actor, matrix, depth, threshold = 0) {
        const c = this.context;
        c.depth = depth;
        c.drawQuads({
            layer: this.atlas.region.layer,
            filter: this.atlas.region.filter,
            ...data,
            pose: actor.pose,
            matrix,
            depthWriteAlphaThreshold: threshold,
        });
    }
    drawBody(actor, matrix, depth) {
        this.draw(this.atlas.back, actor, matrix, depth, 0.05);
    }
    drawFace(actor, matrix, depth, face) {
        this.draw(this.atlas.front[face] || this.atlas.front.neutral, actor, matrix, depth);
    }
    release() {
        if (--this.shared.refs === 0) {
            this.context.device.textureAtlas.release(this.shared.region);
            cache.delete(this.context);
        }
    }
    dispose() {
        if (this.disposed) return false;
        this.disposed = true;
        for (const actor of [...this.actors]) actor.dispose();
        this.mesh.deletePoseSource(this.source);
        this.release();
        return true;
    }
}
