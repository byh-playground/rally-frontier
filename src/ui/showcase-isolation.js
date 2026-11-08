// Showcase documents must never read or write player data.
{
    const query = new URLSearchParams(location.search);
    const unitType = query.get('unitShowcase');
    const mode = unitType !== null ? 'unit' : query.get('titleShowcase') === '1' ? 'title' : null;
    if (mode) {
        document.documentElement.dataset.showcase = mode;
        if (mode === 'unit') document.documentElement.dataset.showcaseUnit = unitType;
        for (const name of ['localStorage', 'sessionStorage']) {
            const values = new Map();
            const storage = {
                get length() {
                    return values.size;
                },
                key(index) {
                    return [...values.keys()][index] ?? null;
                },
                getItem(key) {
                    return values.get(String(key)) ?? null;
                },
                setItem(key, value) {
                    values.set(String(key), String(value));
                },
                removeItem(key) {
                    values.delete(String(key));
                },
                clear() {
                    values.clear();
                },
            };
            Object.defineProperty(window, name, { value: storage });
        }
    }
}
