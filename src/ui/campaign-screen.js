import { SUNSHINE } from '../definitions/roster.js';
import { CAMPAIGN_DECK_LIMIT } from '../definitions/campaign-deck.js';
import { CampaignActs } from './campaign-acts.js';
import { briefGoal, sideGoalBrief } from './campaign-presentation.js';

// The new campaign's screens (고장 카드형, docs/campaign-ux-mockup/b.html):
//   #/campaign/intro                 the world of the campaign before the first stage
//   #/campaign                       home: act 1's row, act 2's region cards, act 3's row (only chapters with stages)
//   #/campaign/<chapter>?stage=<id>  one act or region: its stages as a row of dots and the picked stage's briefing
// Chapter content scrolls when it exceeds the viewport. The header and sortie controls stay in view.
// CampaignActs reads the roster's clear records to determine which stages are open.
const MARKS = Object.freeze([
    ['✓', '클리어', 'firstClear'],
    ['◆', '보조 목표', 'sideGoal'],
    ['★', '어려움으로', 'hardFirstClear'],
]);

// Placeholder captain: a circle with a face, until the captain has art.
export const CAPTAIN_MARKUP =
    '<svg class="cs-captain" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="18"/><circle class="eye" cx="14" cy="17" r="2.4"/><circle class="eye" cx="26" cy="17" r="2.4"/><path d="M13 25q7 6 14 0"/></svg>';

const escape = (text) =>
    String(text).replace(
        /[&<>"]/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
    );

// The story block, in two levels so the main story is the one thing a player keeps: the main story line first and
// large, then a quiet sub block under it (the mission line `brief`, the briefing only, and the commander's tip).
// The result (`result: true`) tells the stage's `after` as the main story when it declares one.
export function storyMarkup(stage, { brief = false, result = false } = {}) {
    const { text, brief: mission, captain, after } = stage.story;
    if (result && after) return `<p class="cs-main">${escape(after)}</p>`;
    const sub = `${brief ? `<p class="cs-brief-line"><b>작전</b><span>${escape(mission)}</span></p>` : ''}<p class="cs-say">${CAPTAIN_MARKUP}<span><b>사령관</b>${escape(captain)}</span></p>`;
    return `<p class="cs-main">${escape(text)}</p><div class="cs-sub">${sub}</div>`;
}

export class CampaignScreen {
    static introRoute = 'intro';

    // actions: the LaunchScreens actions (roster, grainName, portraitSource, startCampaignStage, …);
    // nav: { home(), chapter(id, stageId), title(), finishIntro() } address moves; difficulty(host): draws the difficulty toggle.
    static install({ actions, nav, difficulty }) {
        this.actions = actions;
        this.nav = nav;
        this.difficulty = difficulty;
        this.$ = (id) => document.getElementById(id);
        this.$('campaignScreenBack').onclick = () => this.back?.();
        this.$('campaignScreenUpgradeBtn').onclick = () =>
            this.actions.openCampaignUpgrades(() => this.paintSunshine());
    }

    static show(on) {
        this.$('campaignScreen').classList.toggle('hidden', !on);
    }

    // Draws the screen of one address. Returns false for an address that cannot open (a locked chapter).
    static render(item, query) {
        const roster = this.actions.roster;
        this.cleared = roster.clearedStages;
        this.paintSunshine();
        if (item === this.introRoute) {
            this.renderIntro();
            return true;
        }
        if (!item) {
            this.renderHome();
            return true;
        }
        const chapter = CampaignActs.chapter(item);
        if (!chapter || !CampaignActs.isChapterOpen(chapter, this.cleared)) return false;
        this.renderChapter(chapter, query.get('stage'));
        return true;
    }

    static paintSunshine() {
        this.$('campaignScreenSunshine').textContent = `☀ ${this.actions.roster.sunshine}`;
    }

    static header(title, back) {
        this.$('campaignScreenTitle').textContent = title;
        this.back = back;
    }

    static portrait(type, { freed, size }) {
        return `<img class="cs-portrait${freed ? '' : ' is-blighted'}" style="--s:${size}px" data-portrait="${type}" alt="">`;
    }

    static fillPortraits(host) {
        for (const img of host.querySelectorAll('img[data-portrait]'))
            this.actions.portraitSource(img.dataset.portrait).then(
                (src) => (img.src = src),
                () => {},
            );
    }

    static stageArt(stage) {
        return stage.rewardCard ?? stage.deck[0];
    }

    static clearedCount(chapter) {
        return chapter.stages.filter((stage) => this.cleared.has(stage.id)).length;
    }

    static renderIntro() {
        this.header('캠페인', () => this.nav.title());
        const body = this.$('campaignScreenBody');
        body.className = 'cs-body cs-intro';
        body.innerHTML = `<div class="cs-scroll" role="region" aria-labelledby="csIntroTitle" tabindex="0">
    <section class="cs-brief cs-prologue" aria-labelledby="csIntroTitle">
        <div class="cs-prologue-art" aria-hidden="true">${this.portrait('rice', {
            freed: true,
            size: 96,
        })}${this.portrait('rice', { freed: false, size: 96 })}</div>
        <h3 id="csIntroTitle" class="cs-title">논두렁에 번진 깜부기</h3>
        <p><strong>깜부기는 곡식에 번지는 병이다.</strong> 병에 걸린 곡식들은 깜부기에 지배당해 자기 동료까지 공격한다.</p>
        <p>논두렁에도 깜부기가 번졌다. 정찰병 쌀은 논두렁을 되찾고 동료들을 구하러 나선다.</p>
    </section>
</div>
<div class="cs-go-row"><button type="button" class="launch-btn primary cs-go">캠페인으로</button></div>`;
        this.fillPortraits(body);
        const next = body.querySelector('.cs-go');
        next.onclick = async () => {
            next.disabled = true;
            await this.actions.campaignProgress.readIntroduction();
            if (next.isConnected) this.nav.finishIntro();
        };
    }

    static renderHome() {
        this.header('캠페인', () => this.nav.title());
        const parts = [];
        const regions = CampaignActs.chapters.filter((chapter) => chapter.region);
        for (const chapter of CampaignActs.chapters) {
            if (chapter.region) {
                if (chapter === regions[0]) parts.push(this.regionsMarkup(regions));
                continue;
            }
            parts.push(this.actRowMarkup(chapter));
        }
        const body = this.$('campaignScreenBody');
        body.className = 'cs-body cs-home';
        body.innerHTML = parts.join('');
        for (const button of body.querySelectorAll('[data-chapter]'))
            button.onclick = () => this.nav.chapter(button.dataset.chapter);
        this.fillPortraits(body);
    }

    static actRowMarkup(chapter) {
        const open = CampaignActs.isChapterOpen(chapter, this.cleared);
        if (!open)
            return `<div class="cs-act is-locked"><span class="cs-lock" aria-hidden="true">?</span><div><h3>${chapter.title}</h3><p class="cs-meta">${
                chapter.act === 3 ? '세 고장을 모두 해방하면 열려요' : '앞 막을 해방하면 열려요'
            }</p></div></div>`;
        const done = this.clearedCount(chapter),
            total = chapter.stages.length;
        return `<button type="button" class="cs-act" data-chapter="${chapter.id}"><div><h3>${chapter.title}</h3><p class="cs-meta">${done} / ${total}${
            done === total ? ' · 해방 완료' : ''
        }</p></div><span class="cs-row">${chapter.stages
            .map((stage) =>
                this.portrait(this.stageArt(stage), {
                    freed: this.cleared.has(stage.id),
                    size: 34,
                }),
            )
            .join('')}</span></button>`;
    }

    static regionsMarkup(regions) {
        const roster = this.actions.roster,
            open = CampaignActs.isChapterOpen(regions[0], this.cleared),
            nextPlace = (roster.campaign?.regionOrder.length ?? 0) + 1;
        const cards = regions.map((chapter) => {
            const done = this.clearedCount(chapter),
                total = chapter.stages.length,
                boss = chapter.stages.at(-1),
                place = roster.regionPlace(chapter.id);
            const order = place ? `${place}번째` : `지금 가면 ${nextPlace}번째`;
            return `<button type="button" class="cs-region${done === total ? ' is-freed' : ''}" ${
                open ? `data-chapter="${chapter.id}"` : 'disabled'
            }><span class="cs-band">${chapter.title}</span><span class="cs-blurb">${chapter.region.blurb}</span><span class="cs-boss">${this.portrait(
                this.stageArt(boss),
                { freed: this.cleared.has(boss.id), size: 96 },
            )}</span><span class="cs-prog">${done} / ${total}</span><span class="cs-bar"><i style="width:${
                (done / total) * 100
            }%"></i></span><span class="cs-order">${open ? order : '1막을 해방하면 열려요'}</span></button>`;
        });
        return `<p class="cs-label"><b>2막 · 세 고장</b><span>늦게 가는 고장일수록 적이 세져요</span></p><div class="cs-regions">${cards.join('')}</div>`;
    }

    static renderChapter(chapter, stageId, scrollTop = 0) {
        this.header(chapter.title, () => this.nav.home());
        const stages = chapter.stages,
            picked =
                stages.find((stage) => stage.id === stageId) ??
                CampaignActs.nextIn(chapter, this.cleared) ??
                stages.at(-1);
        const roster = this.actions.roster,
            done = this.clearedCount(chapter);
        const kicker = chapter.region
            ? `2막 · ${roster.regionPlace(chapter.id) || (roster.campaign?.regionOrder.length ?? 0) + 1}번째 고장 · ${done}/${stages.length} 해방`
            : `${chapter.act}막 · ${done}/${stages.length} 해방`;
        const nodes = stages.map((stage, index) => {
            const cleared = this.cleared.has(stage.id),
                open = CampaignActs.isOpen(stage, this.cleared),
                last = chapter.region && index === stages.length - 1;
            return `<button type="button" class="cs-node${cleared ? ' is-done' : ''}${stage === picked ? ' is-picked' : ''}" data-stage="${stage.id}" ${
                open ? '' : 'disabled'
            } aria-label="${index + 1}판 ${escape(stage.title)}${cleared ? ', 해방' : open ? '' : ', 잠김'}"><span class="cs-disc">${this.portrait(
                this.stageArt(stage),
                { freed: cleared, size: 38 },
            )}</span>${cleared ? this.marksMarkup(stage, true) : `<span class="cs-num">${last ? '보스' : index + 1}</span>`}</button>`;
        });
        const body = this.$('campaignScreenBody');
        body.className = 'cs-body cs-chapter';
        body.innerHTML = `<div class="cs-scroll" role="region" aria-label="판 선택과 브리핑" tabindex="0"><p class="cs-kicker">${kicker}</p><div class="cs-track">${nodes.join('')}</div><section class="cs-brief" aria-labelledby="csStageTitle">${this.briefMarkup(
            picked,
            stages.indexOf(picked),
        )}</section></div>
<div class="cs-go-row"><div class="campaign-difficulty" role="group" aria-label="적 난이도"></div><button type="button" class="launch-btn primary cs-go">출격</button></div>`;
        for (const node of body.querySelectorAll('[data-stage]'))
            node.onclick = () => this.nav.chapter(chapter.id, node.dataset.stage);
        this.difficulty(body.querySelector('.campaign-difficulty'));
        const content = body.querySelector('.cs-scroll');
        content.scrollTop = scrollTop;
        const deck = body.querySelector('.cs-deck');
        deck.onclick = () => {
            const previousScrollTop = content.scrollTop;
            this.actions.openCampaignDeck(picked, () => {
                if (!deck.isConnected) return;
                this.renderChapter(chapter, picked.id, previousScrollTop);
                body.querySelector('.cs-deck').focus({ preventScroll: true });
            });
        };
        const launch = body.querySelector('.cs-go');
        launch.disabled = !CampaignActs.isOpen(picked, this.cleared);
        launch.onclick = () => this.actions.startCampaignStage(picked);
        this.fillPortraits(body);
    }

    // The three marks of a stage, in MARKS order: cleared, side goal, hard.
    static marksOf(stage) {
        const roster = this.actions.roster;
        return [
            this.cleared.has(stage.id),
            roster.isSideGoalCleared(stage.id),
            roster.isHardCleared(stage.id),
        ];
    }

    static marksMarkup(stage, small = false) {
        const got = this.marksOf(stage);
        return `<span class="cs-pips${small ? ' is-small' : ''}">${MARKS.map(
            ([glyph, label], i) =>
                `<i class="cs-pip${got[i] ? ' is-on' : ''}" title="${label}">${glyph}</i>`,
        ).join('')}</span>`;
    }

    // The stage's current deck as a row of portraits; it opens the campaign deck editor.
    static deckMarkup(stage) {
        const deck = this.actions.campaignDeckOf(stage);
        return `<button type="button" class="cs-deck" aria-label="이 판의 덱 편성, ${deck.length} / ${CAMPAIGN_DECK_LIMIT}칸"><b>내 덱</b><span class="cs-deck-row">${deck
            .map((type) => this.portrait(type, { freed: true, size: 28 }))
            .join('')}</span><em>${deck.length}/${CAMPAIGN_DECK_LIMIT} ✎</em></button>`;
    }

    static briefMarkup(stage, index) {
        const got = this.marksOf(stage);
        const goals = `<ul class="cs-goals"><li><b>주 목표</b><span>${briefGoal(stage)}</span></li>${
            stage.sideGoal
                ? `<li><b class="is-side">보조</b><span>${sideGoalBrief(stage.sideGoal)}</span></li>`
                : ''
        }</ul>`;
        const reward = stage.rewardCard
            ? `<div class="cs-join">${this.portrait(stage.rewardCard, { freed: got[0], size: 48 })}<span>${
                  got[0] ? '합류함' : '합류'
              }<b>${this.actions.grainName(stage.rewardCard)}</b></span></div>`
            : '';
        const rows = MARKS.map(
            ([glyph, label, key], i) =>
                `<li class="${got[i] ? 'is-got' : ''}"><i class="cs-pip${got[i] ? ' is-on' : ''}">${glyph}</i><span>${label}</span><em>☀ ${SUNSHINE[key]}</em></li>`,
        ).join('');
        return `<div><p class="cs-kicker">${index + 1}판</p><h3 id="csStageTitle" class="cs-title">${escape(stage.title)}</h3></div>
<div class="cs-story">${storyMarkup(stage, { brief: true })}</div>
${goals}
<div class="cs-reward">${reward}<ul>${rows}</ul></div>
${this.deckMarkup(stage)}`;
    }
}
