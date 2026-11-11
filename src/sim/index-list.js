// Entity indices a grid query wrote (spatial queryCircleInto): items[0] .. items[count - 1].
// A call site keeps one list and reuses it every tick, so a query allocates nothing once the list has grown to the
// entity count (A075 Buffer Reuse: a JS array emptied with `length = 0` drops its storage and allocates again).
// A list is overwritten by the next query into it: a loop whose body can query again keeps its own list.
export class IndexList {
    constructor() {
        this.items = new Int32Array(64);
        this.count = 0;
    }
    // Room for `capacity` indices. Growing drops the current contents, so it runs before a query writes.
    reserve(capacity) {
        if (this.items.length >= capacity) return;
        let length = this.items.length;
        while (length < capacity) length *= 2;
        this.items = new Int32Array(length);
    }
    // Sorts items[0 .. count) in place by `compare(a, b)` (negative: a first). Callers pass a strict total order
    // (ties end in a unique id), so the order matches Array.prototype.sort. Insertion sort: query results are short.
    sort(compare) {
        const items = this.items;
        for (let i = 1; i < this.count; i++) {
            const value = items[i];
            let j = i - 1;
            while (j >= 0 && compare(items[j], value) > 0) {
                items[j + 1] = items[j];
                j--;
            }
            items[j + 1] = value;
        }
    }
}
