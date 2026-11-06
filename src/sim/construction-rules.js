// Building work and its proportional integer resource payments share this owner.
// These pure queries are also used by the HUD; they never mutate saved progress.
class ConstructionRules {
    static cooldownMs = 1000;
    static phaseRatios = Object.freeze({ strikeStart: 0.75, recoverEnd: 0.25 });
    // The worker retreats one body-sized step and physically charges back to the building.
    static retreatDistance = 12;
    static contactTolerance = 0.15;
    static chargeSpeedMultiplier = 1.5;
    static chargeTimeoutMs = 1600;
    static create({ cost, workRequired, initialHpRatio }, startedAtTick) {
        if (
            !Number.isSafeInteger(cost) ||
            cost < 0 ||
            !Number.isSafeInteger(workRequired) ||
            workRequired < 1 ||
            !Number.isSafeInteger(cost * workRequired) ||
            !Number.isFinite(initialHpRatio) ||
            initialHpRatio < 0 ||
            initialHpRatio > 1
        )
            throw new Error('건설 비용·필요 작업량·초기 체력 비율이 잘못되었습니다.');
        return { cost, workRequired, initialHpRatio, workDone: 0, invested: 0, startedAtTick };
    }
    static progress(work) {
        return work ? work.workDone / work.workRequired : 1;
    }
    static project(work, workPerHit, wallet = Infinity) {
        // A construction capability must perform positive whole work. Zero/invalid
        // power is a configuration error, rather than a silent permanent wait.
        if (!Number.isSafeInteger(workPerHit) || workPerHit < 1)
            throw new Error('타격당 건설 작업량은 양의 안전한 정수여야 합니다.');
        if (wallet !== Infinity && (!Number.isSafeInteger(wallet) || wallet < 0))
            throw new Error('건설에 사용할 자원은 음수가 아닌 안전한 정수여야 합니다.');
        const { cost, workRequired, workDone, invested } = work;
        const requested = workDone + Math.min(workPerHit, workRequired - workDone);
        // If all remaining cost is covered, no wallet-scaled product is needed.
        // Otherwise invested+wallet+1 <= cost, whose product was checked at creation.
        const affordable =
            cost === 0 || wallet >= cost - invested
                ? workRequired
                : Math.min(
                      workRequired,
                      Math.floor(((invested + wallet + 1) * workRequired - 1) / cost),
                  );
        const nextWork = Math.max(workDone, Math.min(requested, affordable));
        const nextInvestment = cost === 0 ? 0 : Math.floor((cost * nextWork) / workRequired);
        return {
            workDone: nextWork,
            workAdded: nextWork - workDone,
            spend: nextInvestment - invested,
            invested: nextInvestment,
            complete: nextWork === workRequired,
        };
    }
    static nextPayment(work) {
        if (!work || work.cost === 0 || work.workDone === work.workRequired) return null;
        const previous = Math.ceil((work.invested * work.workRequired) / work.cost);
        const next = Math.min(
            work.workRequired,
            Math.ceil(((work.invested + 1) * work.workRequired) / work.cost),
        );
        const workSpan = next - previous;
        return {
            workDone: next,
            workRemaining: next - work.workDone,
            amount: Math.floor((work.cost * next) / work.workRequired) - work.invested,
            workSpan,
            progress: (work.workDone - previous) / workSpan,
        };
    }
    static healthAt(work, maxHp, workDone = work.workDone) {
        const initial = Math.round(maxHp * work.initialHpRatio);
        return initial + Math.round(((maxHp - initial) * workDone) / work.workRequired);
    }
}

export { ConstructionRules };
