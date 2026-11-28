// The page chooses its language before the module graph starts. Worker simulation uses canonical data.
export const locale = globalThis.__RALLY_LANGUAGE__?.locale ?? 'ko';
const english =
    locale === 'en'
        ? Object.assign(
              Object.create(null),
              ...(
                  await Promise.all([
                      import('./shell-en.js'),
                      import('./units-en.js'),
                      import('./campaign-en.js'),
                      import('./ui-en.js'),
                      import('./main-en.js'),
                  ])
              ).map((module) => module.default),
          )
        : null;

export function t(source, context) {
    if (!english || typeof source !== 'string') return source;
    if (typeof context === 'string' && english[context + '/' + source] !== undefined)
        return english[context + '/' + source];
    return english[source] ?? english[source.trim().replace(/\s+/g, ' ')] ?? source;
}

// A table heading or a collection tab can use a different grammatical form than a command.
export function shellText(source) {
    return t(source, 'shell');
}

export function msg(template, ...values) {
    return t(template).replace(/\{(\d+)\}/g, (placeholder, index) =>
        index < values.length ? String(values[index]) : placeholder,
    );
}
