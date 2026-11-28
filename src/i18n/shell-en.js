// Static launch, battle, and help copy from index.html.
export default {
    언어: 'Language',
    '쌀콩팡!': 'Rice, Beans & Boom!',
    '쌀콩팡! | Rice, Beans & Boom!': 'Rice, Beans & Boom!',
    '쌀·콩·팥 병사를 대포로 쏘아 거점을 차지하는 실시간 전략 게임':
        'A real-time strategy game where you fire rice and bean soldiers from cannons to capture outposts.',
    '대포에서 날아가는 쌀과 콩 병사': 'Rice and bean soldiers flying out of a cannon',
    '대포에서 날아가는 쌀과 콩 병사의 정사각형 그림':
        'Square illustration of rice and bean soldiers flying out of a cannon',
    '게임 오류': 'Game error',
    '새로고침으로 다시 시도해 주세요. 같은 오류가 반복되면 진단 정보를 복사해 알려 주세요.':
        'Reload the game to try again. If the error persists, copy the diagnostic report and send it to us.',
    새로고침: 'Reload',
    '진단 정보 복사': 'Copy diagnostics',
    '전체 선택': 'Select all',
    '게임을 준비합니다.': 'Getting the game ready…',
    '다시 불러오기': 'Reload game',
    '쌀콩팡! 앱 설치': 'Install Rice, Beans & Boom!',
    '설치 안내 닫기': 'Close install guide',
    '설치 버튼이 바로 동작하지 않으면':
        "If the install button doesn't work, the easiest option is to",
    'Chrome 메뉴에서 직접 설치': 'install directly from the Chrome menu',
    '하는 방법이 가장 확실합니다.': '.',
    'Chrome에서 현재 게임 페이지를 엽니다.': 'Open this game page in Chrome.',
    '카카오톡·ChatGPT·기타 앱 안의 내장 브라우저가 아니라 Android Chrome에서 여세요.':
        'Use Chrome for Android. In-app browsers in KakaoTalk, ChatGPT, and other apps may not support installation.',
    'Chrome 우측 상단의 ⋮ 메뉴를 누릅니다.': 'Tap the ⋮ menu in the top-right corner of Chrome.',
    '「앱 설치」 또는 「쌀콩팡! 설치」를 누릅니다.':
        'Tap “Install app” or “Install Rice, Beans & Boom!”',
    '「홈 화면에 추가」만 보이고 브라우저 링크 아이콘만 생기면 실제 PWA 설치가 아닐 수 있습니다.':
        '“Add to Home screen” may create only a browser shortcut.',
    '설치 확인 창에서 「설치」를 누릅니다.': 'Tap “Install” to confirm.',
    '홈 화면의 쌀콩팡! 아이콘으로 실행합니다.': 'Open Rice, Beans & Boom! from the Home screen.',
    '주소창 없이 독립 앱 화면으로 열리면 정상 설치된 것입니다.':
        'If the game opens on its own without an address bar, installation worked.',
    팁: 'Tip',
    'Chrome 메뉴에 「앱 설치」가 보이면 브라우저가 이 사이트를 PWA로 인식하고 있는 상태입니다.':
        'When “Install app” appears in the Chrome menu, Chrome recognizes the game as an installable web app.',
    확인: 'OK',
    'P2P 연결됨': 'P2P connected',
    '성능·동기화 진단': 'Performance and sync diagnostics',
    '성능 시간 지표 · ms': 'Performance timings (ms)',
    '현재 / 평균(EWMA) / 최대. Step 전체는 매 틱, 세부 단계는 1초 주기 표본입니다. 서로 포함되는 구간은 합산하지 않습니다. RTT에는 양쪽 브라우저의 메시지 처리 대기가 포함됩니다.':
        'Current / average (EWMA) / max. Total step time is measured every tick. Detailed timings are sampled once per second. Some measurements overlap. Game-message RTT includes time spent waiting for both browsers to process a message.',
    '게임 메시지 RTT / 지터': 'Game-message RTT / jitter',
    '입력 지연 설정 · 틱 → ms': 'Input delay setting · ticks → ms',
    '명령 접수 → 확정 · 실측': 'Measured time from command receipt to confirmation',
    '미확정 명령 · 최장 대기': 'Unconfirmed commands · longest wait',
    'WebRTC 연결 RTT · ICE': 'WebRTC RTT · ICE',
    '메인 스레드 timer 지연': 'Main-thread timer delay',
    '긴 작업 · 50ms 이상': 'Long tasks · 50 ms or more',
    '세션 호출 간격': 'Session call interval',
    '세션 전체 · 저장 / 해시 / 출력 포함': 'Total session time · includes save, hash, and output',
    'Sim step 현재 / EWMA / 최대': 'Sim step · current / EWMA / max',
    '싱글 반대 역할 Sim step': 'Solo opponent sim step',
    '상태 저장 · 복제 + encode': 'Save state · copy + encode',
    'Core 재실행 최근 / 평균': 'Core resimulation · latest / average',
    '수동 Synctest 실행 · 양보 제외': 'Manual Synctest time · excludes yielded time',
    '표시 Snapshot 현재 / 최대': 'Display snapshot · current / max',
    '표시 갱신 · Render targets / UI': 'Display update · render targets / UI',
    '프레임 간격': 'Frame interval',
    'GPU 프레임 시작 · CPU 대기': 'GPU frame start · CPU wait',
    '고정 흐름장 / 추격 흐름장 / 흐름장 생성 시간 · 누적':
        'Fixed / chase flow fields / total build time',
    '직선 경로 성공 / 경로 조회 · 누적': 'Successful straight paths / total path queries',
    '틱 허용시간': 'Tick budget',
    '사용시간 · step EWMA': 'Time used · step EWMA',
    '남은 틱 여유 · 추정': 'Estimated tick time remaining',
    '틱 여유는 게임 step만 계산합니다. 저장·Core·렌더를 함께 확인하세요. 충돌 내부 시간과 이웃 수는 초당 상세 표본 틱에서 측정합니다. Core 내부 해시 시간은 공개 계측이 없어 전체 처리에 포함합니다. GPU 시작 시간은 CPU 호출 대기입니다.':
        'Remaining tick time accounts only for the game step. Check save, Core, and rendering times too. Collision timings and neighbor counts come from the detailed sample taken once per second. Core hash time is included in the total. GPU start time measures CPU wait.',
    '성능 시간 지표 JSON 저장': 'Export timing JSON',
    '확정된 실제 입력의 시작 구간을 최대 32틱 검사합니다. 공통 Synctest가 같은 Adapter를 별도 시뮬레이션에서 저장·복원·재실행하며, 온라인 동기화와 다른 기기의 결정론까지 보장하지 않습니다. 검사 틱 사이에는 게임과 네트워크 처리를 계속합니다.':
        'Run a Synctest on up to the first 32 ticks of confirmed input. It saves, restores, and reruns the same adapter in a separate simulation. The game and network keep processing between test ticks. This check covers the local simulation.',
    '확정 입력 Synctest 실행': 'Run confirmed-input Synctest',
    'Synctest 상태': 'Synctest status',
    '검사한 틱': 'Ticks tested',
    '재실행한 틱': 'Ticks rerun',
    '재실행 거리': 'Resimulation span',
    '검사 상태 해시': 'Test state hash',
    '보관 상태 크기': 'Saved state size',
    '최초 불일치': 'First mismatch',
    '예측 틱 / 늦은 입력 비율(EMA)': 'Predicted ticks / late-input rate (EMA)',
    '이력 bytes / 상태 hash 계산': 'History bytes / state hash computations',
    'Core 상태 / 확정 tick': 'Core status / confirmed tick',
    '입력 지연 / rollback / 재실행': 'Input delay / rollbacks / resimulation',
    '해시 불일치 / 복구 / 후보 거부': 'Hash mismatches / recoveries / candidate rejections',
    '송신 / 수신 bytes': 'Bytes sent / received',
    '유닛 생존 / 전투 / 투사체': 'Units alive / in combat / projectiles',
    'Spatial query / 후보(평균)': 'Spatial queries / average candidates',
    'Target / Visibility 검사': 'Target / visibility checks',
    '접촉 벽·건물 / 몸-몸 / 예산 초과 / 묶음 / cast':
        'Contacts · terrain and buildings / units / over budget / batches / casts',
    '충돌 ms · 접촉 풀이 / 기타 · 겹침 풀기 아군 / 적':
        'Collision ms · contact resolution / other · friendly / enemy overlap resolution',
    '전투 ms · 주 대상 선택 / 기타 · 대상 선택 calls':
        'Combat ms · main target selection / other · target selection calls',
    'Render draw calls / 업로드 bytes': 'Render draw calls / bytes uploaded',
    '엔티티 peak 유닛 / 건물 / 투사체': 'Peak entities · units / buildings / projectiles',
    '경기 시간 / 종료': 'Match time / end',
    '첫 PvP 교전': 'First PvP engagement',
    '첫 점령 · Host / Guest': 'First capture · Host / Guest',
    '병력 현재 / 평균 / 최대 · H/G': 'Troops · current / average / max · H/G',
    '건물 손실 / 전진거점 손실 · H/G': 'Buildings lost / outposts lost · H/G',
    '동일 복구': 'Run recovery again',
    '보정 로그 JSON 저장': 'Export correction log JSON',
    '밸런스 계측 JSON 저장': 'Export balance telemetry JSON',
    '진단 Synctest 결과 지우기': 'Clear Synctest results',
    설정: 'Settings',
    쌀콩: 'Rice, Beans & ',
    '팡!': 'Boom!',
    '곡식 병사를 대포로 쏘아 적 본진을 무너뜨려라':
        'Fire grain soldiers from your cannons and destroy the enemy base.',
    '대전 시작': 'Start Battle',
    '덱 편성': 'Edit Deck',
    '친구와 대전': 'Play with a Friend',
    리플레이: 'Replay',
    '⬇ 앱으로 설치': '⬇ Install App',
    '설치 가능한 경우 표시됩니다': 'Appears when installation is available',
    '앱 설치 안내': 'App Install Guide',
    '이 빌드의 마지막 업데이트 시각': 'When this build was last updated',
    '다시 시도': 'Try again',
    뒤로: 'Back',
    햇살: 'Sunshine',
    강화: 'Upgrades',
    '캠페인 전용': 'Campaign only',
    '병종 강화': 'Unit Upgrades',
    '병종 강화 닫기': 'Close unit upgrades',
    '햇살로 열면 캠페인에서 늘 적용돼요. 대전에는 영향이 없어요.':
        'Unlock with Sunshine to use these upgrades in every campaign battle. Versus matches use standard units.',
    '병종 강화 목록': 'Unit upgrade list',
    완료: 'Done',
    '캠페인 전용 덱': 'Campaign Deck',
    '캠페인 덱 닫기': 'Close campaign deck',
    '이 판에서만 쓰는 덱이고 대전 덱과 따로 저장돼요. ★는 열어 둔 캠페인 강화예요. 필수 카드는 뺄 수 없어요.':
        'This deck is used for this stage and saved separately from your versus deck. ★ marks an unlocked campaign upgrade. Required cards stay in your deck.',
    '캠페인 덱': 'Campaign deck',
    '카드 목록': 'Cards',
    '추천 덱으로': 'Restore recommended deck',
    '나만의 전투 준비': 'Build your battle deck',
    '덱 편성 닫기': 'Close deck editor',
    '영웅은 최대 한 명을 넣을 수 있어요. 원하는 빈 칸을 먼저 누르면 그 자리에 카드를 넣을 수 있어요.':
        'You can bring up to one hero. Tap an empty slot first to add a card there.',
    '덱 선택': 'Select deck',
    '현재 덱': 'Current deck',
    '눌러서 추가하거나 제외': 'Tap to add or remove',
    '카드 목록 분류': 'Card categories',
    'shell/영웅': 'Heroes',
    'shell/병사': 'Soldiers',
    '영웅 목록': 'Hero list',
    '병사 목록': 'Soldier list',
    '카드 상세': 'Card details',
    '방 만들기': 'Create Room',
    '네트워크를 준비하고 있습니다.': 'Connecting…',
    '상대에게 이 코드를 알려주세요': 'Share this code with your opponent',
    '상대가 참가하면 선택한 유닛 선택 방식으로 경기가 준비됩니다.':
        'When your opponent joins, the match uses your selected deck option.',
    '방 참가': 'Join Room',
    '상대가 알려준 4자리 방 코드를 입력하세요.': 'Enter the 4-digit room code from your opponent.',
    '4자리 방 코드': '4-digit room code',
    '경기 메뉴 열기': 'Open match menu',
    '나 ♥ 100%': 'You ♥ 100%',
    '적 ♥ 100%': 'Enemy ♥ 100%',
    목표: 'Objective',
    미니맵: 'Minimap',
    '적 본진': 'Enemy base',
    '발사 카드': 'Launch cards',
    '자원 보유량': 'Resources',
    '쌀 최대 발사 500': 'Rice max range 500',
    '사거리 ×1 → ×2': 'Range ×1 → ×2',
    '리플레이 조작': 'Replay controls',
    '이동할 시간': 'Time to seek to',
    이동: 'Go',
    종료: 'Exit',
    '리플레이 타임라인': 'Replay timeline',
    '재생 조작': 'Playback controls',
    '5초 뒤로': 'Back 5 seconds',
    '5초 앞으로': 'Forward 5 seconds',
    '리플레이 속도': 'Replay speed',
    '리플레이 시야': 'Replay visibility',
    'HOST 시야': 'Host vision',
    'GUEST 시야': 'Guest vision',
    '양쪽 시야': 'Both sides',
    '화면 방향': 'View orientation',
    'HOST 방향': 'Host side',
    'GUEST 방향': 'Guest side',
    '리플레이 줌': 'Replay zoom',
    '리플레이 축소': 'Zoom out',
    '리플레이 확대': 'Zoom in',
    '다음 전투': 'Next Battle',
    '다시 대전': 'Rematch',
    타이틀: 'Title Screen',
    '덱에 넣기': 'Add to Deck',
    '병종별 전투 기록': 'Combat Stats by Unit',
    '출격은 실제 등장한 병사, 처치는 적 병사 기준입니다. 피해는 실제 감소한 체력이며 병사와 해당 병종의 투입 포탄을 함께 집계합니다. 건물 자체 공격은 제외합니다.':
        'Deployments count soldiers who entered the battlefield. Kills count defeated enemy soldiers. Damage is HP lost to each unit type and its shells. Building attacks are excluded.',
    병종: 'Unit',
    'shell/출격': 'Deployed',
    처치: 'Kills',
    피해: 'Damage',
    '연결이 끊긴 시점까지 확인된 기록입니다.':
        'Stats through the last confirmed moment before the disconnect.',
    '⇩ 리플레이 저장': '⇩ Save Replay',
    '방을 만들어 코드를 보내거나, 받은 코드를 입력하세요.':
        'Create a room and share your code, or enter a code you received.',
    '내 출전 덱': 'My Deck',
    '본인 덱': 'Use My Deck',
    '랜덤 덱': 'Random Deck',
    '랜덤 덱은 보유 카드와 관계없이 선택하며, 경기 시작 후 확인할 수 있어요.':
        "A random deck can include any card. You'll see your deck when the match starts.",
    코드: 'Code',
    참가: 'Join',
    '음악 끄기': 'Mute Music',
    '효과음 끄기': 'Mute Sound Effects',
    '하는 법': 'How to Play',
    '목표와 조작': 'Goal and Controls',
    '덱에서 병사를 골라 출전하고, 적 본진을 부수면 승리해요. 잠긴 카드는 캠페인에서 그 카드가 합류하는 판을 처음 깨면 덱에 넣을 수 있어요.':
        'Choose soldiers from your deck and destroy the enemy base to win. To unlock a card, clear the campaign stage where that unit joins you.',
    '화면 이동과 무승부': 'Camera and Draws',
    '경기는 아군 본진에서': 'The match starts at your base at',
    '확대 상태로 시작해요. 드래그로 전장을 이동하고, PC 휠이나 모바일 두 손가락으로 최대':
        'zoom. Drag to pan, then use the mouse wheel or a two-finger pinch to zoom up to',
    '까지 확대할 수 있어요. 양쪽 본진이 같은 순간 파괴되면 무승부예요.':
        '. If both bases are destroyed at the same time, the match is a draw.',
    '대포 발사': 'Firing Cannons',
    '카드를 고르고 전장을 길게 누른 뒤 손을 떼면 그 방향으로 발사해요. 오래 누를수록 멀리 날아가요.':
        'Choose a card, hold down on the battlefield, then release to fire in that direction. Hold longer to launch farther.',
    '카드 탄약': 'Card Ammo',
    '덱의 카드는 모두 언제든 고를 수 있지만 카드마다 탄약이 있어요. 한 번 쏠 때마다 1발을 쓰고, 다 쓰면 한 발씩 다시 찰 때까지 기다려야 해요. 식량만 쓰는 카드는 3발, 기름을 쓰는 카드는 2발이고 둘 다 한 발 5초예요. 일제사격도 1발만 써요. 영웅은 탄약이 없어요.':
        'Every card is available to select, and each launch spends one round from that card. Food-only cards hold 3 rounds. Cards that use oil hold 2. Both regain one round every 5 seconds. A volley still costs one round. Heroes use no ammo.',
    '여러 대포로 일제사격': 'Multi-Cannon Volleys',
    '같은 조준점에 닿는 준비된 아군 대포는 최대 세 문까지 함께 쏴요. 한 묶음 값으로 병력을 나눠 싣고, 대포마다 그 병종의 발사 방식을 써요. 두 문이 쏘면 병력 20%, 세 문이면 40%가 더 나와요. 포탄 하나의 체력과 착탄 피해는 단독 발사 때와 같아요.':
        "Up to three ready friendly cannons can fire at the same aim point. One launch pays for the whole volley, with soldiers split among its cannons. Each cannon uses that unit's firing pattern. Two cannons deploy 20% more soldiers, and three deploy 40% more. Each shell keeps its usual HP and impact damage.",
    '사거리와 과열': 'Range and Overheating',
    '대포 주위의 옅은 원은 선택한 병종의 최대 사거리, 흰 원은 착탄 범위예요. 너무 오래 누르면 과열되고, 적이나 지형에 먼저 닿으면 그곳에서 터져요.':
        "The faint ring around a cannon shows the selected unit's max range. The white ring shows the impact area. Hold too long and the cannon overheats. Shells burst on the first enemy or terrain they hit.",
    '포탄 격추와 비상 착지': 'Intercepting Shells and Emergency Landings',
    '아군 투입탄은 날아가는 동안 주변 시야를 밝혀요.':
        'Friendly shells reveal their surroundings in flight.',
    '투입탄은 병종마다 체력이 달라요. 본진·전진 거점의 포탑과 옥수수·밤톨·해바라기씨·바나나·포도는 사거리 안에 보이는 적 투입탄부터 공격해요. 쌀처럼 여러 발로 갈라지는 투입탄은 한 발씩 피해를 받아요.':
        'Shell HP varies by unit. Base and outpost turrets, Corn, Chestnuts, Sunflower Seeds, Banana, and Grape prioritize visible enemy shells within range. Split volleys like Rice take damage shell by shell.',
    '해바라기씨는 멈춰서 씨앗탄을 연사해요. 적 투입탄에는 지상 공격의 두 배 피해를 줘요.':
        'Sunflower Seeds stand still and fire bursts of seeds. They deal twice their ground damage to enemy shells.',
    '격추된 탄은 아래로 떨어져 병력을 내려요. 정상 착탄 폭발은 일어나지 않고, 병력은 떨어진 높이에 따라 남은 체력의 최대 절반만큼 피해를 받아요.':
        'A downed shell drops its soldiers. The impact explosion is lost, and soldiers take fall damage of up to half their remaining HP, depending on the drop height.',
    '나는 병종': 'Flying Units',
    '민들레씨는 투입된 뒤 한 번만 솜털로 떠올라 벽·절벽·건물을 넘어 적에게 곧장 날아가요. 적이 공격 사거리에 들어오면 그 자리에 내려앉고, 다시는 뜨지 않아요.':
        'After deployment, Dandelion Seeds take off once and fly directly toward the enemy over walls, cliffs, and buildings. They land as soon as the enemy is in attack range and stay on the ground after that.',
    '나는 동안에는 공격하지 않고, 지상 공격·폭발·넉백도 닿지 않아요. 적 투입탄을 쏘는 포탑과 병종, 그리고 목화솜의 번개만 나는 병종을 맞혀요(투입탄을 쏘는 쪽은 투입탄을 먼저 쏴요). 공중에서 쓰러지면 그 자리에서 떨어져요.':
        "Flying units can't attack while airborne. Ground attacks, explosions, and knockback can't reach them. Turrets and units that can intercept shells can shoot down flying units, but target shells first. Cotton can also hit flying units with lightning. Flying units fall if defeated midair.",
    '번개 잇는 병종': 'Chain Lightning',
    '목화솜은 멈춰 서서 사거리 안의 적에게 번개를 걸고, 그 적에서 가장 가까운 적으로 번개가 튀어 최대 넷을 한 줄로 이어요. 1초 동안 0.2초마다 이어진 적 모두에게 같은 피해를 주고, 1초 쉬었다가 다시 이어요.':
        'Cotton stops and links lightning to the nearest enemies in range, jumping from one to the next and chaining up to four. All linked enemies take equal damage every 0.2 seconds for one second. Cotton rests for one second before starting another chain.',
    '이어진 적이 쓰러지거나 멀어지면 그 고리부터 끊기고 근처의 다른 적에게 다시 이어요. 나는 적에도 닿아 땅과 하늘 사이를 오가며 튀지만 투입탄은 맞히지 못해요. 건물에는 절반만 들어가고, 아군은 맞지 않아요. 넘어지면 번개가 끊기고 1초를 다시 기다려요.':
        'When a linked enemy dies or moves away, the chain breaks at that point and reconnects to a nearby enemy. Lightning jumps between ground and airborne enemies, deals half damage to buildings, and leaves allies and shells untouched. If Cotton is knocked down, the chain breaks and its one-second rest starts over.',
    '불 뿜는 병종': 'Fire Breath',
    '고추는 멈춰 서서 앞쪽으로 길고 좁은 불줄기를 1초 동안 뿜고, 1초 쉬었다가 다시 뿜어요. 불줄기 안의 적은 모두 함께 타고, 고추 셋이 겹치면 그만큼 더 뜨거워요. 한 번 뿜기 시작하면 적이 쓰러져도 1초를 다 뿜어요.':
        'Chili Peppers stop and breathe a long, narrow stream of fire for one second, then rest for one second. Every enemy in the stream burns, and overlapping streams deal damage together. Peppers finish the full burst even if their target dies.',
    '방향은 천천히 돌려요. 벽·절벽 너머와 나는 적, 투입탄에는 닿지 않고, 건물에는 절반만 들어가요. 아군은 타지 않아요.':
        "Peppers turn slowly. Their flames stop at walls and cliffs, pass through allies, and can't hit flying units or shells. Buildings take half damage.",
    '영웅 카드': 'Hero Cards',
    '영웅과 병사를 합쳐 덱에 최대 여덟 장을 넣을 수 있어요.':
        'Your deck can hold up to eight cards total. Only one of',
    '중 영웅은 한 명까지 넣을 수 있어요. 영웅은 무료로 발사할 수 있고, 전사한 영웅은 그 경기에서 다시 출격할 수 없어요.':
        "can join your deck. Heroes launch for free. A fallen hero can't redeploy during the same match.",
    '영웅 레벨': 'Hero Levels',
    '영웅이 마지막 일격으로 쓰러뜨린 적 병력 한 명마다 처치 수가 1 올라요. 처치 10·25·45·70·100명에 2~6레벨이 되며, 카드에 레벨과 다음 레벨까지의 처치 수가 보여요. 회수하면 레벨이 그대로 남고, 전사하면 그 경기에서 사라져요.':
        'Heroes earn a kill for each enemy soldier they land the final blow on. They reach levels 2–6 at 10, 25, 45, 70, and 100 kills. Their card shows their current level and progress toward the next. Recalled heroes keep their level. Fallen heroes leave the match.',
    '레벨마다 체력 +20%, 공격 +10%가 1레벨 값에 더해져요. 6레벨이면 체력 2배, 공격 1.5배예요. 레벨이 오르는 순간 늘어난 최대 체력만큼 지금 체력도 차요.':
        'Each level adds 20% of level 1 HP and 10% of level 1 attack. At level 6, heroes have double HP and 1.5× attack. Leveling up also heals them by the increase in max HP.',
    '2레벨: 영웅마다 막타 효과가 켜져요. 수박은 체력 회복, 바나나는 다음 평타가 바로 금빛 부메랑, 포도는 근처 적에게 튀는 포도알이에요.':
        "Level 2 grants an effect on the final blow. Watermelon heals, Banana's next basic attack becomes an immediate golden boomerang, and Grape sends a bouncing grape toward a nearby enemy.",
    '3레벨: 늘 켜진 패시브가 생겨요. 수박은 피해 50마다 튀는 씨앗, 바나나는 돌아오는 부메랑의 2배 피해, 포도는 곡사탄 자리에 남는 포도즙이에요.':
        "Level 3 grants a passive effect. Watermelon fires bouncing seeds for every 50 damage taken. Banana's returning boomerang deals double damage. Grape leaves grape juice where their lobbed shots land.",
    '4레벨: 영웅 둘레 150 안의 아군이 버프를 받고 발밑에 고리가 보여요. 수박은 받는 피해 25% 감소, 바나나는 이동 속도 1.3배, 포도는 1초마다 체력 2% 회복이에요.':
        'At level 4, friendly units within 150 of a hero gain a buff and display a ring beneath them. Watermelon reduces damage taken by 25%. Banana raises movement speed to 1.3×. Grape restores 2% HP each second.',
    '진격과 복귀': 'Advance and Recall',
    '발사하면 ON 상태로 진격해요. 카드를 짧게 탭하면 OFF 상태로 바뀌어 가장 가까운 도달 가능한 아군 본진이나 완공된 전진 거점으로 돌아가요. 도착 전에 다시 누르면 진격을 재개해요. 살아서 회수하면 체력이 서서히 차오르고, 현재 체력으로 다시 무료 발사할 수 있어요.':
        'Launching a hero switches the card ON and sends the hero forward. Tap the card to switch it OFF and recall the hero to the nearest reachable friendly base or completed outpost. Tap again before the hero arrives to resume the advance. Recalled heroes recover HP over time and can launch again for free with their current HP.',
    '자원과 강화': 'Resources and Upgrades',
    '본진과 확보한 거점에서 식량과 기름을 계속 생산해요. 자원은 병력 투입과 사거리 강화에 써요.':
        'Your base and captured outposts produce food and oil. Spend resources on troops and cannon range upgrades.',
    '식량·기름 거점과 사거리 강화': 'Food and Oil Outposts, Range Upgrades',
    '기본 대전에서는 본진이 초당 식량 15, 파란 ◆ 식량 거점이 초당 식량 5를 생산해요. 금색 ✦ 기름 거점은 식량과 기름을 초당 2.5씩 생산해요.':
        'In a standard versus match, your base makes 15 food per second and blue ◆ food outposts make 5. Gold ✦ oil outposts make 2.5 food and 2.5 oil per second.',
    '기름을 먼저 쓰고 싶다면 사거리를 한 번 강화하고 본진에서 미니맵의 가까운 금색 ✦를 향해 쌀을 쏘세요. 맵 가운데나 길목의 ✦는 양쪽이 다투는 기름 거점이라, 차지하면 기름을 더 빨리 모아요. 중앙으로 진격할 때는 식량 거점을 확보해 다음 병력을 준비하세요.':
        'To get oil early, buy a range upgrade and launch Rice from your base toward the nearest gold ✦ on the minimap. Both sides compete for gold ✦ outposts in the center and at chokepoints. Capture one to earn oil faster. Secure food outposts as you advance to fund your next troops.',
    '거점이 실제 지급한 자원이 정상 생산량의 2분치를 넘으면 효율이 내려가요. 5분치를 지급한 뒤에도 절반을 계속 생산하고, 점령자가 바뀌어도 같은 효율을 이어받아요. 초당 수입의 소수분은 모아서 정수 단위로 지급해요.':
        "An outpost's efficiency declines once it has paid out two minutes' worth of resources. After paying out five minutes' worth, it keeps producing at half rate. Efficiency carries over when ownership changes. Fractional income accumulates until it can pay out whole resources.",
    '식량 500으로 시작하며 자원은 각각 최대 500까지 모아요. 보유량이 가득 찬 자원은 쓰고 나면 다시 생산해요. 옥수수처럼 기름 비용이 있는 병종과 사거리 4·5단계 강화에는 식량과 기름이 모두 필요해요.':
        'You start with 500 food. Each resource caps at 500 and starts accumulating again once you spend some. Units such as Corn and range upgrades 4 and 5 cost both food and oil.',
    '대포가 거점까지 닿지 않아도 가까이 쏘면 병력이 걸어가 건설해요. 사거리 강화는 모든 대포에 적용돼요.':
        "If your cannon can't reach the outpost, you can launch nearby and let your soldiers walk the rest of the way to build it. Range upgrades apply to all your cannons.",
    '대포 착탄 피해': 'Cannon Impact Damage',
    '포탄의 중심에 가까울수록 피해가 커져요. 병력에는 가장자리의 최대 4배, 건물에는 최대 3배까지 들어가요. 같은 위치에 맞은 병력은 크기에 관계없이 같은 착탄 피해를 받아요. 영웅 포탄은 착탄 피해 대신 영웅이 착지하며 자기 공격을 해요.':
        'Damage is highest near the center of the blast. Soldiers can take up to 4× edge damage, and buildings up to 3×. Soldiers hit at the same point take the same impact damage regardless of their size. Heroes use their own landing attack in place of shell impact damage.',
    '조준 중 각 포탄의 착탄 범위를 원으로 보여줘요. 시간차로 떨어지는 포탄은 숫자가 낮은 순서로 착탄해요. 밤톨은 착탄 원 옆에 표시된 자리에 한 줄로 펼쳐져요.':
        'While you aim, circles show where each shell will hit. Staggered shells land in numbered order. Chestnut Soldiers deploy in a line at the marks beside the impact circle.',
    '인구와 출격 한도': 'Population and Deployment Limits',
    '인구는 전장 병력과 출격 대기 병력을 합한 수예요. 300명 이상이면 새로 발사할 수 없어요. 이미 승인된 발사의 병력은 모두 투입돼요.':
        "Population counts soldiers already on the battlefield and those waiting to deploy. You can't fire at 300 or more. Approved launches deploy their full payload.",
    '거점 건설': 'Building Outposts',
    '중립 거점에 우리 병사만 있으면 공사가 시작돼요. 병사들이 건물에 부딪혀 작업을 쌓고 완성합니다.':
        'Construction begins when only your soldiers occupy a neutral outpost site. Soldiers complete work by bumping into the building until it is done.',
    '작업·비용과 건설 중단': 'Work, Cost, and Construction Interruptions',
    '전진 거점은 250작업에 완공되며 최대 체력은 500이에요. 기본 병사는 접촉마다 1작업을 해요. 5작업마다 2원씩 총 100원이 들어요. 자원이 0원이면 작업이 멈추고, 1원이면 다음 결제 직전까지만 진행해요. 건설 중 파괴되면 투자한 돈은 돌아오지 않아요.':
        'An outpost takes 250 work to finish and has 500 max HP. Standard soldiers contribute one work per contact. Construction costs 2 food every 5 work, up to 100 food. At 0 food, work stops. With 1 food, it continues until the next payment is due. A destroyed construction site refunds nothing.',
    '작업자는 공사를 먼저 해요. 포탄에 맞는 등 피해를 받으면 제자리에서 닿는 적에게 응전해요. 닿는 적이 없으면 다시 공사해요.':
        'Workers prioritize construction. When hit, they defend themselves against enemies within reach. When no enemy is within reach, they resume construction.',
    '5칸은 다음 자원 지출까지의 진행을 보여줘요. 완공된 거점은 자원을 생산해요. 본진과 완공된 거점은 시야에 들어온 거리 500 이내의 적을 0.5초마다 자동 공격해요. 일반탄의 피해는 8이며 다섯 번째 공격은 반경 100의 곡사 박격포탄을 쏴요. 박격포의 기본 피해는 20이며 경량과 중형 병사에게는 각각 10과 15를 줘요.':
        'The five segments show progress toward the next payment. Completed outposts produce resources. Base and outpost turrets fire automatically every 0.5 seconds at visible enemies within 500. A normal shot deals 8 damage. Every fifth shot fires a mortar with a 100-unit blast radius. It deals 20 base damage, reduced to 10 for light soldiers and 15 for medium soldiers.',
    '포탑 아래의 점은 일반탄을 쏠 때마다 하나씩 채워져요. 네 점이 차면 다음 공격에 박격포를 쏘고 점이 모두 비워져요.':
        'The dots below a turret fill with each normal shot. When all four are filled, its next shot is a mortar and the dots reset.',
    '지형 활용': 'Using Terrain',
    '강 위 병사는 느려지고 받는 피해가 늘어요. 다리를 건너면 강의 불이익을 받지 않아요.':
        'Soldiers move more slowly and take more damage in rivers. Bridges let them cross at full speed and take normal damage.',
    '강·경사로와 고지대': 'Rivers, Ramps, and High Ground',
    '강 위 이동 속도는 절반, 받는 피해는 1.5배예요. 경사로를 올라갈수록 느려지지만 내려갈 때는 느려지지 않아요.':
        'In rivers, soldiers move at half speed and take 1.5× damage. Going up a ramp slows them down. Going downhill keeps their normal speed.',
    '낮은 곳에서 높은 곳을 향한 일반 원거리 공격은 절반 확률로 빗나가요. 대포 착탄과 옥수수의 폭발은 이 빗나감의 대상이 아니에요.':
        'Standard ranged attacks from low ground to high ground miss half the time. Shell impacts and Corn explosions are unaffected.',
    알겠어요: 'Got it',
    '경기 메뉴': 'Match Menu',
    '게임은 메뉴를 열어도 계속 진행됩니다. 연결 복구 중에는 시뮬레이션이 별도로 정지됩니다.':
        'The match keeps running while this menu is open. The game pauses during connection recovery.',
    계속하기: 'Resume',
    도움말: 'Help',
    항복: 'Surrender',
    '⇩ 현재까지 리플레이 저장': '⇩ Save Replay So Far',
    '게임 나가기': 'Leave Match',
    '항복하고 나가기': 'Surrender and Leave',
};
