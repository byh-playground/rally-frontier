import { locale, t, shellText } from './locale.js';

const select = document.getElementById('languageSelect');
select.value = locale;
select.addEventListener('change', () => window.__RALLY_LANGUAGE__.select(select.value));

if (locale === 'en') {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.parentElement.closest('script, style, option[lang]')) continue;
        const raw = node.nodeValue;
        const key = raw.trim();
        if (!key) continue;
        const translated = shellText(key);
        if (translated !== key) node.nodeValue = raw.replace(key, () => translated);
    }
    for (const attr of ['aria-label', 'title', 'placeholder', 'alt']) {
        for (const element of document.querySelectorAll('[' + attr + ']')) {
            const value = element.getAttribute(attr);
            const translated = t(value);
            if (translated !== value) element.setAttribute(attr, translated);
        }
    }
    for (const meta of document.querySelectorAll('meta[content]')) {
        const value = meta.content;
        if (t(value) !== value) meta.content = t(value);
    }
}
