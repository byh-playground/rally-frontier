import { CampaignMission } from '../sim/campaign-mission.js';
import { campaignBriefingLines } from './campaign-copy.js';

const CUE_SECONDS = 3;
const ATTACK_GOAL = '적 본진 파괴';
const BOSS_GOAL = '깜부기에 지배당한 영웅 쓰러뜨리기';
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
    if (stage.boss) return `${BOSS_GOAL} · 본진 사수`;
    if (stage.volleyGoals) return '1·2·3문 사격으로 수비대 3곳 격파';
    if (stage.mission?.heroLesson)
        return stage.mission.heroLesson.recover ? '출격 · 처치 · 복귀 · 재출격' : '출격해 적 처치';
    if (stage.mission?.surviveMs)
        return `${formatCountdown(stage.mission.surviveMs / 1000)} 버티기 · 본진과 지킬 거점 사수`;
    if (stage.mission?.firstCapture) return '전진 거점 완공';
    return ATTACK_GOAL;
}

// The side goal's line under the objective (SideGoal, the snapshot's `sideGoal`): what it asks and how far it is.
function sideGoalLine(goal, tick, tps) {
    const percent = (ratio) => `${Math.round(ratio * 100)}%`;
    let text;
    if (goal.kind === 'freeCaptives') text = `포로 구하기 ${goal.freed}/${goal.need}`;
    else if (goal.kind === 'burnFields')
        text = goal.blighted ? `감염 밭 태우기 · 남은 ${goal.blighted}칸` : '감염 밭 태우기';
    else if (goal.kind === 'withinMs')
        text = `${formatCountdown(goal.ms / 1000)} 안에 이기기 · 남은 ${formatCountdown(
            goal.deadlineTick === null ? goal.ms / 1000 : (goal.deadlineTick - tick) / tps,
        )}`;
    else
        text = `${goal.point === undefined ? '본진' : '거점'} ${percent(goal.hpRatio)} 지키기 · 지금 ${percent(goal.hpNow)}`;
    if (goal.status === 'met') return `✓ ${text.split(' · ')[0]}`;
    if (goal.status === 'missed') return `✗ ${text.split(' · ')[0]}`;
    return text;
}

function currentGoal(stage, snapshot) {
    // A practice (CampaignPractice, the snapshot's `campaignPractice`) comes before every other goal: its cue stays
    // on the battle screen until the last target is down.
    const practice = snapshot.campaignPractice;
    if (practice && practice.doneTick === null)
        return {
            key: 'practice',
            label: `써 보기 · 남은 표적 ${practice.left}`,
            cue: { title: '써 보기', text: stage.practice.cue },
        };
    // The boss (BlightBoss, the snapshot's `blightBoss`): the objective's second line counts the kills left to its
    // awakening, and the awakening is the next goal with its own cue.
    if (stage.boss) {
        const left = snapshot.blightBoss?.untilAwaken ?? 0;
        return left
            ? { key: 'boss', label: BOSS_GOAL, detail: `각성까지 ${left}명` }
            : {
                  key: 'boss-awakened',
                  label: BOSS_GOAL,
                  detail: '각성했어요',
                  cue: { title: '영웅 각성', text: '깜부기 영웅이 각성했어요. 계속 몰아붙이세요!' },
              };
    }
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
            // Ticks left on the mission's clock (held while a practice runs).
            timerTicks: mission ? mission.endTick - CampaignMission.clock(snapshot) : null,
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
        const side = snapshot.sideGoal;
        if (this.battle?.stage !== stage || tick < this.battle.tick) {
            this.battle = {
                stage,
                goal: goal.key,
                announced: new Set([goal.key]),
                sideStatus: side?.status,
                cueEnd: 0,
                cueTitle: '',
                cueText: '',
            };
            $('campaignObjective').classList.remove('hidden');
            if (goal.key === 'practice') this.showCue(goal.cue.title, goal.cue.text, tick, tps);
            else this.showCue('전투 목표', missionGoal(stage), tick, tps);
        } else if (this.battle.goal !== goal.key) {
            const after = this.battle.goal;
            this.battle.goal = goal.key;
            // The practice is over: the stage's own mission starts now.
            if (after === 'practice') this.showCue('전투 목표', missionGoal(stage), tick, tps);
            else if (!this.battle.announced.has(goal.key)) {
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
        if ($('campaignObjectiveLabel').textContent !== goal.label)
            $('campaignObjectiveLabel').textContent = goal.label;
        this.battle.tick = tick;
        // The objective's second line: the survival countdown, or the goal's own detail (the boss's awakening).
        const timer = $('campaignObjectiveTimer'),
            detail =
                goal.timerTicks == null
                    ? goal.detail
                    : `남은 시간 ${formatCountdown(goal.timerTicks / tps)}`;
        timer.hidden = detail == null;
        if (!timer.hidden && timer.textContent !== detail) timer.textContent = detail;
        // The side goal's own line, and a short cue the moment it is met.
        const sideLine = $('campaignObjectiveSide'),
            sideText = side ? sideGoalLine(side, tick, tps) : null;
        sideLine.hidden = sideText == null;
        $('campaignObjective').classList.toggle('has-side', sideText != null);
        const sideValue = $('campaignObjectiveSideText');
        if (sideText != null && sideValue.textContent !== sideText)
            sideValue.textContent = sideText;
        if (side && side.status !== this.battle.sideStatus) {
            this.battle.sideStatus = side.status;
            if (side.status === 'met')
                this.showCue('보조 목표 달성', sideGoalLine(side, tick, tps).slice(2), tick, tps);
        }
        // The cue line shows the goal's cue while that runs. After it, a spore cloud drifting in (SporeCloud, the
        // snapshot's `sporeCloud.coming`) is announced for as long as any cloud is under warning. The cloud keeps
        // no record of its own: it never uses up a goal's cue.
        // A running practice keeps its own cue on whenever no newer cue runs.
        const shortCue = tick < this.battle.cueEnd,
            goalCue = shortCue || goal.key === 'practice',
            cloudCue = !goalCue && snapshot.sporeCloud?.coming.length > 0;
        if (goalCue || cloudCue) {
            const title = shortCue ? this.battle.cueTitle : goalCue ? goal.cue.title : '포자 구름',
                text = shortCue
                    ? this.battle.cueText
                    : goalCue
                      ? goal.cue.text
                      : '포자 구름이 몰려와요';
            if ($('campaignCueTitle').textContent !== title)
                $('campaignCueTitle').textContent = title;
            if ($('campaignCueText').textContent !== text) $('campaignCueText').textContent = text;
        }
        $('campaignCue').classList.toggle('hidden', !goalCue && !cloudCue);
    }

    static showCue(title, text, tick, tps) {
        this.battle.cueEnd = tick + Math.ceil(CUE_SECONDS * tps);
        this.battle.cueTitle = title;
        this.battle.cueText = text;
    }

    static clearBattle() {
        if (!this.battle) return;
        this.battle = null;
        this.$('campaignObjective').classList.add('hidden');
        this.$('campaignCue').classList.add('hidden');
    }
}
