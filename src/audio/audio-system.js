import { BuildingDefinition } from '../definitions/buildings.js';
import { UnitDefinition } from '../definitions/units.js';

export class AudioSystem {
    constructor() {
        this.ctx = null;
        this.master = null;
        this.compressor = null;
        this.noiseBuffer = null;
        this.enabled = true;
        this.unlocked = false;

        // 짧은 시간 창 안에서 같은 계열 SFX가 너무 많이 겹치지 않게 제한.
        this.budgets = {
            hit: { window: 70, max: 4, times: [] },
            shot: { window: 80, max: 3, times: [] },
            explosion: { window: 120, max: 2, times: [] },
            death: { window: 100, max: 2, times: [] },
        };
    }

    unlock() {
        if (!this.enabled) return;
        try {
            if (!this.ctx) {
                const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
                if (!AC) return;
                this.ctx = new AC();

                this.master = this.ctx.createGain();
                this.master.gain.value = 0.46;

                this.compressor = this.ctx.createDynamicsCompressor();
                this.compressor.threshold.value = -18;
                this.compressor.knee.value = 16;
                this.compressor.ratio.value = 6;
                this.compressor.attack.value = 0.002;
                this.compressor.release.value = 0.16;

                this.master.connect(this.compressor);
                this.compressor.connect(this.ctx.destination);

                // 0.5초짜리 노이즈 버퍼 한 번만 생성. 외부 음원 리소스 없음.
                const len = Math.floor(this.ctx.sampleRate * 0.5);
                this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
                const data = this.noiseBuffer.getChannelData(0);
                let state = 0x12345678;
                for (let i = 0; i < len; i++) {
                    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
                    data[i] = (state / 0xffffffff) * 2 - 1;
                }
            }
            if (this.ctx.state === 'suspended') this.ctx.resume();
            this.unlocked = true;
        } catch (_) {}
    }

    setEnabled(v) {
        this.enabled = !!v;
        if (this.enabled) this.unlock();
        if (this.master && this.ctx) {
            const t = this.ctx.currentTime;
            this.master.gain.cancelScheduledValues(t);
            this.master.gain.setTargetAtTime(this.enabled ? 0.46 : 0, t, 0.015);
        }
    }

    allow(kind) {
        const b = this.budgets[kind];
        if (!b) return true;
        const now = performance.now();
        b.times = b.times.filter((t) => now - t < b.window);
        if (b.times.length >= b.max) return false;
        b.times.push(now);
        return true;
    }

    spatialGain(x, y, renderer) {
        if (!renderer) return 0.7;
        const [sx, sy] = renderer.worldToPx(renderer.viewX(x), renderer.viewY(y));
        const dx = sx / (renderer.canvas.width * 0.5) - 1;
        const dy = sy / (renderer.canvas.height * 0.5) - 1;
        const d = Math.hypot(dx, dy);

        if (d > 2.25) return 0;
        if (d <= 0.65) return 1;
        return Math.max(0.08, 1 - (d - 0.65) / 1.6);
    }

    gainNode(value, when = 0) {
        const g = this.ctx.createGain();
        const t = this.ctx.currentTime + when;
        g.gain.setValueAtTime(Math.max(0.0001, value), t);
        g.connect(this.master);
        return { g, t };
    }

    tone({
        freq = 220,
        endFreq = null,
        type = 'sine',
        gain = 0.15,
        duration = 0.1,
        attack = 0.002,
        when = 0,
        filter = 0,
    } = {}) {
        if (!this.ctx || !this.enabled) return;
        const { g, t } = this.gainNode(gain, when);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + attack);
        g.gain.exponentialRampToValueAtTime(0.0001, t + duration);

        const o = this.ctx.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime(Math.max(20, freq), t);
        if (endFreq) o.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t + duration);

        if (filter) {
            const f = this.ctx.createBiquadFilter();
            f.type = 'lowpass';
            f.frequency.value = filter;
            o.connect(f);
            f.connect(g);
        } else o.connect(g);

        o.start(t);
        o.stop(t + duration + 0.02);
    }

    noise({ gain = 0.1, duration = 0.08, when = 0, lowpass = 2500, highpass = 0 } = {}) {
        if (!this.ctx || !this.enabled || !this.noiseBuffer) return;
        const t = this.ctx.currentTime + when;
        const src = this.ctx.createBufferSource();
        src.buffer = this.noiseBuffer;

        let node = src;
        if (highpass) {
            const hp = this.ctx.createBiquadFilter();
            hp.type = 'highpass';
            hp.frequency.value = highpass;
            node.connect(hp);
            node = hp;
        }
        if (lowpass) {
            const lp = this.ctx.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.value = lowpass;
            node.connect(lp);
            node = lp;
        }

        const g = this.ctx.createGain();
        g.gain.setValueAtTime(Math.max(0.0001, gain), t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
        node.connect(g);
        g.connect(this.master);
        src.start(t);
        src.stop(t + duration + 0.02);
    }

    metalHit(g = 0.5) {
        if (!this.allow('hit')) return;
        this.noise({ gain: 0.08 * g, duration: 0.045, highpass: 1800, lowpass: 7200 });
        this.tone({ freq: 920, endFreq: 560, type: 'square', gain: 0.035 * g, duration: 0.055 });
        this.tone({
            freq: 1450,
            endFreq: 1180,
            type: 'triangle',
            gain: 0.025 * g,
            duration: 0.035,
            when: 0.008,
        });
    }

    fleshHit(g = 0.5) {
        if (!this.allow('hit')) return;
        this.noise({ gain: 0.1 * g, duration: 0.055, lowpass: 1000 });
        this.tone({ freq: 105, endFreq: 72, type: 'sine', gain: 0.12 * g, duration: 0.075 });
    }

    explosion(g = 0.6, heavy = false) {
        if (!this.allow('explosion')) return;
        const mul = heavy ? 1.25 : 1;
        this.noise({
            gain: 0.22 * g * mul,
            duration: heavy ? 0.34 : 0.2,
            lowpass: heavy ? 1200 : 2100,
        });
        this.tone({
            freq: heavy ? 72 : 105,
            endFreq: heavy ? 34 : 55,
            type: 'sine',
            gain: 0.25 * g * mul,
            duration: heavy ? 0.36 : 0.2,
        });
        if (heavy)
            this.tone({
                freq: 42,
                endFreq: 28,
                type: 'sine',
                gain: 0.2 * g,
                duration: 0.42,
                when: 0.015,
            });
    }

    death(g = 0.5) {
        if (!this.allow('death')) return;
        this.tone({ freq: 130, endFreq: 52, type: 'sawtooth', gain: 0.06 * g, duration: 0.16 });
        this.noise({ gain: 0.06 * g, duration: 0.13, lowpass: 900 });
    }

    captureChime(g = 0.6) {
        this.tone({ freq: 330, endFreq: 440, type: 'sine', gain: 0.06 * g, duration: 0.16 });
        this.tone({
            freq: 440,
            endFreq: 660,
            type: 'sine',
            gain: 0.055 * g,
            duration: 0.18,
            when: 0.09,
        });
        this.tone({
            freq: 660,
            endFreq: 880,
            type: 'triangle',
            gain: 0.045 * g,
            duration: 0.22,
            when: 0.18,
        });
    }

    buildingCollapse(g = 0.7) {
        this.noise({ gain: 0.2 * g, duration: 0.35, lowpass: 1000 });
        this.tone({ freq: 74, endFreq: 32, type: 'sine', gain: 0.25 * g, duration: 0.38 });
        this.noise({ gain: 0.08 * g, duration: 0.22, highpass: 1200, lowpass: 3200, when: 0.08 });
    }

    playHitForType(sourceType, gain) {
        const d = UnitDefinition.get(sourceType) || BuildingDefinition.get(sourceType) || {};
        if ((d.splash || 0) >= 80) this.explosion(gain, true);
        else this.fleshHit(gain * 0.78);
    }

    playEvent(e, renderer) {
        if (!e || !this.enabled || !this.unlocked) return;
        if (e.type === 'unitSelfDestruct' && !renderer.eventVisible(e)) return;
        const gain = this.spatialGain(
            e.x ?? renderer.world.center.x,
            e.y ?? renderer.world.center.y,
            renderer,
        );
        if (gain <= 0) return;
        if (e.type === 'captureComplete') this.captureChime(Math.max(0.45, gain));
        else if (e.type === 'unitSelfDestruct') this.explosion(gain * 0.65);
        else if (e.type === 'buildingDeath') this.buildingCollapse(gain);
        else if (e.type === 'death') this.death(gain);
        else if (e.type === 'hit') this.playHitForType(e.sourceType || '', gain);
    }

    processSnapshot(snapshot, renderer) {
        if (!snapshot) return;
        for (const e of snapshot.events || []) this.playEvent(e, renderer);
    }
}
