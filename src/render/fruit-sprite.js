import { createHeroBasicAttackClip } from './hero-basic-motion.js';

const ROOT = new URL('../../assets/sprites/', import.meta.url);
const artwork = new WeakMap();
const THROW_STRIKE = Object.freeze({ x: 23, y: -59, rotation: -0.2 });

const key = (timeMs, parts = {}) => ({ timeMs, parts, easing: 'inOutSine' });
const clip = (durationMs, loop, keyframes) => ({ durationMs, loop, keyframes });

function rotated(x, y, angle) {
    const cos = Math.cos(angle),
        sin = Math.sin(angle);
    return [x * cos - y * sin, x * sin + y * cos];
}

function bananaLayers(data) {
    const { ground, parts, rest, restAngles, mirrored } = data;
    const shapes = {
        farBoot: 'boot',
        nearBoot: 'boot',
        farArm: 'arm',
        nearArm: 'arm',
        face: 'neutral',
        heldBoomerang: 'boomerang',
        body: 'body',
    };
    const gripOffset = parts.arm.grip.map((value, index) => value - parts.arm.pivot[index]);
    return data.layers.map((id) => ({
        id,
        part: shapes[id],
        parent: id === 'heldBoomerang' ? 'nearArm' : null,
        position: (id === 'heldBoomerang'
            ? rest.nearArm.map((v, i) => v + gripOffset[i])
            : rest[id]
        ).map((v, i) => v - ground[i]),
        rotation: restAngles[id] ?? 0,
        mirror: mirrored.includes(id),
        pivot: id === 'heldBoomerang' ? parts.boomerang.grip : undefined,
    }));
}

function fruitRig(layers, armId) {
    const feet = layers.filter(({ part }) => part === 'boot' || part === 'foot');
    const torso = layers.filter((layer) => !layer.parent && !feet.includes(layer));
    const walkPose = (swing) => {
        const pose = {};
        const lean = swing * 0.11;
        for (const [index, { id }] of feet.entries()) {
            const side = index === 0 ? -1 : 1;
            const lifted = swing === side;
            pose[id] = {
                x: lifted ? side * 8 : 0,
                y: lifted ? -24 : 0,
                rotation: lifted ? side * 0.32 : 0,
            };
        }
        for (const { id, part, position } of torso) {
            const arm = part === 'arm' || part === 'hand';
            const armSide = Math.sign(position[0]);
            // Rotate all torso layers around the same ground point so the face and held gear follow.
            const [x, y] = rotated(...position, lean);
            pose[id] = {
                x: x - position[0] + swing * 9,
                y: y - position[1] + (swing ? -15 : 5) + (arm ? swing * armSide * 6 : 0),
                rotation: lean - (arm ? swing * 0.16 : 0),
            };
        }
        return pose;
    };
    const planted = walkPose(0);
    return {
        parts: layers.map(({ id, parent, position }) => ({
            id,
            parent: parent ?? null,
            pivot: position,
        })),
        clips: {
            idle: clip(1200, 'repeat', [key(0), key(1200)]),
            walk: clip(600, 'repeat', [
                key(0, planted),
                key(150, walkPose(-1)),
                key(300, planted),
                key(450, walkPose(1)),
                key(600, planted),
            ]),
            fire: createHeroBasicAttackClip({
                windup: { [armId]: { x: -12, y: -16, rotation: -0.9 } },
                strike: { [armId]: THROW_STRIKE },
                followThrough: { [armId]: { x: 10, y: -23, rotation: 0.2 } },
            }),
            hit: clip(295, 'once', [key(0), key(295)]),
        },
    };
}

async function readAsset(root, name) {
    const response = await fetch(new URL(name, root), { cache: 'no-cache' });
    if (!response.ok) throw new Error('과일 영웅 스프라이트를 불러오지 못했습니다: ' + name);
    return response;
}

export async function loadFruitSpriteCanvas(type) {
    const root = new URL(type + '/', ROOT);
    const rigFile = type === 'banana' ? 'rig.json' : 'layout.json';
    const [manifest, layout, bytes] = await Promise.all([
        readAsset(root, 'manifest.json').then((r) => r.json()),
        readAsset(root, rigFile).then((r) => r.json()),
        readAsset(root, 'parts.svg').then((r) => r.arrayBuffer()),
    ]);
    const spec = manifest?.assets?.['parts.svg'];
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) =>
        value.toString(16).padStart(2, '0'),
    ).join('');
    if (
        manifest?.schemaVersion !== 1 ||
        !spec ||
        spec.bytes !== bytes.byteLength ||
        spec.sha256 !== hash
    )
        throw new Error('과일 영웅 SVG 무결성 오류: ' + type);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
    try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        if (canvas.width !== layout.sheet[0] || canvas.height !== layout.sheet[1])
            throw new Error('과일 영웅 스프라이트 시트 크기가 다릅니다: ' + type);
        const layers = type === 'banana' ? bananaLayers(layout) : layout.standing;
        for (const {
            slot: [x, y, width, height],
        } of Object.values(layout.parts)) {
            if (
                x < 0 ||
                y < 0 ||
                width <= 0 ||
                height <= 0 ||
                x + width > canvas.width ||
                y + height > canvas.height
            )
                throw new Error('과일 영웅 스프라이트 파츠가 시트를 벗어났습니다: ' + type);
        }
        canvas.getContext('2d').drawImage(image, 0, 0);
        artwork.set(canvas, { type, layout, layers });
        return canvas;
    } finally {
        URL.revokeObjectURL(url);
    }
}

export function fruitSpritePortrait(source, width) {
    const { layout, layers } = artwork.get(source);
    const canvas = document.createElement('canvas'),
        scale = width / 320;
    canvas.width = width;
    canvas.height = Math.round(265 * scale);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, width / 2, canvas.height - 6 * scale);
    for (const { part, parent, pivot, position, rotation, mirror } of layers) {
        const data = layout.parts[part],
            [px, py] = pivot ?? data.pivot;
        ctx.save();
        if (parent) {
            const arm = layers.find(({ id }) => id === parent);
            ctx.translate(...arm.position);
            ctx.rotate(arm.rotation);
            ctx.translate(position[0] - arm.position[0], position[1] - arm.position[1]);
        } else ctx.translate(...position);
        ctx.rotate(rotation ?? 0);
        if (mirror) ctx.scale(-1, 1);
        ctx.drawImage(source, ...data.slot, -px, -py, data.slot[2], data.slot[3]);
        ctx.restore();
    }
    return canvas.toDataURL('image/png');
}

export class FruitSpriteRenderer {
    constructor(context, canvas, gamekit) {
        this.context = context;
        this.mesh = context.acquireMeshRenderer();
        this.actors = new Set();
        const { type, layout, layers } = artwork.get(canvas);
        this.layout = layout;
        this.layers = layers;
        this.rig = fruitRig(layers, type === 'banana' ? 'nearArm' : 'rightHand');
        this.heldIndex = layers.findIndex(({ id }) => id === 'heldBoomerang');
        if (this.heldIndex >= 0) {
            const held = layers[this.heldIndex],
                arm = layers.find(({ id }) => id === held.parent),
                weapon = layout.parts[held.part],
                [pivotX, pivotY] = rotated(
                    weapon.pivot[0] - weapon.grip[0],
                    weapon.pivot[1] - weapon.grip[1],
                    held.rotation,
                ),
                x = held.position[0] - arm.position[0] + pivotX,
                y = held.position[1] - arm.position[1] + pivotY;
            this.weaponRest = rotated(x, y, arm.rotation).map((v, i) => v + arm.position[i]);
            this.weaponRelease = rotated(x, y, arm.rotation + THROW_STRIKE.rotation).map(
                (v, i) => v + arm.position[i] + (i === 0 ? THROW_STRIKE.x : THROW_STRIKE.y),
            );
        }
        const region = context.device.textureAtlas.allocate(canvas.width, canvas.height, {
            filter: 'linear',
        });
        try {
            context.device.textureAtlas.upload(region, canvas);
            this.source = this.mesh.createPoseSource(gamekit.compilePoseChannels(this.rig));
        } catch (error) {
            context.device.textureAtlas.release(region);
            throw error;
        }
        this.region = region;
        const build = (pieces, posed = true) => {
            const uv = [],
                local = [],
                parts = [];
            for (const {
                slot: [x, y, width, height],
                rect,
                index,
            } of pieces) {
                uv.push(
                    (region.x + x) / region.atlas.width,
                    (region.y + y) / region.atlas.height,
                    width / region.atlas.width,
                    height / region.atlas.height,
                );
                local.push(...rect);
                parts.push(index);
            }
            return {
                uvRects: Float32Array.from(uv),
                localRects: Float32Array.from(local),
                ...(posed ? { parts: Float32Array.from(parts) } : {}),
            };
        };
        const pieces = layers.map(({ position: [x, y], part, pivot }, index) => {
            const data = layout.parts[part];
            const [px, py] = pivot ?? data.pivot;
            const [, , width, height] = data.slot;
            return { slot: data.slot, rect: [x - px, y - py, width, height], index };
        });
        const faceIndex = layers.findIndex(({ id }) => id === 'face');
        this.body = build(pieces.slice(0, faceIndex));
        this.front = Object.fromEntries(
            ['neutral', 'attack', 'hurt'].map((name) => {
                const face = layout.parts[name];
                const [x, y] = layers[faceIndex].position;
                const [px, py] = face.pivot;
                const [, , width, height] = face.slot;
                const head = {
                    slot: face.slot,
                    rect: [x - px, y - py, width, height],
                    index: faceIndex,
                };
                return [name, build([head, ...pieces.slice(faceIndex + 1)])];
            }),
        );
        const loosePart = (name, pivot = layout.parts[name].pivot) => {
            const { slot } = layout.parts[name];
            const [, , width, height] = slot;
            return build(
                [{ slot, rect: [-pivot[0] / width, -pivot[1] / width, 1, height / width] }],
                false,
            );
        };
        this.ammo = loosePart(layout.cannonAmmo.part, layout.cannonAmmo.pivot);
        this.combatAmmo = loosePart(type === 'banana' ? 'boomerang' : 'berry');
        context.onDispose(() => this.dispose());
    }

    createActor() {
        const owner = this;
        const instance = this.mesh.createPoseInstance(this.source);
        const basePoses = this.layers.map(({ rotation, mirror }) => ({
            x: 0,
            y: 0,
            rotation: rotation ?? 0,
            scaleX: mirror ? -1 : 1,
            scaleY: 1,
            opacity: 1,
        }));
        const visible = this.layers.map(() => true);
        const actor = {
            currentClip: 'idle',
            startedAt: 0,
            elapsed: 0,
            pose: null,
            weaponAway: false,
            disposed: false,
            play(name) {
                this.currentClip = name in owner.rig.clips ? name : 'idle';
                this.startedAt = name === 'idle' || name === 'walk' ? 0 : null;
                return this;
            },
            seek(time) {
                if (this.startedAt === null) this.startedAt = time;
                return this.seekElapsed(time - this.startedAt);
            },
            seekElapsed(elapsed) {
                this.elapsed = Math.max(0, elapsed);
                return this;
            },
            preparePose() {
                if (owner.heldIndex >= 0) visible[owner.heldIndex] = !this.weaponAway;
                this.pose = owner.mesh.preparePose(instance, {
                    clipName: this.currentClip,
                    elapsedMs: this.elapsed,
                    basePoses,
                    visible,
                    morph: [0, 0],
                });
                if (!this.pose) throw new Error('과일 영웅의 GPU 포즈를 준비하지 못했습니다.');
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

    draw(data, matrix, depth, actor = null, depthWriteAlphaThreshold = 0) {
        this.context.depth = depth;
        this.context.drawQuads({
            layer: this.region.layer,
            filter: this.region.filter,
            ...data,
            ...(actor ? { pose: actor.pose } : {}),
            matrix,
            depthWriteAlphaThreshold,
        });
    }

    drawBody(actor, matrix, depth) {
        this.draw(this.body, matrix, depth, actor, 0.05);
    }

    drawFace(actor, matrix, depth, face) {
        this.draw(this.front[face] || this.front.neutral, matrix, depth, actor);
    }

    drawAmmo(matrix, depth) {
        this.draw(this.ammo, matrix, depth);
    }

    drawCombatAmmo(matrix, depth) {
        this.draw(this.combatAmmo, matrix, depth);
    }

    weaponSocket(matrix, releasing) {
        const [x, y] = releasing ? this.weaponRelease : this.weaponRest;
        return [
            matrix[0] * x + matrix[2] * y + matrix[4],
            matrix[1] * x + matrix[3] * y + matrix[5],
        ];
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        for (const actor of this.actors) actor.dispose();
        this.mesh.deletePoseSource(this.source);
        this.context.device.textureAtlas.release(this.region);
    }
}
