/**
 * 디버그 모드 첫 화면(`?debug=1`): 확인 화면의 목록. 항목은 주소 링크일 뿐이고 진입 방식의 원본은 URL 하나다.
 * 타이틀의 설정 버튼을 길게 누르면 이 주소로 온다. 일반 실행에서는 불러오지 않는다.
 */
import { useDebugStyle } from './debug-style.js';

const PAGES = Object.freeze([
    {
        query: 'debug=1&board=motion',
        title: '병종 동작 디스플레이',
        note: '개편 전과 지금의 동작·전투 이펙트를 나란히 실시간으로 봅니다.',
    },
]);

export function openDebugMenu() {
    useDebugStyle();
    const page = document.createElement('div');
    page.className = 'motion-board debug-menu';
    const back = document.createElement('a');
    back.className = 'mb-back';
    back.href = location.pathname;
    back.textContent = '‹ 게임으로';
    const title = document.createElement('h1');
    title.textContent = '디버그 모드';
    page.append(back, title);
    for (const entry of PAGES) {
        const link = document.createElement('a');
        link.className = 'mb-entry';
        link.href = `${location.pathname}?${entry.query}`;
        const name = document.createElement('b'),
            note = document.createElement('span');
        name.textContent = entry.title;
        note.textContent = entry.note;
        link.append(name, note);
        page.append(link);
    }
    document.body.append(page);
}
