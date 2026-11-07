// The title battle runs in a separate document and must never read or write player data.
if (new URLSearchParams(location.search).get('titleShowcase') === '1') {
    document.documentElement.dataset.titleShowcase = 'true';
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
