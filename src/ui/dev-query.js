// Test-only match settings read from the address (D-202). They replace the old start dialog's advanced settings.
// A wrong value throws instead of falling back, so a test address never silently runs something else.
//
//   ?tps=10|15|20|30                 simulation ticks per second
//   ?netcode=lockstep|rollback       sync mode of the next match
//   ?role=host|guest                 the human's side in the AI match (#/play)
const CHOICES = Object.freeze({
    tps: ['10', '15', '20', '30'],
    netcode: ['lockstep', 'rollback'],
    role: ['host', 'guest'],
});

export function readDevQuery(search) {
    const PARAMS = new URLSearchParams(search);
    const pick = name => {
        if (!PARAMS.has(name)) {
            return null;
        }
        const VALUE = PARAMS.get(name);
        if (!CHOICES[name].includes(VALUE)) {
            throw new Error(`?${name} must be one of ${CHOICES[name].join('|')}: ${VALUE}`);
        }
        return VALUE;
    };
    const TPS = pick('tps');
    return {
        tps: TPS && Number(TPS),
        netcode: pick('netcode'),
        role: pick('role'),
    };
}
