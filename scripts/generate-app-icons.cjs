// Resize the approved square sharing artwork for browser and installed app icons.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
    const root = path.resolve(__dirname, '..');
    const source = fs.readFileSync(path.join(root, 'assets/ssalkongpang-thumbnail-square.png'));
    const browser = await chromium.launch({ channel: process.env.QA_BROWSER_CHANNEL || 'msedge' });
    try {
        const page = await browser.newPage();
        const images = await page.evaluate(async (base64) => {
            const sourceImage = new Image();
            sourceImage.src = `data:image/png;base64,${base64}`;
            await sourceImage.decode();
            if (sourceImage.naturalWidth !== sourceImage.naturalHeight)
                throw new Error('App icon source must be square');
            return [180, 192, 512].map((size) => {
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = size;
                const context = canvas.getContext('2d');
                context.imageSmoothingEnabled = true;
                context.imageSmoothingQuality = 'high';
                context.drawImage(sourceImage, 0, 0, size, size);
                return { size, data: canvas.toDataURL('image/png').split(',')[1] };
            });
        }, source.toString('base64'));
        for (const image of images) {
            fs.writeFileSync(
                path.join(root, 'icons', `ssalkongpang-${image.size}.png`),
                Buffer.from(image.data, 'base64'),
            );
        }
        console.log('Generated 180, 192 and 512px icons from the approved square artwork.');
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
