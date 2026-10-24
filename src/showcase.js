import { installShowcase } from 'https://cdn.jsdelivr.net/gh/byh-playground/bloom-gamekit@cdf99b6b960d0e26b9162bb24b773acbc6632835/scenario.js';
const SHOWCASE = installShowcase({
    title:'랠리 프론티어',
    launcher:'#gameStartBtn',
    playSelector:'#gameStartBtn',
    durationMs:28000,
    ready:win=>{
      const node=win.document.getElementById('bootGate');
      return !!node && (node.classList.contains('hidden') || win.getComputedStyle(node).display==='none');
    },
    timeline:[
  {
    "atMs": 0,
    "action": "chapter",
    "index": 0,
    "title": "살아 움직이는 세 개의 전선",
    "caption": "병종을 구성하고 자동 전투를 지휘하는 실시간 전략 게임입니다."
  },
  {
    "atMs": 650,
    "action": "click",
    "selector": "#gameStartBtn"
  },
  {
    "atMs": 1400,
    "action": "click",
    "selector": "#advancedTestSettings > summary"
  },
  {
    "atMs": 1900,
    "action": "select",
    "selector": "#battleTestUnitCount",
    "value": "100"
  },
  {
    "atMs": 2600,
    "action": "click",
    "selector": "#battleTestStartBtn"
  },
  {
    "atMs": 8200,
    "action": "chapter",
    "index": 1,
    "title": "다수의 유닛이 벌이는 실시간 전투",
    "caption": "실제 시뮬레이션의 근접·원거리 병력과 충돌을 보여줍니다."
  },
  {
    "atMs": 17200,
    "action": "chapter",
    "index": 2,
    "title": "유닛을 조합해 전황을 바꾸기",
    "caption": "병종 조합과 전술에 따라 전투 결과가 달라집니다."
  }
]
});

// Restore direct introduction links after the game's own menu router has booted.
if (window.__BLOOM_SHOWCASE_DEEPLINK && SHOWCASE) {
    window.addEventListener('load', () => SHOWCASE.open(), { once: true });
}
