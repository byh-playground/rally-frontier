(function (global) {
  'use strict';

  const WORLD_UNITS_PER_METER = 100;
  const compareIds = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : a.index - b.index;
  const clamp = (value, radius, extent) => {
    const inset = Math.min(radius, extent / 2);
    return Math.max(inset, Math.min(extent - inset, value));
  };

  // This adapter only supplies unit positions. Terrain, enemy pressure rules and
  // game state remain the caller's responsibility; no game code lives here.
  class RapierController {
    constructor({ substeps = 1, collisionPolicy = 'all' } = {}) {
      if (!global.RAPIER) throw new Error('Initialize globalThis.RAPIER before creating RapierController.');
      if (!Number.isInteger(substeps) || substeps < 1 || substeps > 64) {
        throw new RangeError('Rapier substeps must be an integer from 1 to 64.');
      }
      if (collisionPolicy !== 'all' && collisionPolicy !== 'allies') {
        throw new RangeError('Unknown Rapier collision policy.');
      }
      this.R = global.RAPIER;
      this.substeps = substeps;
      this.collisionPolicy = collisionPolicy;
      this.world = new this.R.World({ x: 0, y: 0 });
      this.entries = new Map();
      this.creationSerial = 0;
      this.lastTick = null;
    }

    _groupKey(unit) {
      const sameSideOnly = this.collisionPolicy === 'allies' || !!unit.burrow;
      if (sameSideOnly && unit.side !== 0 && unit.side !== 1) return null;
      return JSON.stringify(sameSideOnly
        ? [unit.layer, !!unit.burrow, unit.side]
        : [unit.layer, !!unit.burrow]);
    }

    solve(frame) {
      if (!this.world) throw new Error('RapierController is disposed.');
      if (!Number.isFinite(frame.dt) || frame.dt <= 0) throw new RangeError('Physics dt must be positive.');
      const { width, height } = frame.bounds;
      if (![width, height].every(value => Number.isFinite(value) && value > 0)) {
        throw new RangeError('Physics bounds must be finite and positive.');
      }
      const ordered = frame.units.slice().sort(compareIds);
      const present = new Set();
      const groupKeys = new Set();
      for (const unit of ordered) {
        if (typeof unit.id !== 'string' || present.has(unit.id)) throw new Error('Physics unit IDs must be unique strings.');
        if (![unit.x0, unit.y0, unit.x1, unit.y1, unit.radius, unit.mass].every(Number.isFinite)
            || unit.radius <= 0 || unit.mass <= 0) throw new RangeError('Invalid physics unit geometry or mass.');
        present.add(unit.id);
        const key = this._groupKey(unit);
        if (key !== null) groupKeys.add(key);
      }
      // Native groups filter both ordinary contacts and CCD. A JS contact hook
      // would add a callback per candidate and is unnecessary for these layers.
      const keys = [...groupKeys].sort();
      if (keys.length > 16) throw new RangeError('Rapier probe supports at most 16 layer/burrow/side collision groups.');
      const groups = new Map(keys.map((key, bit) => {
        const membership = 1 << bit;
        return [key, ((membership << 16) | membership) >>> 0];
      }));

      for (const entry of [...this.entries.values()].sort(compareIds)) {
        if (!present.has(entry.id)) {
          this.world.removeRigidBody(this.world.getRigidBody(entry.bodyHandle));
          this.entries.delete(entry.id);
        }
      }
      const scale = WORLD_UNITS_PER_METER;
      for (const unit of ordered) {
        let entry = this.entries.get(unit.id);
        const collisionGroups = groups.get(this._groupKey(unit)) || 0;
        if (!entry) {
          const body = this.world.createRigidBody(this.R.RigidBodyDesc.dynamic()
            .setTranslation(unit.x0 / scale, unit.y0 / scale)
            .lockRotations().setCanSleep(false).setCcdEnabled(true)
            .setLinearDamping(0).setAngularDamping(0));
          const collider = this.world.createCollider(this.R.ColliderDesc.ball(unit.radius / scale)
            .setMass(unit.mass).setFriction(0).setRestitution(0)
            .setCollisionGroups(collisionGroups), body);
          entry = { id: unit.id, bodyHandle: body.handle, colliderHandle: collider.handle,
            serial: this.creationSerial++, radius: unit.radius, mass: unit.mass, collisionGroups };
          this.entries.set(unit.id, entry);
        }
        const body = this.world.getRigidBody(entry.bodyHandle);
        const collider = this.world.getCollider(entry.colliderHandle);
        if (entry.radius !== unit.radius) collider.setShape(new this.R.Ball(unit.radius / scale));
        if (entry.radius !== unit.radius || entry.mass !== unit.mass) collider.setMass(unit.mass);
        if (entry.collisionGroups !== collisionGroups) collider.setCollisionGroups(collisionGroups);
        Object.assign(entry, { index: unit.index, side: unit.side, layer: unit.layer,
          burrow: !!unit.burrow, radius: unit.radius, mass: unit.mass, collisionGroups });
        body.setTranslation({ x: unit.x0 / scale, y: unit.y0 / scale }, true);
        body.setLinvel({ x: (unit.x1 - unit.x0) / scale / frame.dt,
          y: (unit.y1 - unit.y0) / scale / frame.dt }, true);
        body.setAngvel(0, true);
        body.resetForces(true);
        body.resetTorques(true);
      }
      this.world.timestep = frame.dt / this.substeps;
      for (let step = 0; step < this.substeps; step++) this.world.step();

      let contacts = 0;
      let invalidPositions = 0;
      const positions = ordered.map(unit => {
        const entry = this.entries.get(unit.id);
        const body = this.world.getRigidBody(entry.bodyHandle);
        const position = body.translation();
        let x = position.x * scale;
        let y = position.y * scale;
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          invalidPositions++;
          x = unit.x0;
          y = unit.y0;
        }
        const boundedX = clamp(x, unit.radius, width);
        const boundedY = clamp(y, unit.radius, height);
        if (boundedX !== x || boundedY !== y || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
          body.setTranslation({ x: boundedX / scale, y: boundedY / scale }, true);
        }
        this.world.narrowPhase.contactPairsWith(entry.colliderHandle, otherHandle => {
          if (entry.colliderHandle < otherHandle) contacts++;
        });
        return { index: unit.index, x: boundedX, y: boundedY };
      });
      this.lastTick = frame.tick;
      return { positions, diagnostics: { bodies: ordered.length, contacts, substeps: this.substeps,
        invalidPositions, collisionPolicy: this.collisionPolicy,
        solverIterations: this.world.numSolverIterations, worldUnitsPerMeter: scale } };
    }

    snapshot() {
      if (!this.world) throw new Error('RapierController is disposed.');
      return { version: 1, substeps: this.substeps, collisionPolicy: this.collisionPolicy,
        creationSerial: this.creationSerial, lastTick: this.lastTick,
        world: this.world.takeSnapshot(),
        entries: [...this.entries.values()].sort(compareIds).map(entry => ({ ...entry })) };
    }

    restore(state) {
      if (state.version !== 1) throw new Error('Unsupported Rapier probe snapshot.');
      const restored = this.R.World.restoreSnapshot(new Uint8Array(state.world));
      const entries = new Map(state.entries.map(entry => [entry.id, { ...entry }]));
      if (this.world) this.world.free();
      this.world = restored;
      this.entries = entries;
      this.substeps = state.substeps;
      this.collisionPolicy = state.collisionPolicy;
      this.creationSerial = state.creationSerial;
      this.lastTick = state.lastTick;
    }

    dispose() {
      if (this.world) this.world.free();
      this.world = null;
      this.entries.clear();
    }
  }

  global.PhysicsControllerProbe = global.PhysicsControllerProbe || {};
  global.PhysicsControllerProbe.RapierController = RapierController;
})(globalThis);
