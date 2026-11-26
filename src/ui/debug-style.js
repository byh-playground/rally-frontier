// The stylesheet of the debug pages, added only when one of them opens.
export function useDebugStyle() {
    const style = document.createElement('link');
    style.rel = 'stylesheet';
    style.href = new URL('../styles/motion-board.css', import.meta.url).href;
    document.head.append(style);
}
