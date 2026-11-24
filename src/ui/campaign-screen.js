import { SUNSHINE } from '../definitions/roster.js';
import { CampaignActs } from './campaign-acts.js';
import { briefGoal, sideGoalBrief } from './campaign-presentation.js';

// The new campaign's screens (고장 카드형, docs/campaign-ux-mockup/b.html):
//   #/campaign                       home: act 1's row, act 2's region cards, act 3's row (only chapters with stages)
//   #/campaign/<chapter>?stage=<id>  one act or region: its stages as a row of dots and the picked stage's briefing
// The page never scrolls: it fits by its layout (smaller pieces on a short screen), and the back button stays at
// the header's top left. Which stage is open comes from CampaignActs; the roster holds what was cleared.
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

// The story block shared by the briefing and the result: the story line, the mission line (`brief`, the briefing
// only: the result has no use for the rules) and the commander's tip, together.
export function storyMarkup(stage, { brief = false } = {}) {
    const { text, brief: mission, captain } = stage.story;
    return `${CAPTAIN_MARKUP}<div><p>${escape(text)}</p>${brief ? `<p class="cs-brief-line">${escape(mission)}</p>` : ''}<p class="cs-say">사령관: “${escape(captain)}”</p></div>`;
}

export class CampaignScreen {
    // actions: the LaunchScreens actions (roster, grainName, portraitSource, startCampaignStage, …);
    // nav: { home(), chapter(id, stageId), title() } address moves; difficulty(host): draws the difficulty toggle.
    static install({ actions, nav, difficulty }) {
        this.actions = actions;
        this.nav = nav;
        this.difficulty = difficulty;
        this.$ = (id) => document.getElementById(id);
        this.$('campaignScreenBack').onclick = () => this.back?.();
    }

    static show(on) {
        this.$('campaignScreen').classList.toggle('hidden', !on);
    }

    // Draws the screen of one address. Returns false for an address that cannot open (a locked chapter).
    static render(item, query) {
        const roster = this.actions.roster;
        this.cleared = roster.clearedStages;
        this.$('campaignScreenSunshine').textContent = `☀ ${roster.sunshine}`;
        if (!item) {
            this.renderHome();
            return true;
        }
        const chapter = CampaignActs.chapter(item);
        if (!chapter || !CampaignActs.isChapterOpen(chapter, this.cleared)) return false;
        this.renderChapter(chapter, query.get('stage'));
        return true;
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

    static renderChapter(chapter, stageId) {
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
        body.innerHTML = `<p class="cs-kicker">${kicker}</p><div class="cs-track">${nodes.join('')}</div><section class="cs-brief" aria-labelledby="csStageTitle">${this.briefMarkup(
            picked,
            stages.indexOf(picked),
        )}</section>`;
        for (const node of body.querySelectorAll('[data-stage]'))
            node.onclick = () => this.nav.chapter(chapter.id, node.dataset.stage);
        this.difficulty(body.querySelector('.campaign-difficulty'));
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
<div class="cs-go-row"><div class="campaign-difficulty" role="group" aria-label="적 난이도"></div><button type="button" class="launch-btn primary cs-go">출격</button></div>`;
    }
}
