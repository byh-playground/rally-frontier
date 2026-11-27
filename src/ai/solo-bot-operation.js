import { SimulationTiming } from '../core/simulation-timing.js';
import { LaunchRules } from '../sim/launch-rules.js';

const READY_MS = 9000;
const EFFECT_MS = 8000;
const RECOVERY_MS = 9000;

// Local AI decision state. The network and replay carry only ordinary commands.
export class SoloBotOperation {
    constructor(bot, definition) {
        this.bot = bot;
        this.definition = definition;
        this.current = { phase: 'idle' };
        this.history = [];
        this.lastTick = -1;
    }

    status() {
        const { phase, goal, index } = this.current;
        return {
            phase,
            goal: goal?.targetId ?? goal?.frontId ?? null,
            index,
            history: this.history.slice(),
        };
    }

    observe(state) {
        const plan = this.current;
        if (plan.phase !== 'await-effect' || plan.witness) return;
        const step = this.definition.steps[plan.index];
        if (step.observe?.(state, plan.goal, this.bot.side)) plan.witness = true;
    }

    note(kind, state, plan, step) {
        this.history.push({
            kind,
            tick: state.tick,
            card: step?.card,
            index: plan.index,
            x: plan.goal?.focus.x,
            y: plan.goal?.focus.y,
            targetId: plan.goal?.targetId,
        });
        if (this.history.length > 36) this.history.shift();
    }

    ticks(state, ms) {
        return SimulationTiming.time(state.tps).ceilTicks(ms);
    }

    stop(state, reason) {
        if (['idle', 'recovery', 'complete'].includes(this.current.phase)) return;
        this.note(reason, state, this.current, this.definition.steps[this.current.index]);
        this.current = { phase: 'recovery', until: state.tick + this.ticks(state, RECOVERY_MS) };
    }

    ready(state, goal, index) {
        this.current = {
            phase: 'ready',
            goal,
            index,
            until: state.tick + this.ticks(state, READY_MS),
        };
    }

    canStart(ctx) {
        // Fixed campaign-independent economy gate. An opener may wait for income, but a plan
        // whose whole follow-up needs unavailable oil leaves the ordinary opening in charge.
        const oil = this.definition.steps.reduce(
            (sum, step) => sum + LaunchRules.payload(step.card).premiumCost,
            0,
        );
        if (ctx.state.premiumWallet[ctx.side] < oil) return false;
        const first = this.definition.steps[0];
        return ctx.cards.some((card) => card.type === first.card && ctx.budget >= card.cost);
    }

    decide(ctx) {
        const { state } = ctx;
        if (state.tick < this.lastTick) {
            this.current = { phase: 'idle' };
            this.history.length = 0;
        }
        this.lastTick = state.tick;
        if (this.current.phase === 'complete') return false;
        if (this.current.phase === 'recovery') {
            if (this.current.until > state.tick) return false;
            this.current = { phase: 'idle' };
        }
        if (this.current.phase === 'idle') {
            if (!ctx.cannons.length || !this.canStart(ctx)) return false;
            const goal = this.definition.select(ctx);
            if (!goal) return false;
            this.ready(state, goal, 0);
        }

        let plan = this.current;
        let step = this.definition.steps[plan.index];
        if (plan.phase === 'await-command') {
            const receipts = this.bot.session.sim.commandReceipts ?? [];
            const receipt = receipts.findLast(
                (entry) =>
                    entry.actor === this.bot.role &&
                    entry.netcodeSequence === plan.sequence &&
                    entry.tick <= state.tick,
            );
            if (receipt?.applied) {
                this.note('applied', state, plan, step);
                this.current = plan = {
                    phase: 'await-effect',
                    goal: plan.goal,
                    index: plan.index,
                    deployed: plan.deployed,
                    witness: false,
                    until: state.tick + this.ticks(state, step.waitMs ?? EFFECT_MS),
                };
            } else if (receipt || state.tick >= plan.until) {
                this.stop(state, receipt ? 'rejected' : 'missing-receipt');
                return false;
            } else return true;
        }
        const deployed = (card) => state.unitResultStats[ctx.side][card]?.deployed ?? 0;
        if (
            plan.phase === 'await-effect' &&
            deployed(step.card) > plan.deployed &&
            (!step.done || step.done(ctx, plan.goal, plan.witness))
        ) {
            this.note('completed', state, plan, step);
            if (plan.index + 1 === this.definition.steps.length) {
                this.stop(state, 'finished');
                if (this.definition.once) this.current = { phase: 'complete' };
                return false;
            }
            this.ready(state, plan.goal, plan.index + 1);
            plan = this.current;
            step = this.definition.steps[plan.index];
        }
        if (state.tick >= plan.until) {
            this.stop(state, step.optional ? 'follow-up-skipped' : 'timed-out');
            if (step.optional && this.definition.once) this.current = { phase: 'complete' };
            return false;
        }
        if (plan.phase !== 'ready') return true;
        if (step.valid && !step.valid(ctx, plan.goal)) {
            this.stop(state, step.optional ? 'follow-up-skipped' : 'target-lost');
            if (step.optional && this.definition.once) this.current = { phase: 'complete' };
            return false;
        }
        const shot = step.shot(ctx, plan.goal);
        if (!shot || shot.unit.cost > ctx.budget) return true;
        this.bot.fire(shot, shot.unit, ctx.level, state.tick, true, (sequence) => {
            this.current = {
                phase: 'await-command',
                goal: plan.goal,
                index: plan.index,
                sequence,
                deployed: deployed(step.card),
                until: plan.until,
            };
        });
        return true;
    }
}
