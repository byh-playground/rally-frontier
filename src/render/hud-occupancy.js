// Holds the screen space used by world HUD labels for one painted frame.
export class HudOccupancy {
    #cells = new Set();
    #step = 8;

    reset(pixelRatio) {
        this.#step = 8 * Math.max(1, pixelRatio);
        this.#cells.clear();
    }

    // Reserve important information even when another important label is in the same area.
    // An optional acceptance callback runs after the overlap check, before any cells are reserved.
    place(x, y, width, height, important = false, accept) {
        const step = this.#step;
        const left = Math.floor(x / step);
        const right = Math.ceil((x + width) / step);
        const top = Math.floor(y / step);
        const bottom = Math.ceil((y + height) / step);
        if (!important) {
            for (let row = top; row < bottom; row++)
                for (let col = left; col < right; col++)
                    if (this.#cells.has(row * 65536 + col)) return false;
        }
        if (accept && !accept()) return false;
        for (let row = top; row < bottom; row++)
            for (let col = left; col < right; col++) this.#cells.add(row * 65536 + col);
        return true;
    }
}
