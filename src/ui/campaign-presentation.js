import { campaignBriefingLines } from './campaign-copy.js';

const CUE_SECONDS = 3;
const ATTACK_GOAL = '적 본진 파괴';

function formatCountdown(seconds) {
    const value = Math.max(0, Math.ceil(seconds));
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

function missionGoal(stage) {
    if (!stage.defenseSeconds) return ATTACK_GOAL;
    const time = formatCountdown(stage.defenseSeconds);
    return stage.mode === 'counterattack'
        ? `${time} 방어 후 적 본진 파괴`
        : `${time} 동안 본진 방어`;
}

function currentGoal(stage, snapshot, side, remaining) {
    if (stage.defenseSeconds && (remaining > 0 || stage.mode === 'defend'))
        return { key: 'defend', label: '본진 방어' };
    if (
        stage.resourceLesson &&
        !snapshot.capturePoints?.some(
            (point) => point.owner === side && point.resourceType === 'premium',
        )
    ) {
        return (snapshot.launchRangeLevel?.[side] || 0) === 0
            ? { key: 'range', label: '사거리 한 번 강화' }
            : { key: 'oil', label: '측면 기름 거점 확보' };
    }
    return { key: 'attack', label: ATTACK_GOAL };
}

export class CampaignPresentation {
    static install(find) {
        this.$ = find;
        const dialog = find('campaignBriefingDialog');
        find('campaignBriefingBack').onclick = () => dialog.close();
        find('campaignBriefingNext').onclick = () => this.advanceBriefing();
        find('campaignBriefingSkip').onclick = () => this.finishBriefing();
        dialog.addEventListener('close', () => {
            if (!dialog.open) this.briefing = null;
        });
    }

    static showBriefing(stage, start) {
        this.briefing = { lines: campaignBriefingLines(stage), index: 0, start };
        this.$('campaignBriefingTitle').textContent = stage.title;
        this.$('campaignBriefingObjective').textContent = missionGoal(stage);
        this.renderBriefingLine();
        const dialog = this.$('campaignBriefingDialog');
        if (!dialog.open) dialog.showModal();
    }

    static renderBriefingLine() {
        const { lines, index } = this.briefing;
        const { speaker, text } = lines[index];
        const last = index === lines.length - 1;
        this.$('campaignBriefingSpeaker').textContent = speaker;
        this.$('campaignBriefingLine').textContent = text;
        this.$('campaignBriefingProgress').textContent = `${index + 1} / ${lines.length}`;
        this.$('campaignBriefingNext').textContent = last ? '전투 시작' : '다음';
        this.$('campaignBriefingSkip').hidden = last;
    }

    static advanceBriefing() {
        const briefing = this.briefing;
        if (!briefing) return;
        if (briefing.index + 1 >= briefing.lines.length) this.finishBriefing();
        else {
            briefing.index++;
            this.renderBriefingLine();
        }
    }

    static finishBriefing() {
        const briefing = this.briefing;
        if (!briefing) return;
        this.briefing = null;
        this.$('campaignBriefingDialog').close();
        briefing.start();
    }

    static renderBattle(stage, snapshot, side, tps) {
        if (!stage) {
            this.clearBattle();
            return;
        }
        const tick = snapshot.tick;
        const remaining = (stage.defenseSeconds || 0) - tick / tps;
        const goal = currentGoal(stage, snapshot, side, remaining);
        const $ = this.$;
        if (this.battle?.stage !== stage) {
            this.battle = { stage, goal: goal.key, announced: new Set([goal.key]), cueEnd: 0 };
            $('campaignObjective').classList.remove('hidden');
            $('campaignObjectiveLabel').textContent = goal.label;
            this.showCue('전투 목표', missionGoal(stage), tick, tps);
        } else if (this.battle.goal !== goal.key) {
            const previous = this.battle.goal;
            this.battle.goal = goal.key;
            $('campaignObjectiveLabel').textContent = goal.label;
            if (!this.battle.announced.has(goal.key)) {
                this.battle.announced.add(goal.key);
                const title =
                    previous === 'defend' && stage.mode === 'counterattack'
                        ? '반격 개시'
                        : '다음 목표';
                this.showCue(title, goal.label, tick, tps);
            } else {
                this.battle.cueEnd = tick;
            }
        }
        const timer = $('campaignObjectiveTimer');
        timer.hidden = goal.key !== 'defend';
        if (!timer.hidden) {
            const value = formatCountdown(remaining);
            if (timer.textContent !== value) timer.textContent = value;
        }
        $('campaignCue').classList.toggle('hidden', tick >= this.battle.cueEnd);
    }

    static showCue(title, text, tick, tps) {
        this.battle.cueEnd = tick + Math.ceil(CUE_SECONDS * tps);
        this.$('campaignCueTitle').textContent = title;
        this.$('campaignCueText').textContent = text;
    }

    static clearBattle() {
        if (!this.battle) return;
        this.battle = null;
        this.$('campaignObjective').classList.add('hidden');
        this.$('campaignCue').classList.add('hidden');
    }
}
