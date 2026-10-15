(function registerMatterController(global) {
  'use strict';

  const VERSION = 'matter-controller-graph-v1';
  const BASE_DELTA_MS = 1000 / 60;

  // Matter's bodies, vertices and contacts reference one another. JSON.stringify
  // on positions alone loses the solver's warm state. Preserve the full graph,
  // including Infinity inertia, undefined properties and shared references.
  function packGraph(root, timing) {
    const seen = new Map();
    const nodes = [];
    function pack(value) {
      if (value === undefined) return { undefined: true };
      if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) {
        return { number: Object.is(value, -0) ? '-0' : String(value) };
      }
      if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return value;
      if (typeof value !== 'object') {
        throw new Error('Matter snapshot supports data only; callbacks/plugins must not be installed.');
      }
      if (seen.has(value)) return { ref: seen.get(value) };
      const prototype = Object.getPrototypeOf(value);
      if ((!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
          || Object.getOwnPropertySymbols(value).length) {
        throw new Error('Matter snapshot encountered an unsupported object prototype or symbol.');
      }
      const id = nodes.length;
      seen.set(value, id);
      const node = { array: Array.isArray(value), nullPrototype: prototype === null, entries: [] };
      if (node.array) node.length = value.length;
      nodes.push(node);
      for (const key of Object.keys(value)) {
        // Matter assigns random display colors when new bodies are created.
        // This probe uses the game's renderer, so engine render settings are
        // presentation only and must not enter rollback state or peer hashes.
        if (key === 'render') continue;
        // Engine.update writes wall-clock duration here; peers must never hash it.
        const data = value === timing && key === 'lastElapsed' ? 0 : value[key];
        node.entries.push([key, pack(data)]);
      }
      return { ref: id };
    }
    return { root: pack(root), nodes };
  }

  function unpackGraph(graph) {
    const objects = graph.nodes.map(node => node.array
      ? new Array(node.length) : (node.nullPrototype ? Object.create(null) : {}));
    function unpack(value) {
      if (value === null || typeof value !== 'object') return value;
      if (Object.prototype.hasOwnProperty.call(value, 'ref')) return objects[value.ref];
      if (value.undefined) return undefined;
      if (Object.prototype.hasOwnProperty.call(value, 'number')) return Number(value.number);
      throw new Error('Invalid Matter snapshot graph value.');
    }
    graph.nodes.forEach((node, index) => {
      for (const [key, value] of node.entries) {
        Object.defineProperty(objects[index], key, {
          value: unpack(value), enumerable: true, writable: true, configurable: true
        });
      }
    });
    return unpack(graph.root);
  }

  function finite(value, name) {
    if (!Number.isFinite(value)) throw new Error(`Matter frame requires finite ${name}.`);
    return value;
  }

  function clampToBounds(value, radius, extent) {
    if (extent < radius * 2) return extent / 2;
    return Math.max(radius, Math.min(extent - radius, value));
  }

  class MatterController {
    constructor({ substeps = 1, collisionPolicy = 'all' } = {}) {
      if (!global.Matter || global.Matter.version !== '0.20.0') {
        throw new Error('MatterController requires the pinned Matter.js 0.20.0 browser bundle.');
      }
      if (!Number.isInteger(substeps) || substeps < 1) throw new Error('substeps must be a positive integer.');
      if (!['all', 'allies'].includes(collisionPolicy)) throw new Error('Unknown collision policy.');
      this.matter = global.Matter;
      this.substeps = substeps;
      this.collisionPolicy = collisionPolicy;
      this.engine = this.matter.Engine.create({
        enableSleeping: false,
        gravity: { x: 0, y: 0, scale: 0 }
      });
      // Body IDs feed collision ordering and pair keys. Matter's module-global
      // allocator is shared by independent benchmark instances, so do not use it.
      this.engine.world.id = 0;
      this.records = new Map();
      this.groups = new Map();
      this.nextBodyId = 1;
      this.nextGroup = 1;
      this.disposed = false;
    }

    _filter(unit) {
      // Burrowed units participate only in allied separation in the game.
      const alliesOnly = this.collisionPolicy === 'allies' || Boolean(unit.burrow);
      if (alliesOnly && unit.side !== 0 && unit.side !== 1) {
        return { group: 0, category: 1, mask: 0 };
      }
      const key = JSON.stringify([unit.layer, Boolean(unit.burrow),
        alliesOnly ? unit.side : null]);
      if (!this.groups.has(key)) this.groups.set(key, this.nextGroup++);
      // Same positive group always collides; mask 0 excludes all other groups.
      return { group: this.groups.get(key), category: 1, mask: 0 };
    }

    _create(unit) {
      const body = this.matter.Bodies.circle(unit.x0, unit.y0, unit.radius, {
        id: this.nextBodyId++,
        label: `probe:${unit.id}`,
        friction: 0,
        frictionStatic: 0,
        frictionAir: 0,
        restitution: 0,
        inertia: Infinity,
        collisionFilter: this._filter(unit)
      });
      this.matter.Body.setMass(body, unit.mass);
      this.matter.Body.setInertia(body, Infinity);
      this.matter.Composite.add(this.engine.world, body);
      const record = { body, radius: unit.radius, mass: unit.mass };
      this.records.set(unit.id, record);
      return record;
    }

    solve(frame) {
      if (this.disposed) throw new Error('MatterController has been disposed.');
      const dt = finite(frame.dt, 'dt');
      if (dt <= 0) throw new Error('Matter frame dt must be positive.');
      const width = finite(frame.bounds.width, 'bounds.width');
      const height = finite(frame.bounds.height, 'bounds.height');
      if (width <= 0 || height <= 0) throw new Error('Matter bounds must be positive.');
      const units = [...frame.units].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const liveIds = new Set();
      for (const unit of units) {
        if (typeof unit.id !== 'string' || liveIds.has(unit.id)) throw new Error('Matter unit IDs must be unique strings.');
        liveIds.add(unit.id);
        for (const key of ['x0', 'y0', 'x1', 'y1', 'radius', 'mass']) finite(unit[key], `unit.${key}`);
        if (unit.radius <= 0 || unit.mass <= 0) throw new Error('Matter radius and mass must be positive.');
      }
      for (const [id, record] of this.records) {
        if (!liveIds.has(id)) {
          this.matter.Composite.remove(this.engine.world, record.body);
          this.records.delete(id);
        }
      }
      for (const unit of units) {
        const record = this.records.get(unit.id) || this._create(unit);
        const body = record.body;
        if (record.radius !== unit.radius) {
          const ratio = unit.radius / record.radius;
          this.matter.Body.scale(body, ratio, ratio);
          record.radius = unit.radius;
        }
        if (record.mass !== unit.mass || body.mass !== unit.mass) {
          this.matter.Body.setMass(body, unit.mass);
          record.mass = unit.mass;
        }
        this.matter.Body.setInertia(body, Infinity);
        body.collisionFilter = this._filter(unit);
        this.matter.Body.setPosition(body, { x: unit.x0, y: unit.y0 });
        this.matter.Body.setAngle(body, 0);
        this.matter.Body.setAngularVelocity(body, 0);
        if (frame.projectionOnly) {
          // Pinned adapter detail: an authoritative positional correction is not
          // inertial rigid-body motion. Matter's stored positional displacement
          // must not push a unit again after external enemy/terrain corrections.
          body.positionImpulse.x = body.positionImpulse.y = 0;
        }
        body.force.x = body.force.y = body.torque = 0;
        // Body.setVelocity uses distance per 1/60 second, rather than per second.
        // Set once per game tick so contacts may modify velocity between substeps.
        this.matter.Body.setVelocity(body, {
          x: (unit.x1 - unit.x0) * BASE_DELTA_MS / (dt * 1000),
          y: (unit.y1 - unit.y0) * BASE_DELTA_MS / (dt * 1000)
        });
      }
      const stepMs = dt * 1000 / this.substeps;
      let contactsPeak = 0;
      let contactSteps = 0;
      for (let step = 0; step < this.substeps; step++) {
        this.matter.Engine.update(this.engine, stepMs);
        let count = 0;
        for (const pair of this.engine.pairs.list) if (pair.isActive) count++;
        contactsPeak = Math.max(contactsPeak, count);
        contactSteps += count;
      }
      let clamped = 0;
      const positions = frame.units.map(unit => {
        const body = this.records.get(unit.id).body;
        const x = clampToBounds(finite(body.position.x, 'result.x'), unit.radius, width);
        const y = clampToBounds(finite(body.position.y, 'result.y'), unit.radius, height);
        if (x !== body.position.x || y !== body.position.y) {
          clamped++;
          this.matter.Body.setPosition(body, { x, y });
        }
        return { index: unit.index, x, y };
      });
      let contacts = 0;
      for (const pair of this.engine.pairs.list) if (pair.isActive) contacts++;
      return {
        positions,
        diagnostics: {
          bodies: units.length, contacts, contactsPeak, contactSteps,
          substeps: this.substeps, clamped, collisionPolicy: this.collisionPolicy,
          positionIterations: this.engine.positionIterations,
          velocityIterations: this.engine.velocityIterations,
          circleApproximation: 'Matter.Bodies.circle polygon',
          continuousCollisionDetection: false
        }
      };
    }

    snapshot() {
      if (this.disposed) throw new Error('MatterController has been disposed.');
      return {
        version: VERSION,
        matterVersion: this.matter.version,
        graph: packGraph({
          engine: this.engine,
          records: [...this.records],
          groups: [...this.groups],
          nextBodyId: this.nextBodyId,
          nextGroup: this.nextGroup,
          substeps: this.substeps,
          collisionPolicy: this.collisionPolicy
        }, this.engine.timing)
      };
    }

    restore(snapshot) {
      if (this.disposed) throw new Error('MatterController has been disposed.');
      if (snapshot.version !== VERSION || snapshot.matterVersion !== this.matter.version) {
        throw new Error('Incompatible MatterController snapshot.');
      }
      const restored = unpackGraph(snapshot.graph);
      this.engine = restored.engine;
      this.records = new Map(restored.records);
      this.groups = new Map(restored.groups);
      this.nextBodyId = restored.nextBodyId;
      this.nextGroup = restored.nextGroup;
      this.substeps = restored.substeps;
      this.collisionPolicy = restored.collisionPolicy;
      return this;
    }

    dispose() {
      if (this.disposed) return;
      this.matter.Composite.clear(this.engine.world, false);
      this.matter.Engine.clear(this.engine);
      this.records.clear();
      this.groups.clear();
      this.disposed = true;
    }
  }

  global.PhysicsControllerProbe = global.PhysicsControllerProbe || {};
  global.PhysicsControllerProbe.MatterController = MatterController;
})(globalThis);
