import { HeroDeployment } from './hero-deployment.js';
import { FP } from '../core/config.js';
import { LaunchRules } from './launch-rules.js';
import { LaunchImpactRules } from '../definitions/launch-impact-rules.js';
import { UnitResultStats } from './unit-result-stats.js';
import { HashUtil } from './map-generation.js';
import { BuildingDefinition } from '../definitions/buildings.js';
import { TerrainSurfaceAtlas } from './terrain.js';

// The simulation owns impulses, release queues and projectile contacts. Rendering only observes these records.
class LaunchImpact {
    static start(
        sim,
        u,
        {
            kind = 'knockback',
            dx,
            dy,
            speed,
            lift = 0,
            sourceId,
            originX,
            originY,
            initialHeightFP = 0,
            initialVzFP = null,
        },
    ) {
        if (!u?.alive) return;
        let length = Math.hypot(dx, dy);
        if (length < 0.001) {
            const angle = ((HashUtil.hash(u.id + '|' + sourceId) % 8) * Math.PI) / 4;
            dx = Math.cos(angle);
            dy = Math.sin(angle);
            length = 1;
        }
        const mass = sim.mass(u),
            reference = LaunchImpactRules.referenceMass;
        sim.navigation.motion.applyImpulse(
            u,
            {
                x: (dx / length) * speed * reference,
                y: (dy / length) * speed * reference,
                z: lift * reference + (initialVzFP == null ? 0 : (initialVzFP / FP) * mass),
            },
            { kind, sourceId, originX, originY, initialHeightFP },
        );
    }
    static update(sim) {
        for (const u of sim.units) sim.navigation.motion.integrateImpulse(u);
    }
    static distanceToBody(sim, entity, x, y, impactHeightFP, isBuilding = false) {
        const radius = isBuilding
            ? BuildingDefinition.get(entity.type)?.size || 30
            : sim.unitRadius(entity.type);
        const bottom =
            sim.world.terrain.surfaces.heightAt(entity.x, entity.y) +
            (isBuilding ? 0 : (entity.impactMotion?.heightFP || 0) / FP);
        const top = bottom + 2 * radius,
            z = impactHeightFP / FP,
            verticalGap = Math.max(bottom - z, z - top, 0);
        const planar = Math.hypot(entity.x - x, entity.y - y);
        const surfaceDistance = Math.hypot(Math.max(0, planar - radius), verticalGap);
        return {
            surfaceDistance,
            falloffDistance: Math.hypot(
                isBuilding ? Math.max(0, planar - radius) : planar,
                verticalGap,
            ),
        };
    }
    static blast(sim, p, x, y, radius, impactHeightFP) {
        this.radialImpulse(sim, { side: p.side, sourceId: p.id, x, y, radius, impactHeightFP });
    }
    static radialImpulse(sim, { side, sourceId, x, y, radius, impactHeightFP, scale = 1 }) {
        sim.withNearbyUnits(x, y, radius + sim.maxUnitRadius, 1 - side, (indices) => {
            for (const index of indices) {
                const u = sim.units[index];
                if (!u?.alive || u.side !== 1 - side) continue;
                const dx = u.x - x,
                    dy = u.y - y,
                    body = this.distanceToBody(sim, u, x, y, impactHeightFP),
                    distance = body.falloffDistance,
                    reach = radius + sim.unitRadius(u.type);
                if (body.surfaceDistance > radius) continue;
                const strength = Math.max(0.1, 1 - distance / reach);
                this.start(sim, u, {
                    dx,
                    dy,
                    speed: LaunchImpactRules.knockbackSpeed * scale * (0.25 + 0.75 * strength),
                    lift: strength >= 0.5 ? LaunchImpactRules.knockbackLift * scale * strength : 0,
                    sourceId,
                    originX: x,
                    originY: y,
                });
            }
        });
    }
    static deploymentOrigin(sim, p, x, y) {
        const dx = p.lockedAimX - p.launchX,
            dy = p.lockedAimY - p.launchY,
            length = Math.hypot(dx, dy);
        if (!length) return { x, y };
        const ux = dx / length,
            uy = dy / length;
        let back = 0;
        // Friendly buildings do not intercept a shell, but their footprints still block release.
        // Backtrack only the release point; the impact can still be on terrain or an enemy body.
        for (const index of sim.nearbyBuildingIndices(x, y, sim.maxBuildingRadius)) {
            const building = sim.buildings[index];
            if (!building || building.alive === false) continue;
            const radius = BuildingDefinition.get(building.type)?.size || 30;
            const offsetX = x - building.x,
                offsetY = y - building.y,
                offsetSquared = offsetX * offsetX + offsetY * offsetY;
            if (offsetSquared > radius * radius) continue;

            const along = offsetX * ux + offsetY * uy,
                outside = radius + 2 / FP;
            back = Math.max(
                back,
                along + Math.sqrt(along * along + outside * outside - offsetSquared),
            );
        }
        if (!back) return { x, y };
        return {
            x: Math.round((x - ux * back) * FP) / FP,
            y: Math.round((y - uy * back) * FP) / FP,
        };
    }
    static enqueue(sim, p, x, y, impactHeightFP = null, { emergencyDrop = false } = {}) {
        const { type, count } = p.payload;
        let holdPointId = null,
            best = LaunchRules.captureHoldRadius;
        for (const cp of sim.capturePoints) {
            if (cp.owner != null || !cp.enabled) continue;
            const d = Math.hypot(cp.x - x, cp.y - y);
            if (d < best) {
                best = d;
                holdPointId = cp.id;
            }
        }
        const origin = this.deploymentOrigin(sim, p, x, y);
        const groundFP = Math.round(sim.world.terrain.surfaces.heightAt(origin.x, origin.y) * FP);
        const heightFP = Math.max(0, (impactHeightFP ?? groundFP) - groundFP);
        const direction =
            LaunchRules.grain(type).land === 'transverse'
                ? { x: p.lockedAimX - p.launchX, y: p.lockedAimY - p.launchY }
                : null;
        const line = direction && (Math.hypot(direction.x, direction.y) || 1);
        sim.launchDeployments.push({
            projectileId: p.id,
            side: p.side,
            type,
            count,
            index: 0,
            ...origin,
            ...(direction ? { dirX: direction.x / line, dirY: direction.y / line } : {}),
            holdPointId,
            nextTick: sim.tick,
            heightFP,
            ...(emergencyDrop ? { emergencyDropHeightFP: heightFP } : {}),
            vzFP: 0,
            lastPhysicsTick: sim.tick,
        });
    }
    static applyEmergencyDropDamage(group, unit) {
        if (group.emergencyDropHeightFP == null) return undefined;
        const { safeHeight, maxDamageHeight, maxDamageRatio } = LaunchImpactRules.interceptFall;
        const dropHeight = group.emergencyDropHeightFP / FP;
        const progress = Math.max(
            0,
            Math.min(1, (dropHeight - safeHeight) / (maxDamageHeight - safeHeight)),
        );
        const damage = Math.floor(unit.hp * progress * maxDamageRatio);
        unit.hp -= damage;
        return damage;
    }
    // Reserve every spot in the landing area before creating any units. A failed
    // search leaves the entire payload intact for a later retry.
    static deployTogether(sim, group, grain) {
        const origin = { x: group.x, y: group.y },
            initialRadius = grain.splash + 60,
            attempt = group.deployAttempt || 0,
            absoluteHeight =
                sim.world.terrain.surfaces.heightAt(group.x, group.y) + group.heightFP / FP;
        const findSpots = (baseRadius, maxRadius) => {
            const spots = [];
            const canRelease = (x, y) => {
                const fx = Math.round(x * FP) / FP,
                    fy = Math.round(y * FP) / FP;
                return (
                    sim.world.terrain.surfaces.heightAt(fx, fy) <= absoluteHeight &&
                    sim.pointClearForUnit(group.type, fx, fy, null, spots) &&
                    this.releasePathClear(sim, group, fx, fy, absoluteHeight)
                );
            };
            for (let i = 0; i < group.count; i++) {
                const anchor =
                    grain.land === 'transverse'
                        ? LaunchRules.lineDeploymentPosition(group, i, grain.spacing)
                        : origin;
                const spot =
                    anchor !== origin && canRelease(anchor.x, anchor.y)
                        ? anchor
                        : sim.findOpenSpawnAround(anchor, group.type, {
                              baseRadius,
                              maxRadius,
                              angleSlots: 12,
                              radialStep: 10,
                              seedKey:
                                  sim.seed +
                                  '|' +
                                  group.projectileId +
                                  '|release|' +
                                  attempt +
                                  '|' +
                                  i,
                              reserved: spots,
                              maxElevation: absoluteHeight,
                              canReach: canRelease,
                          });
                if (!spot) return null;
                spots.push({
                    x: Math.round(spot.x * FP) / FP,
                    y: Math.round(spot.y * FP) / FP,
                    type: group.type,
                });
            }
            return spots;
        };
        const spots = findSpots(0, initialRadius);
        if (!spots) {
            group.deployAttempt = attempt + 1;
            return false;
        }
        const keepFormation = grain.land === 'compact' || grain.land === 'transverse';
        const radii = spots.map((spot) => Math.hypot(spot.x - group.x, spot.y - group.y)),
            closest = Math.min(...radii),
            radiusSpan = Math.max(...radii) - closest;
        for (let i = 0; i < spots.length; i++) {
            const spot = spots[i],
                u = sim.spawnUnit(group.side, group.type, spot.x, spot.y);
            UnitResultStats.add(sim.unitResultStats, group.side, group.type, 'deployed');
            if (group.holdPointId) u.launchHoldPointId = group.holdPointId;
            const fallDamage = this.applyEmergencyDropDamage(group, u);
            // `start` applies a reference-mass impulse. Scale the input by the
            // new unit's actual mass. Inner positions stay near the impact while
            // outer positions receive proportionally stronger radial motion.
            const releaseScale = sim.mass(u) / LaunchImpactRules.referenceMass;
            this.start(sim, u, {
                kind: 'deploy',
                dx: spot.x - group.x,
                dy: spot.y - group.y,
                speed:
                    LaunchImpactRules.deploymentSpeed *
                    releaseScale *
                    (radiusSpan && !keepFormation ? (radii[i] - closest) / radiusSpan : 0),
                lift: fallDamage == null ? LaunchImpactRules.deploymentLift * releaseScale : 0,
                sourceId: group.projectileId,
                originX: group.x,
                originY: group.y,
                initialHeightFP: Math.max(
                    0,
                    group.heightFP +
                        Math.round(
                            (sim.world.terrain.surfaces.heightAt(group.x, group.y) -
                                sim.world.terrain.surfaces.heightAt(u.x, u.y)) *
                                FP,
                        ),
                ),
                initialVzFP: group.vzFP,
            });
            sim.events.push({
                type: 'launchLand',
                side: group.side,
                unit: group.type,
                count: 1,
                totalCount: group.count,
                index: i,
                projectileId: group.projectileId,
                unitIds: [u.id],
                units: [{ id: u.id, x: u.x, y: u.y }],
                x: group.x,
                y: group.y,
                impactHeightFP:
                    Math.round(sim.world.terrain.surfaces.heightAt(group.x, group.y) * FP) +
                    group.heightFP,
                holdPointId: group.holdPointId,
                ...(fallDamage == null ? {} : { fallDamage }),
            });
        }
        group.index = group.count;
        return true;
    }
    static deploy(sim) {
        let write = 0;
        for (const group of sim.launchDeployments) {
            if (group.index >= group.count) continue;
            if (group.lastPhysicsTick < sim.tick) {
                group.heightFP = Math.max(0, group.heightFP + Math.trunc(group.vzFP / sim.tps));
                group.vzFP -= Math.round((LaunchImpactRules.gravity * FP) / sim.tps);
                if (group.heightFP === 0 && group.vzFP < 0) group.vzFP = 0;
                group.lastPhysicsTick = sim.tick;
            }
            if (
                group.nextTick > sim.tick ||
                (group.emergencyDropHeightFP != null && group.heightFP > 0)
            ) {
                sim.launchDeployments[write++] = group;
                continue;
            }
            const grain = LaunchRules.grain(group.type),
                origin = { x: group.x, y: group.y };
            if (grain.deployTogether) {
                if (!this.deployTogether(sim, group, grain)) {
                    group.nextTick =
                        sim.tick + Math.max(1, sim.msTicks(LaunchImpactRules.deploymentRetryMs));
                    sim.launchDeployments[write++] = group;
                }
                continue;
            }
            const absoluteHeight =
                sim.world.terrain.surfaces.heightAt(group.x, group.y) + group.heightFP / FP;
            const spot = sim.findOpenSpawnAround(origin, group.type, {
                baseRadius: 0,
                maxRadius: grain.splash + 60,
                angleSlots: 12,
                radialStep: 10,
                seedKey: group.projectileId + '|release|' + group.index,
                maxElevation: absoluteHeight,
                canReach: (x, y) => this.releasePathClear(sim, group, x, y, absoluteHeight),
            });
            if (!spot) {
                if (HeroDeployment.landingFailed(sim, group)) continue;
                group.nextTick =
                    sim.tick + Math.max(1, sim.msTicks(LaunchImpactRules.deploymentRetryMs));
                sim.launchDeployments[write++] = group;
                continue;
            }
            const u = sim.spawnUnit(group.side, group.type, spot.x, spot.y);
            UnitResultStats.add(sim.unitResultStats, group.side, group.type, 'deployed');
            const enemy = sim.buildings.find(
                (b) =>
                    b.side === 1 - group.side &&
                    b.alive !== false &&
                    BuildingDefinition.isMainBase(b.type),
            ) || { x: group.x, y: group.y - 1 };
            let dx = enemy.x - group.x,
                dy = enemy.y - group.y,
                length = Math.hypot(dx, dy) || 1;
            dx /= length;
            dy /= length;
            if (grain.land === 'scatter') {
                const angle =
                    ((HashUtil.hash(group.projectileId + '|' + group.index) % 3600) / 3600) *
                    Math.PI *
                    2;
                dx = Math.cos(angle);
                dy = Math.sin(angle);
            } else if (grain.land === 'line') {
                const sign = group.index % 2 ? 1 : -1,
                    sideX = -dy,
                    sideY = dx;
                dx = sideX * sign;
                dy = sideY * sign;
            }
            if (!HeroDeployment.land(sim, group, u) && group.holdPointId)
                u.launchHoldPointId = group.holdPointId;
            const fallDamage = this.applyEmergencyDropDamage(group, u);
            if (grain.land === 'rush')
                sim.setTimedModifier(u, 'launchRush', {
                    durationTicks: sim.msTicks(grain.rushMs),
                    movePct: grain.rushPct,
                });
            this.start(sim, u, {
                kind: 'deploy',
                dx,
                dy,
                speed: LaunchImpactRules.deploymentSpeed,
                lift: fallDamage == null ? LaunchImpactRules.deploymentLift : 0,
                sourceId: group.projectileId,
                originX: group.x,
                originY: group.y,
                initialHeightFP: Math.max(
                    0,
                    group.heightFP +
                        Math.round(
                            (sim.world.terrain.surfaces.heightAt(group.x, group.y) -
                                sim.world.terrain.surfaces.heightAt(u.x, u.y)) *
                                FP,
                        ),
                ),
                initialVzFP: group.vzFP,
            });
            sim.events.push({
                type: 'launchLand',
                side: group.side,
                unit: group.type,
                count: 1,
                totalCount: group.count,
                index: group.index,
                projectileId: group.projectileId,
                unitIds: [u.id],
                units: [{ id: u.id, x: u.x, y: u.y }],
                x: group.x,
                y: group.y,
                impactHeightFP:
                    Math.round(sim.world.terrain.surfaces.heightAt(group.x, group.y) * FP) +
                    group.heightFP,
                holdPointId: group.holdPointId,
                ...(fallDamage == null ? {} : { fallDamage }),
            });
            group.index++;
            group.nextTick = sim.tick + Math.max(1, sim.msTicks(LaunchImpactRules.deploymentGapMs));
            if (group.index < group.count) sim.launchDeployments[write++] = group;
        }
        sim.launchDeployments.length = write;
    }
    static projectileHeight(sim, p, x, y) {
        const distance = Math.hypot(p.lockedAimX - p.launchX, p.lockedAimY - p.launchY) || 1;
        const progress = Math.max(
            0,
            Math.min(1, Math.hypot(x - p.launchX, y - p.launchY) / distance),
        );
        const atlas = sim.world.terrain.surfaces,
            ground =
                atlas.heightAt(p.launchX, p.launchY) * (1 - progress) +
                atlas.heightAt(p.lockedAimX, p.lockedAimY) * progress;
        return ground + LaunchImpactRules.flightHeight(progress, p.arcHeight);
    }
    static terrainSweep(sim, x0, y0, x1, y1) {
        const atlas = sim.world.terrain.surfaces;
        const minX = Math.min(x0, x1),
            minY = Math.min(y0, y1),
            maxX = Math.max(x0, x1),
            maxY = Math.max(y0, y1);
        const layers = atlas.layerIndex.query(minX, minY, maxX, maxY),
            ramps = atlas.rampIndex.query(minX, minY, maxX, maxY),
            bridges = atlas.bridgeIndex.query(minX, minY, maxX, maxY);
        const polygons = [...layers, ...bridges];
        for (const ramp of ramps)
            for (let i = 0; i < 2; i++) polygons.push(TerrainSurfaceAtlas.rampTriangle(ramp, i));
        return { atlas, polygons, cuts: TerrainSurfaceAtlas.segmentCuts(x0, y0, x1, y1, polygons) };
    }
    static releasePathClear(sim, group, x, y, absoluteHeight) {
        const dx = x - group.x,
            dy = y - group.y,
            { atlas, cuts } = this.terrainSweep(sim, group.x, group.y, x, y);
        for (let i = 1; i < cuts.length; i++) {
            const lo = cuts[i - 1],
                hi = cuts[i],
                mid = (lo + hi) / 2,
                surface = atlas.sample(group.x + dx * mid, group.y + dy * mid),
                gradient = surface.gradient || { x: 0, z: 0 };
            const slope = gradient.x * dx + gradient.z * dy;
            if (
                Math.max(
                    surface.elevation + slope * (lo - mid),
                    surface.elevation + slope * (hi - mid),
                ) >
                absoluteHeight + 1 / FP
            )
                return false;
        }
        const length2 = dx * dx + dy * dy,
            reach = Math.sqrt(length2) / 2 + sim.maxBuildingRadius;
        for (const i of sim.nearbyBuildingIndices((x + group.x) / 2, (y + group.y) / 2, reach)) {
            const building = sim.buildings[i];
            if (building?.alive === false) continue;
            const radius = BuildingDefinition.get(building.type)?.size || 30,
                bottom = atlas.heightAt(building.x, building.y);
            if (absoluteHeight < bottom || absoluteHeight > bottom + 2 * radius) continue;
            const t = length2
                ? Math.max(
                      0,
                      Math.min(
                          1,
                          ((building.x - group.x) * dx + (building.y - group.y) * dy) / length2,
                      ),
                  )
                : 0;
            if (Math.hypot(group.x + dx * t - building.x, group.y + dy * t - building.y) <= radius)
                return false;
        }
        return true;
    }
    static terrainContact(sim, p, toX, toY) {
        const dx = toX - p.x,
            dy = toY - p.y,
            { atlas, polygons, cuts } = this.terrainSweep(sim, p.x, p.y, toX, toY);
        // Exact layer/ramp boundaries, queried locally. A thin raised strip cannot fall between samples.
        for (let i = 1; i < cuts.length; i++) {
            const lo = cuts[i - 1],
                hi = cuts[i],
                mid = (lo + hi) / 2,
                mx = p.x + dx * mid,
                my = p.y + dy * mid,
                surface = atlas.sample(mx, my);
            const gradient = surface.gradient || { x: 0, z: 0 };
            // Each cut interval lies within one flat floor or one ramp triangle.
            const groundAt = (t) =>
                surface.elevation + gradient.x * dx * (t - mid) + gradient.z * dy * (t - mid);
            const gapAt = (t) =>
                this.projectileHeight(sim, p, p.x + dx * t, p.y + dy * t) - groundAt(t);
            let fraction = null;
            if (gapAt(lo) <= LaunchImpactRules.projectileRadius) fraction = lo;
            else if (gapAt(hi) <= LaunchImpactRules.projectileRadius) {
                // Shared height minus a linear terrain plane is concave: positive endpoints cannot hide a valley.
                let a = lo,
                    b = hi;
                for (let k = 0; k < 16; k++) {
                    const t = (a + b) / 2;
                    if (gapAt(t) > LaunchImpactRules.projectileRadius) a = t;
                    else b = t;
                }
                fraction = b;
            }
            if (fraction !== null) {
                const contactX = p.x + dx * fraction,
                    contactY = p.y + dy * fraction,
                    flightHeight = this.projectileHeight(sim, p, contactX, contactY),
                    floorHeight = groundAt(fraction);
                let x = Math.round(contactX * FP) / FP,
                    y = Math.round(contactY * FP) / FP,
                    impactHeightFP = Math.round(floorHeight * FP);
                if (flightHeight < floorHeight - 1 / FP) {
                    // A cliff side is struck at the shot's height, never at the plateau top.
                    // Keep the release origin on the incoming free side of the discontinuity.
                    const length = Math.hypot(dx, dy) || 1;
                    x = Math.round((contactX - dx / length / FP) * FP) / FP;
                    y = Math.round((contactY - dy / length / FP) * FP) / FP;
                    const free = (px, py) => atlas.heightAt(px, py) < floorHeight - 1 / FP;
                    if (!free(x, y)) {
                        // Grid rounding of a near-tangent segment can erase the backwards step.
                        // Use the crossed contour's outward normal instead, still at fixed-point resolution.
                        let found = false;
                        for (const polygon of polygons) {
                            if (found) break;
                            for (let edge = 0; edge < polygon.points.length && !found; edge++) {
                                const a = polygon.points[edge],
                                    b = polygon.points[(edge + 1) % polygon.points.length],
                                    ex = b.x - a.x,
                                    ey = b.y - a.y,
                                    den = ex * ex + ey * ey;
                                const t = den
                                    ? Math.max(
                                          0,
                                          Math.min(
                                              1,
                                              ((contactX - a.x) * ex + (contactY - a.y) * ey) / den,
                                          ),
                                      )
                                    : 0;
                                if (
                                    Math.hypot(a.x + ex * t - contactX, a.y + ey * t - contactY) >
                                        0.02 ||
                                    den === 0
                                )
                                    continue;
                                const len = Math.sqrt(den),
                                    sign = ey * dx - ex * dy > 0 ? -1 : 1,
                                    nx = (ey / len) * sign,
                                    ny = (-ex / len) * sign;
                                for (let quantum = 1; quantum <= 4; quantum++) {
                                    const px =
                                            Math.round((contactX + (nx * quantum) / FP) * FP) / FP,
                                        py = Math.round((contactY + (ny * quantum) / FP) * FP) / FP;
                                    if (free(px, py)) {
                                        x = px;
                                        y = py;
                                        found = true;
                                        break;
                                    }
                                }
                            }
                        }
                        if (!found) {
                            x = p.x;
                            y = p.y;
                        }
                    }
                    impactHeightFP = Math.round(this.projectileHeight(sim, p, x, y) * FP);
                }
                return {
                    fraction,
                    x,
                    y,
                    id: surface.id || 'terrain',
                    isBuilding: false,
                    isTerrain: true,
                    impactHeightFP,
                };
            }
        }
        return null;
    }
    static firstContact(sim, p, toX, toY) {
        const dx = toX - p.x,
            dy = toY - p.y,
            length2 = dx * dx + dy * dy;
        if (length2 < 0.000001) return null;
        let best = this.terrainContact(sim, p, toX, toY);
        const add = (entity, radius, height, isBuilding, startX = entity.x, startY = entity.y) => {
            // Relative sweep catches a moving grain crossing the shot between two authority ticks.
            const fx = p.x - startX,
                fy = p.y - startY,
                R = radius + LaunchImpactRules.projectileRadius;
            const relativeX = dx - (entity.x - startX),
                relativeY = dy - (entity.y - startY);
            const a = relativeX * relativeX + relativeY * relativeY,
                b = fx * relativeX + fy * relativeY,
                c = fx * fx + fy * fy - R * R;
            let entry = 0,
                exit = 1;
            if (a > 0.000001) {
                const disc = b * b - a * c;
                if (disc < 0) return;
                const root = Math.sqrt(disc);
                entry = Math.max(0, (-b - root) / a);
                exit = Math.min(1, (-b + root) / a);
                if (entry > exit) return;
            } else if (c > 0) return;
            const ground = sim.world.terrain.surfaces.heightAt(entity.x, entity.y);
            const bodyBottom = ground + (entity.impactMotion?.heightFP || 0) / FP,
                bodyTop = bodyBottom + height;
            const lower = bodyBottom - LaunchImpactRules.projectileRadius,
                upper = bodyTop + LaunchImpactRules.projectileRadius;
            const heightAt = (t) => this.projectileHeight(sim, p, p.x + dx * t, p.y + dy * t);
            // Split the shared concave parabola at its apex. Each remaining interval is monotone,
            // so a slab entry can be found for an ascending OR descending shot without sampling gaps.
            const distance = Math.hypot(p.lockedAimX - p.launchX, p.lockedAimY - p.launchY) || 1;
            const fromGround = sim.world.terrain.surfaces.heightAt(p.launchX, p.launchY),
                toGround = sim.world.terrain.surfaces.heightAt(p.lockedAimX, p.lockedAimY);
            const arc = p.arcHeight,
                q0 = Math.hypot(p.x - p.launchX, p.y - p.launchY) / distance;
            const q1 = Math.hypot(toX - p.launchX, toY - p.launchY) / distance;
            const peak =
                (4 * arc - 2 * LaunchImpactRules.launchHeight + toGround - fromGround) /
                (2 * (4 * arc - LaunchImpactRules.launchHeight));
            const peakFraction = q1 > q0 ? (peak - q0) / (q1 - q0) : -1;
            const cuts =
                peakFraction > entry && peakFraction < exit
                    ? [entry, peakFraction, exit]
                    : [entry, exit];
            let fraction = null;
            for (let i = 1; i < cuts.length; i++) {
                const start = cuts[i - 1],
                    end = cuts[i],
                    startHeight = heightAt(start),
                    endHeight = heightAt(end);
                if (startHeight >= lower && startHeight <= upper) {
                    fraction = start;
                    break;
                }
                const ascending = startHeight < lower && endHeight >= lower,
                    descending = startHeight > upper && endHeight <= upper;
                if (!ascending && !descending) continue;
                let lo = start,
                    hi = end;
                for (let iteration = 0; iteration < 16; iteration++) {
                    const mid = (lo + hi) / 2,
                        h = heightAt(mid);
                    if (ascending ? h < lower : h > upper) lo = mid;
                    else hi = mid;
                }
                const candidateHeight = heightAt(hi);
                if (candidateHeight >= lower && candidateHeight <= upper) {
                    fraction = hi;
                    break;
                }
            }
            if (fraction === null) return;
            const x = Math.round((p.x + dx * fraction) * FP) / FP,
                y = Math.round((p.y + dy * fraction) * FP) / FP;
            if (
                !best ||
                fraction < best.fraction ||
                (fraction === best.fraction && String(entity.id) < String(best.id))
            )
                best = {
                    fraction,
                    x,
                    y,
                    id: entity.id,
                    isBuilding,
                    impactHeightFP: Math.round(heightAt(fraction) * FP),
                };
        };
        const cx = (p.x + toX) / 2,
            cy = (p.y + toY) / 2,
            reach =
                Math.sqrt(length2) / 2 +
                sim.maxUnitRadius +
                LaunchImpactRules.projectileRadius +
                (sim.collisionMaxStepMovementFP || 0) / FP;
        sim.withNearbyUnits(cx, cy, reach, 1 - p.side, (indices) => {
            for (const i of indices) {
                const u = sim.units[i];
                if (u?.alive && u.side === 1 - p.side)
                    add(
                        u,
                        sim.unitRadius(u.type),
                        2 * sim.unitRadius(u.type),
                        false,
                        i < sim.collisionStartCount ? sim.collisionStartFx[i] / FP : u.x,
                        i < sim.collisionStartCount ? sim.collisionStartFy[i] / FP : u.y,
                    );
            }
        });
        const buildings = sim.nearbyBuildingIndices(
            cx,
            cy,
            Math.sqrt(length2) / 2 + sim.maxBuildingRadius + LaunchImpactRules.projectileRadius,
        );
        for (const i of buildings) {
            const b = sim.buildings[i];
            if (b?.alive !== false && b.side === 1 - p.side) {
                const size = BuildingDefinition.get(b.type)?.size || 30;
                add(b, size, size * 2, true);
            }
        }
        return best;
    }
}
export { LaunchImpact };
