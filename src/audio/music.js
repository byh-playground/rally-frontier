// The background tunes, made in the browser with WebAudio like the effects (audio-system.js): no audio files.
// `menu` plays on the title screens and `battle` in a match or a replay; a result is left to its jingle.
const MUSIC_GAIN = 0.42;
// Notes are scheduled this far ahead, in seconds, so a busy frame does not make the tune stumble.
const AHEAD = 0.25;
const SCHEDULE_MS = 60;
const SEMITONES = Object.freeze({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 });

function hz(name) {
    const [, letter, sharp, octave] = /^([A-G])(#?)(\d)$/.exec(name);
    const midi = SEMITONES[letter] + (sharp ? 1 : 0) + (Number(octave) + 1) * 12;
    return 440 * Math.pow(2, (midi - 69) / 12);
}

// One row is a bar of eight eighth notes; '.' is a rest.
const bars = (text) => text.split('|').map((bar) => bar.trim().split(/\s+/));

const TRACKS = Object.freeze({
    // 논두렁 산책: a light mallet tune.
    menu: Object.freeze({
        bpm: 100,
        melody: bars(
            'G4 . B4 D5 . B4 A4 . | B4 . D5 E5 D5 . B4 . | A4 . C5 E5 . D5 C5 . | B4 A4 G4 . A4 . . . | G4 . B4 D5 . B4 A4 . | B4 . D5 G5 E5 . D5 . | C5 . E5 D5 C5 . A4 . | B4 . A4 . G4 . . .',
        ),
        roots: 'G2 E2 C3 D3 G2 E2 C3 D3'.split(' '),
        step(play, t, bar, i) {
            const note = this.melody[bar][i],
                root = hz(this.roots[bar]);
            if (note !== '.') play.mallet(t, hz(note), 0.17);
            if (i === 0) play.pluck(t, root, 0.22);
            if (i === 4) play.pluck(t, root * 1.5, 0.17);
            if (i % 2 === 1) play.shaker(t, 0.028);
            if (i === 2 || i === 6) play.block(t, 0.05);
        },
    }),
    // 논두렁 한판: the same tune driven faster, with drums and claps; the second eight bars answer the first.
    battle: Object.freeze({
        bpm: 128,
        melody: bars(
            'G4 B4 D5 . B4 D5 B4 A4 | B4 . D5 E5 D5 . B4 . | A4 C5 E5 . D5 E5 D5 C5 | B4 A4 G4 . A4 . D5 . | G4 B4 D5 . B4 D5 B4 A4 | B4 . D5 G5 E5 . D5 . | C5 E5 G5 . E5 D5 C5 A4 | B4 . A4 . G4 . . . | E5 . E5 D5 E5 . G5 . | D5 . B4 . D5 . . . | C5 . C5 B4 C5 . E5 . | D5 . A4 . D5 . F#5 . | E5 . E5 D5 E5 G5 A5 . | G5 . E5 . D5 . B4 . | C5 E5 D5 C5 B4 D5 C5 A4 | G4 . D5 . G4 . . .',
        ),
        roots: 'G2 E2 C3 D3 G2 E2 C3 G2 C3 G2 A2 D3 C3 E2 D3 G2'.split(' '),
        step(play, t, bar, i, length) {
            const note = this.melody[bar][i],
                root = hz(this.roots[bar]);
            if (note !== '.') {
                play.mallet(t, hz(note), 0.16);
                if (bar >= 8) play.whistle(t, hz(note), length * 1.4, 0.035);
            }
            if (i % 2 === 0) play.pluck(t, i % 4 === 0 ? root : root * 1.5, 0.2);
            else play.pluck(t, root * 2, 0.08);
            if (i === 0 || i === 4) play.kick(t, 0.26);
            if (i === 2 || i === 6) play.snare(t, 0.07);
            play.shaker(t, i % 2 ? 0.032 : 0.016);
            if (bar % 8 === 7 && i >= 5) play.snare(t, 0.03 + (i - 5) * 0.025);
        },
    }),
});

// The instruments, playing into `out`.
function instruments(ctx, noiseBuffer, out) {
    function tone(t, freq, duration, gain, options = {}) {
        const osc = ctx.createOscillator(),
            g = ctx.createGain(),
            {
                type = 'sine',
                end = 0,
                attack = 0.006,
                hold = 0,
                lowpass = 0,
                vibrato = 0,
            } = options;
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t);
        if (end) osc.frequency.exponentialRampToValueAtTime(end, t + duration);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(gain, t + attack);
        if (hold) g.gain.setValueAtTime(gain, t + duration * hold);
        g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
        let node = osc;
        if (lowpass) {
            const filter = ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = lowpass;
            node.connect(filter);
            node = filter;
        }
        if (vibrato) {
            const lfo = ctx.createOscillator(),
                depth = ctx.createGain();
            lfo.frequency.value = 5.5;
            depth.gain.value = freq * vibrato;
            lfo.connect(depth);
            depth.connect(osc.frequency);
            lfo.start(t);
            lfo.stop(t + duration);
        }
        node.connect(g);
        g.connect(out);
        osc.start(t);
        osc.stop(t + duration + 0.02);
    }
    function noise(t, duration, gain, highpass, lowpass = 0) {
        const source = ctx.createBufferSource(),
            g = ctx.createGain();
        source.buffer = noiseBuffer;
        let node = source;
        for (const [type, frequency] of [
            ['highpass', highpass],
            ['lowpass', lowpass],
        ]) {
            if (!frequency) continue;
            const filter = ctx.createBiquadFilter();
            filter.type = type;
            filter.frequency.value = frequency;
            node.connect(filter);
            node = filter;
        }
        g.gain.setValueAtTime(gain, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
        node.connect(g);
        g.connect(out);
        source.start(t);
        source.stop(t + duration + 0.02);
    }
    return {
        // A round note with a short bright knock on top.
        mallet(t, f, gain) {
            tone(t, f, 0.42, gain);
            tone(t, f * 3.9, 0.07, gain * 0.22);
        },
        pluck: (t, f, gain) => tone(t, f, 0.3, gain, { type: 'triangle', lowpass: 1400 }),
        whistle: (t, f, duration, gain) =>
            tone(t, f, duration, gain, { attack: 0.04, hold: 0.6, vibrato: 0.008 }),
        kick: (t, gain) => tone(t, 120, 0.16, gain, { end: 45 }),
        snare(t, gain) {
            noise(t, 0.11, gain, 1400, 6500);
            tone(t, 190, 0.06, gain * 0.7, { type: 'triangle' });
        },
        shaker: (t, gain) => noise(t, 0.045, gain, 5000),
        block: (t, gain) => tone(t, 820, 0.05, gain, { type: 'triangle', end: 640 }),
    };
}

export class MusicPlayer {
    // `audio` is the AudioSystem whose context (opened by the first gesture) and noise the tunes share.
    constructor(audio) {
        this.audio = audio;
        this.enabled = true;
        this.track = 'menu';
        // The tune sounding now: { name, bus, timer }.
        this.playing = null;
    }

    setEnabled(on) {
        this.enabled = !!on;
        this.sync();
    }

    setScreen(screen) {
        const track =
            screen === 'game' || screen === 'replay'
                ? 'battle'
                : screen === 'result'
                  ? null
                  : 'menu';
        if (track === this.track) return;
        this.track = track;
        // After the task, so screens passed through on the way start nothing.
        clearTimeout(this.pending);
        this.pending = setTimeout(() => this.sync(), 0);
    }

    // Starts, changes or stops the tune to match the screen, the setting and whether the page shows.
    sync() {
        const wanted = this.enabled && !document.hidden && this.audio.ctx ? this.track : null;
        if (wanted === (this.playing?.name ?? null)) return;
        this.stop();
        if (wanted) this.start(wanted);
    }

    start(name) {
        const { ctx, noiseBuffer } = this.audio,
            track = TRACKS[name],
            bus = ctx.createGain();
        bus.gain.value = MUSIC_GAIN;
        // Past the effects' compressor, which would duck the tune under every shell.
        bus.connect(ctx.destination);
        const play = instruments(ctx, noiseBuffer, bus),
            length = 60 / track.bpm / 2,
            perBar = track.melody[0].length;
        let step = 0,
            next = ctx.currentTime + 0.1;
        const schedule = () => {
            // After a stall (a slept device, a long freeze) carry on from now rather than replaying the gap.
            if (next < ctx.currentTime) next = ctx.currentTime + 0.05;
            while (next < ctx.currentTime + AHEAD) {
                const bar = Math.floor(step / perBar) % track.melody.length;
                track.step(play, next, bar, step % perBar, length);
                step++;
                next += length;
            }
        };
        schedule();
        this.playing = { name, bus, timer: setInterval(schedule, SCHEDULE_MS) };
    }

    stop() {
        if (!this.playing) return;
        const { bus, timer } = this.playing;
        this.playing = null;
        clearInterval(timer);
        bus.gain.setTargetAtTime(0.0001, this.audio.ctx.currentTime, 0.05);
        setTimeout(() => bus.disconnect(), 400);
    }
}
