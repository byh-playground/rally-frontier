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
            // Clouds warned on the same tick, or a second cloud right after, share one alert instead of stacking.
            cloudWarning: { window: 1500, max: 1, times: [] },
            // Cannons fire and shells land in volleys: a few voices at a time.
            launch: { window: 140, max: 2, times: [] },
            landing: { window: 140, max: 2, times: [] },
            wall: { window: 150, max: 2, times: [] },
            collapse: { window: 250, max: 1, times: [] },
            result: { window: 5000, max: 1, times: [] },
        };
        // Which of the small pitch steps the next repeated sound takes, so it does not machine-gun.
        this.turn = 0;
    }

    unlock() {
        try {
            if (!this.ctx) {
                const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
                if (!AC) return;
                this.ctx = new AC();

                this.master = this.ctx.createGain();
                this.master.gain.value = this.enabled ? 0.46 : 0;

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
            // `suspended`, and iOS's `interrupted` after a call or another app.
            if (this.ctx.state !== 'running') this.ctx.resume();
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

    // A spore cloud is coming (the warning begins): two falling pulses over a short wind, the same wherever the cloud is
    // (it is often off screen, and the warning is for the player, not for a place).
    cloudWarning(g = 0.8) {
        if (!this.allow('cloudWarning')) return;
        for (const when of [0, 0.24]) {
            this.tone({
                freq: 392,
                endFreq: 311,
                type: 'triangle',
                gain: 0.075 * g,
                duration: 0.2,
                when,
            });
            this.tone({
                freq: 523,
                endFreq: 415,
                type: 'sine',
                gain: 0.05 * g,
                duration: 0.22,
                when: when + 0.03,
            });
        }
        this.noise({ gain: 0.05 * g, duration: 0.55, lowpass: 700, when: 0.1 });
    }

    vary() {
        this.turn = (this.turn + 1) % 5;
        return 0.93 + this.turn * 0.035;
    }

    // Small separate noise ticks, for pieces coming down one after another.
    scatter(
        count,
        { from = 0, span = 0.25, highpass = 1500, lowpass = 6000, gain = 0.06, duration = 0.025 },
    ) {
        for (let i = 0; i < count; i++)
            this.noise({
                gain: gain * (1 - i / (count * 1.6)),
                duration,
                highpass,
                lowpass,
                when: from + (i / count) * span + ((i * 7) % 5) * 0.004,
            });
    }

    // A cannon fires: a deep thump.
    cannonFire(g = 0.8) {
        if (!this.allow('launch')) return;
        const k = this.vary();
        this.tone({ freq: 150 * k, endFreq: 38, type: 'sine', gain: 0.34 * g, duration: 0.24 });
        this.noise({ gain: 0.17 * g, duration: 0.18, lowpass: 900 });
        this.noise({ gain: 0.08 * g, duration: 0.05, highpass: 1800, lowpass: 6000 });
    }

    // A shell lands: a thud and falling earth.
    shellLand(g = 0.8) {
        if (!this.allow('landing')) return;
        const k = this.vary();
        this.tone({ freq: 96 * k, endFreq: 34, type: 'sine', gain: 0.34 * g, duration: 0.26 });
        this.noise({ gain: 0.16 * g, duration: 0.3, lowpass: 700 });
        this.scatter(5, { from: 0.06, span: 0.2, highpass: 700, lowpass: 2600, gain: 0.04 * g });
    }

    // A building is struck: a wooden knock.
    wallHit(g = 0.6) {
        if (!this.allow('wall')) return;
        const k = this.vary();
        this.tone({
            freq: 470 * k,
            endFreq: 300 * k,
            type: 'triangle',
            gain: 0.12 * g,
            duration: 0.07,
        });
        this.tone({ freq: 190 * k, endFreq: 130, type: 'sine', gain: 0.09 * g, duration: 0.08 });
        this.noise({ gain: 0.05 * g, duration: 0.025, highpass: 900, lowpass: 3000 });
    }

    // A building falls: one big blow.
    buildingCollapse(g = 0.7) {
        if (!this.allow('collapse')) return;
        this.tone({ freq: 70, endFreq: 26, type: 'sine', gain: 0.4 * g, duration: 0.65 });
        this.tone({ freq: 42, endFreq: 28, type: 'sine', gain: 0.22 * g, duration: 0.7 });
        this.noise({ gain: 0.28 * g, duration: 0.5, lowpass: 1800 });
        this.noise({ gain: 0.09 * g, duration: 0.3, highpass: 1500, lowpass: 5000, when: 0.1 });
    }

    // The match is decided: `won` for the viewer; nothing for a draw (do not call).
    matchResult(won) {
        if (!this.enabled || !this.unlocked || !this.allow('result')) return;
        if (won) {
            [523, 659, 784, 1047].forEach((freq, i) => {
                this.tone({ freq, type: 'triangle', gain: 0.14, duration: 0.3, when: i * 0.11 });
                this.tone({
                    freq: freq * 2,
                    type: 'sine',
                    gain: 0.04,
                    duration: 0.2,
                    when: i * 0.11,
                });
            });
            return;
        }
        this.tone({
            freq: 196,
            endFreq: 98,
            type: 'sine',
            gain: 0.18,
            duration: 0.9,
            attack: 0.05,
        });
        this.tone({
            freq: 233,
            endFreq: 117,
            type: 'sine',
            gain: 0.1,
            duration: 0.9,
            attack: 0.05,
        });
        this.noise({ gain: 0.05, duration: 0.5, lowpass: 400 });
    }

    playHitForType(sourceType, gain) {
        const d = UnitDefinition.get(sourceType) || BuildingDefinition.get(sourceType) || {};
        if ((d.splash || 0) >= 80) this.explosion(gain, true);
        else this.fleshHit(gain * 0.78);
    }

    playEvent(e, renderer) {
        if (!e || !this.enabled || !this.unlocked) return;
        if (e.type === 'sporeCloudWarn') {
            this.cloudWarning();
            return;
        }
        // A burst, a shot, a landing or a knock on a wall that the viewer cannot see says nothing about it.
        const heard =
            e.type === 'unitSelfDestruct' ||
            e.type === 'buildingDeath' ||
            e.type === 'launchFire' ||
            e.type === 'mortarFire' ||
            e.type === 'launchImpact' ||
            e.type === 'mortarImpact' ||
            (e.type === 'hit' && e.isBuilding);
        if (heard && !renderer.eventVisible(e)) return;
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
        else if (e.type === 'launchFire' || e.type === 'mortarFire') this.cannonFire(gain * 0.8);
        else if (e.type === 'launchImpact' || e.type === 'mortarImpact') this.shellLand(gain * 0.8);
        else if (e.type === 'hit' && e.isBuilding) {
            if (!e.ambient) this.wallHit(gain);
        } else if (e.type === 'hit') this.playHitForType(e.sourceType || '', gain);
    }

    processSnapshot(snapshot, renderer) {
        if (!snapshot) return;
        for (const e of snapshot.events || []) this.playEvent(e, renderer);
    }
}
