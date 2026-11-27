// A caller names the required file at the point where its load or validation can fail.
export async function requireAsset(url, load) {
    try {
        return await load();
    } catch (cause) {
        if (cause?.assetUrl) throw cause;
        const error = new Error(String(cause?.message || cause), { cause });
        error.assetUrl = String(url);
        throw error;
    }
}

export async function fetchAsset(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response;
}
