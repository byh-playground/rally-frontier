import { t, msg } from '../i18n/locale.js';
import { CampaignMission } from '../sim/campaign-mission.js';

const CUE_SECONDS = 3;
const ATTACK_GOAL = '적 본진 파괴';
const BOSS_GOAL = '깜부기에 지배당한 영웅 쓰러뜨리기';
function formatCountdown(seconds) {
    const value = Math.max(0, Math.ceil(seconds));
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

function missionGoal(stage) {
    if (stage.boss) return t('깜부기에 지배당한 영웅 쓰러뜨리기 · 본진 사수');
    if (stage.mission?.surviveMs)
        return msg(
            '{0} 버티기 · 본진과 지킬 거점 사수',
            formatCountdown(stage.mission.surviveMs / 1000),
        );
    if (stage.mission?.firstCapture) return t('전진 거점 완공');
    return t(ATTACK_GOAL);
}

// The main goal on the new campaign's briefing: a stage that asks for the first outpost first still ends on the base.
export function briefGoal(stage) {
    return stage.mission?.firstCapture ? t('전진 거점 짓고 적 본진 파괴') : missionGoal(stage);
}

// The side goal as the briefing states it, before the match (the declaration, campaign.js `sideGoal`).
export function sideGoalBrief(goal) {
    if (goal.kind === 'freeCaptives')
        return goal.count === undefined
            ? t('포로 모두 구하기')
            : msg('포로 {0}명 구하기', goal.count);
    if (goal.kind === 'burnFields') return t('감염 밭 모두 태우기');
    if (goal.kind === 'withinMs') return msg('{0} 안에 이기기', formatCountdown(goal.ms / 1000));
    if (goal.kind === 'lossesAtMost') return msg('병력 손실 {0}명 이하로 이기기', goal.count);
    if (goal.kind === 'allReinforcements') return t('주머니를 모두 깨서 증원 가득 받기');
    return msg(
        goal.point === undefined ? '본진 체력 {0}% 넘게 지키기' : '지킬 거점 체력 {0}% 넘게 지키기',
        Math.round(goal.hpRatio * 100),
    );
}

// The side goal's line under the objective (SideGoal, the snapshot's `sideGoal`): what it asks and how far it is.
function sideGoalLine(goal, tick, tps) {
    const percent = (ratio) => `${Math.round(ratio * 100)}%`;
    let text, detail;
    if (goal.kind === 'freeCaptives') {
        text = msg('포로 구하기 {0}/{1}', goal.freed, goal.need);
    } else if (goal.kind === 'burnFields') {
        text = t('감염 밭 태우기');
        if (goal.blighted) detail = msg('남은 {0}칸', goal.blighted);
    } else if (goal.kind === 'withinMs') {
        text = msg('{0} 안에 이기기', formatCountdown(goal.ms / 1000));
        detail = msg(
            '남은 {0}',
            formatCountdown(
                goal.deadlineTick === null ? goal.ms / 1000 : (goal.deadlineTick - tick) / tps,
            ),
        );
    } else if (goal.kind === 'allReinforcements') {
        text = msg('증원 주머니 {0}/{1}', goal.broken, goal.total);
    } else if (goal.kind === 'lossesAtMost') {
        text = msg('병력 손실 {0}명 이하', goal.count);
        detail = msg('지금 {0}명', goal.lost);
    } else {
        text = msg(
            goal.point === undefined ? '본진 {0} 지키기' : '거점 {0} 지키기',
            percent(goal.hpRatio),
        );
        detail = msg('지금 {0}', percent(goal.hpNow));
    }
    if (goal.status === 'met') return `✓ ${text}`;
    if (goal.status === 'missed') return `✗ ${text}`;
    return detail ? `${text} · ${detail}` : text;
}

function firstShotPractice(stage, snapshot) {
    return stage?.id === 'paddy-first-shot' && snapshot.campaignPractice?.doneTick === null;
}

function currentGoal(stage, snapshot) {
    // A practice (CampaignPractice, the snapshot's `campaignPractice`) comes before every other goal: its cue stays
    // on the battle screen until the last target is down.
    const practice = snapshot.campaignPractice;
    if (practice && practice.doneTick === null)
        return {
            key: 'practice',
            label: msg('써 보기 · 남은 표적 {0}', practice.left),
            cue: firstShotPractice(stage, snapshot)
                ? {
                      title: t('첫 발사'),
                      text: t('표적 쪽을 길게 누르고, 조준 원이 닿으면 떼세요.'),
                  }
                : { title: t('써 보기'), text: t(stage.practice.cue) },
        };
    // The boss (BlightBoss, the snapshot's `blightBoss`): the objective's second line counts the kills left to its
    // awakening, and the awakening is the next goal with its own cue.
    if (stage.boss) {
        const left = snapshot.blightBoss?.untilAwaken ?? 0;
        return left
            ? { key: 'boss', label: t(BOSS_GOAL), detail: msg('각성까지 {0}명', left) }
            : {
                  key: 'boss-awakened',
                  label: t(BOSS_GOAL),
                  detail: t('각성했어요'),
                  cue: {
                      title: t('영웅 각성'),
                      text: t('깜부기 영웅이 각성했어요. 계속 몰아붙이세요!'),
                  },
              };
    }
    const mission = snapshot.campaignMission;
    if (stage.mission?.surviveMs) {
        if (mission?.phase === 'complete') return { key: 'complete', label: t('버티기 성공') };
        const count = stage.mission.waves.length,
            wave = (mission?.waveIndex ?? -1) + 1;
        return {
            key: `wave-${wave}`,
            // A defence whose attacks all come by spore cloud (SporeCloud) has no waves to count.
            label: wave ? msg('{0} / {1}차 공격', wave, count) : t(count ? '공격 대기' : '버티기'),
            // Ticks left on the mission's clock (held while a practice runs).
            timerTicks: mission ? mission.endTick - CampaignMission.clock(snapshot) : null,
            ...(wave && {
                cue: {
                    title: msg('{0}차 공격', wave),
                    text:
                        wave === count
                            ? t('마지막 공격이에요. 끝까지 버티세요!')
                            : t('지킬 거점을 막으세요.'),
                },
            }),
        };
    }
    if (stage.mission?.firstCapture && !mission?.firstCaptureComplete)
        return { key: 'first-capture', label: t('전진 거점 완공') };
    return { key: 'attack', label: t(ATTACK_GOAL) };
}

// The spore clouds under warning, one entry per arrival: the cloud's formations that come on the same tick are one
// place (their mean), with the whole seconds left until its soldiers appear. Shared by the edge alert, the minimap
// ping and the cue line, so all three tell the same thing.
export function sporeCloudAlerts(snapshot, tps) {
    const groups = new Map();
    for (const cloud of snapshot?.sporeCloud?.coming ?? []) {
        const group = groups.get(cloud.arriveTick) ?? {
            x: 0,
            y: 0,
            n: 0,
            arriveTick: cloud.arriveTick,
        };
        group.x += cloud.x;
        group.y += cloud.y;
        group.n++;
        groups.set(cloud.arriveTick, group);
    }
    return [...groups.values()].map((group) => ({
        x: group.x / group.n,
        y: group.y / group.n,
        arriveTick: group.arriveTick,
        seconds: Math.max(0, Math.ceil((group.arriveTick - snapshot.tick) / tps)),
    }));
}

export class CampaignPresentation {
    static openingTargets(stage, snapshot) {
        return firstShotPractice(stage, snapshot)
            ? snapshot.units.filter((unit) => unit.alive !== false && unit.practiceTarget)
            : [];
    }

    static install(find) {
        this.$ = find;
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
            else this.showCue(t('전투 목표'), missionGoal(stage), tick, tps);
        } else if (this.battle.goal !== goal.key) {
            const after = this.battle.goal;
            this.battle.goal = goal.key;
            // The practice is over: the stage's own mission starts now.
            if (after === 'practice') this.showCue(t('전투 목표'), missionGoal(stage), tick, tps);
            else if (!this.battle.announced.has(goal.key)) {
                this.battle.announced.add(goal.key);
                this.showCue(
                    goal.cue?.title ?? t('다음 목표'),
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
                    : msg('남은 시간 {0}', formatCountdown(goal.timerTicks / tps));
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
                this.showCue(
                    t('보조 목표 달성'),
                    sideGoalLine(side, tick, tps).slice(2),
                    tick,
                    tps,
                );
        }
        // The cue line shows the goal's cue while that runs. After it, a spore cloud drifting in (SporeCloud, the
        // snapshot's `sporeCloud.coming`) is announced for as long as any cloud is under warning. The cloud keeps
        // no record of its own: it never uses up a goal's cue.
        // A running practice keeps its own cue on whenever no newer cue runs.
        const shortCue = tick < this.battle.cueEnd,
            goalCue = shortCue || goal.key === 'practice',
            cloudCue = !goalCue && snapshot.sporeCloud?.coming.length > 0;
        if (goalCue || cloudCue) {
            const title = shortCue
                    ? this.battle.cueTitle
                    : goalCue
                      ? goal.cue.title
                      : t('포자 구름'),
                text = shortCue
                    ? this.battle.cueText
                    : goalCue
                      ? goal.cue.text
                      : msg(
                            '포자 구름이 {0}초 뒤 도착해요',
                            Math.min(
                                ...sporeCloudAlerts(snapshot, tps).map((alert) => alert.seconds),
                            ),
                        );
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
