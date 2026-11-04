// Test-only match settings read from the address (D-202). They replace the old start dialog's advanced settings.
// A wrong value throws instead of falling back, so a test address never silently runs something else.
//
//   ?tps=10|15|20|30                 simulation ticks per second
//   ?netcode=lockstep|rollback       sync mode of the next match
//   ?role=host|guest                 the human's side in the AI match (#/play)
//   ?battleTest=100|200|400          mobile battle measurement, with &composition=melee|ranged|mixed &seed=<uint> &sample=10|15|30
//   ?unitTest=1                      live unit combat, with &ally=<unit> &allyCount=<1-60> &enemy=<unit> &enemyCount=<1-60> &research=0|1
//   ?campaign=1                      opens the campaign loader on the title
const CHOICES = Object.freeze({
    tps: ['10', '15', '20', '30'],
    netcode: ['lockstep', 'rollback'],
    role: ['host', 'guest'],
    battleTest: ['100', '200', '400'],
    composition: ['melee', 'ranged', 'mixed'],
    sample: ['10', '15', '30'],
    research: ['0', '1'],
    unitTest: ['1'],
    campaign: ['1'],
});

export function readDevQuery(search) {
    const PARAMS = new URLSearchParams(search);
    const pick = (name, fallback = null) => {
        if (!PARAMS.has(name)) {
            return fallback;
        }
        const VALUE = PARAMS.get(name);
        if (!CHOICES[name].includes(VALUE)) {
            throw new Error(`?${name} must be one of ${CHOICES[name].join('|')}: ${VALUE}`);
        }
        return VALUE;
    };
    const integer = (name, min, max, fallback) => {
        if (!PARAMS.has(name)) {
            return fallback;
        }
        const VALUE = PARAMS.get(name);
        if (!/^\d+$/.test(VALUE) || Number(VALUE) < min || Number(VALUE) > max) {
            throw new Error(`?${name} must be an integer ${min}-${max}: ${VALUE}`);
        }
        return Number(VALUE);
    };
    const TPS = pick('tps'),
        BATTLE = pick('battleTest'),
        UNIT = pick('unitTest');
    if (BATTLE && UNIT) {
        throw new Error('?battleTest and ?unitTest start different matches; use one');
    }
    return {
        tps: TPS && Number(TPS),
        netcode: pick('netcode'),
        role: pick('role'),
        battleTest: BATTLE && {
            totalUnits: Number(BATTLE),
            composition: pick('composition', 'mixed'),
            fixedSeed: integer('seed', 0, 0xffffffff, 20261015),
            sampleSeconds: Number(pick('sample', '15')),
        },
        unitTest: UNIT && {
            allyType: PARAMS.get('ally') || 'swarmbug',
            allyCount: integer('allyCount', 1, 60, 10),
            enemyType: PARAMS.get('enemy') || 'shelltitan',
            enemyCount: integer('enemyCount', 1, 60, 5),
            research: pick('research', '1') === '1',
        },
        campaign: pick('campaign') === '1',
    };
}
