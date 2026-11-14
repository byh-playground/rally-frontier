import { campaignBriefingLines } from './campaign-copy.js';

const CUE_SECONDS = 3;
const ATTACK_GOAL = '적 본진 파괴';
const HERO_LESSON_GOALS = {
    launch: '전방에 영웅 출격',
    fight: '영웅으로 적 처치',
    recover: '영웅 카드를 한 번 눌러 복귀',
    redeploy: '영웅 다시 출격',
    done: '영웅 훈련 완료',
};

function formatCountdown(seconds) {
    const value = Math.max(0, Math.ceil(seconds));
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

function missionGoal(stage) {
    if (stage.volleyGoals) return '1·2·3문 사격으로 수비대 3곳 격파';
    if (stage.mission?.heroLesson)
        return stage.mission.heroLesson.recover ? '출격 · 처치 · 복귀 · 재출격' : '출격해 적 처치';
    if (stage.mission?.surviveMs)
        return `${formatCountdown(stage.mission.surviveMs / 1000)} 버티기 · 본진과 지킬 거점 사수`;
    if (stage.mission?.firstCapture) return '전진 거점 완공';
    return ATTACK_GOAL;
}

function currentGoal(stage, snapshot) {
    if (stage.volleyGoals) return { key: 'volley', label: missionGoal(stage) };
    const mission = snapshot.campaignMission;
    if (stage.mission?.heroLesson) {
        const step = mission?.heroLessonStep ?? 'launch';
        return { key: `hero-${step}`, label: HERO_LESSON_GOALS[step] };
    }
    if (stage.mission?.surviveMs) {
        if (mission?.phase === 'complete') return { key: 'complete', label: '버티기 성공' };
        const count = stage.mission.waves.length,
            wave = (mission?.waveIndex ?? -1) + 1;
        return {
            key: `wave-${wave}`,
            label: wave ? `${wave} / ${count}차 공격` : '공격 대기',
            timerTick: mission?.endTick,
            ...(wave && {
                cue: {
                    title: `${wave}차 공격`,
                    text:
                        wave === count
                            ? '마지막 공격이에요. 끝까지 버티세요!'
                            : '지킬 거점을 막으세요.',
                },
            }),
        };
    }
    if (stage.mission?.firstCapture && !mission?.firstCaptureComplete)
        return { key: 'first-capture', label: '전진 거점 완공' };
    return { key: 'attack', label: ATTACK_GOAL };
}

export class CampaignPresentation {
    static install(find, { openOpening, onOpeningClosed }) {
        this.$ = find;
        this.openOpening = openOpening;
        this.onOpeningClosed = onOpeningClosed;
        const dialog = find('campaignBriefingDialog');
        find('campaignBriefingBack').onclick = () => dialog.close();
        find('campaignBriefingNext').onclick = () => this.advanceBriefing();
        find('campaignBriefingSkip').onclick = () => this.finishBriefing();
        dialog.addEventListener('close', () => {
            if (!dialog.open) {
                this.briefing = null;
                this.closeOpening();
            }
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
        this.closeOpening();
        const { lines, index } = this.briefing;
        const line = lines[index];
        const last = index === lines.length - 1;
        this.$('campaignBriefingSpeaker').textContent = line.speaker;
        this.$('campaignBriefingLine').textContent = line.text;
        this.$('campaignBriefingProgress').textContent = `${index + 1} / ${lines.length}`;
        const next = this.$('campaignBriefingNext');
        next.textContent = last ? '전투 시작' : '다음';
        next.disabled = false;
        this.$('campaignBriefingSkip').hidden = last;
        if (!line.interruptedByLaunch) return;
        if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
            this.$('campaignBriefingLine').textContent = line.interruptedByLaunch;
        } else {
            void this.playOpening(this.briefing, line);
        }
    }

    static async playOpening(briefing, line) {
        const panel = this.$('campaignBriefingScene');
        const next = this.$('campaignBriefingNext');
        const index = briefing.index;
        const current = () =>
            this.briefing === briefing &&
            briefing.index === index &&
            this.$('campaignBriefingDialog').open;
        panel.hidden = false;
        next.disabled = true;
        const finish = () => {
            if (current()) this.advanceBriefing();
        };
        try {
            this.opening = this.openOpening(panel, {
                onLaunch: () => {
                    if (current())
                        this.$('campaignBriefingLine').textContent = line.interruptedByLaunch;
                },
                onComplete: finish,
                onError: finish,
            });
            this.syncOpening();
            await this.opening.ready;
        } catch (error) {
            console.error(error);
            finish();
        }
    }

    static syncOpening() {
        this.opening?.setActive(!document.hidden);
    }

    static closeOpening() {
        const mount = this.opening;
        this.opening = null;
        this.$('campaignBriefingScene').hidden = true;
        if (mount) {
            mount.dispose();
            this.onOpeningClosed();
        }
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
        this.closeOpening();
        this.$('campaignBriefingDialog').close();
        briefing.start();
    }

    static renderBattle(stage, snapshot, tps) {
        if (!stage) {
            this.clearBattle();
            return;
        }
        const tick = snapshot.tick;
        const goal = currentGoal(stage, snapshot);
        const $ = this.$;
        if (this.battle?.stage !== stage || tick < this.battle.tick) {
            this.battle = { stage, goal: goal.key, announced: new Set([goal.key]), cueEnd: 0 };
            $('campaignObjective').classList.remove('hidden');
            $('campaignObjectiveLabel').textContent = goal.label;
            this.showCue('전투 목표', missionGoal(stage), tick, tps);
        } else if (this.battle.goal !== goal.key) {
            this.battle.goal = goal.key;
            $('campaignObjectiveLabel').textContent = goal.label;
            if (!this.battle.announced.has(goal.key)) {
                this.battle.announced.add(goal.key);
                this.showCue(
                    goal.cue?.title ?? '다음 목표',
                    goal.cue?.text ?? goal.label,
                    tick,
                    tps,
                );
            } else {
                this.battle.cueEnd = tick;
            }
        }
        this.battle.tick = tick;
        const timer = $('campaignObjectiveTimer');
        timer.hidden = goal.timerTick == null;
        if (!timer.hidden) {
            const value = `남은 시간 ${formatCountdown((goal.timerTick - tick) / tps)}`;
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
