const puppeteer = require('puppeteer');
const fs = require('fs/promises');
const path = require('path');

async function exportUpdateData() {
    let browser;
    const downloadPath = path.join(__dirname, `temp_dl_${Date.now()}`);
    
    try {
        await fs.mkdir(downloadPath, { recursive: true });
        browser = await puppeteer.launch({ headless: "new" });
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 1080 });

        const client = await page.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: downloadPath,
        });

        console.log(`[Update] ScoreSupへアクセスします...`);
        await page.goto('https://reiwa.f5.si/scoresup/', { waitUntil: 'networkidle2' });
        
        console.log(`[Update] 楽曲リストの読み込みを待機しています...`);
        await page.waitForSelector('input[type="number"]', { timeout: 15000 });

        console.log(`[Update] すべての入力欄に「1」を注入しています...`);
        
        await page.evaluate(() => {
            const inputs = document.querySelectorAll('input[type="number"]');
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
            
            inputs.forEach(input => {
                nativeInputValueSetter.call(input, '1');
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            });
        });

        await new Promise(resolve => setTimeout(resolve, 3000));

        console.log(`[Update] エクスポートボタンをクリックします...`);
        await page.click('button#export-btn');

        console.log(`[Update] ファイルのダウンロードを待機しています...`);
        let downloadedFile = null;
        for (let i = 0; i < 30; i++) {
            const files = await fs.readdir(downloadPath);
            const scoresupFile = files.find(f => f.endsWith('.scoresup') && !f.endsWith('.crdownload'));
            if (scoresupFile) {
                downloadedFile = path.join(downloadPath, scoresupFile);
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        if (!downloadedFile) {
            throw new Error('更新データのダウンロードがタイムアウトしました。');
        }

        const base64Data = await fs.readFile(downloadedFile, 'utf-8');
        return base64Data;

    } finally {
        if (browser) await browser.close();
        try {
            await fs.rm(downloadPath, { recursive: true, force: true });
        } catch (err) {
            console.error('一時フォルダの削除に失敗しました:', err);
        }
    }
}

async function generateImage(username, localFilePath) {
    let browser;
    try {
        browser = await puppeteer.launch({ headless: "new" });
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 1080 });

        if (localFilePath) {
            console.log(`[3] ScoreSupへアクセスします...`);
            await page.goto('https://reiwa.f5.si/scoresup/', { waitUntil: 'domcontentloaded' });
            
            let dialogCount = 0;
            const scoreSupDialogHandler = async dialog => {
                dialogCount++;
                console.log(`  -> 💡 ポップアップ検知(${dialogCount}回目): 「${dialog.message()}」 -> 自動で「はい」を押しました`);
                await dialog.accept(); 
            };
            page.on('dialog', scoreSupDialogHandler);

            console.log(`[4] ファイル入力欄を探しています...`);
            const FILE_INPUT_SELECTOR = 'input[type="file"]';
            const fileInput = await page.$(FILE_INPUT_SELECTOR);
            
            if (fileInput) {
                console.log(`[5] ファイルをアップロード（適用）します...`);
                await fileInput.uploadFile(localFilePath);
                
                await page.evaluate((el) => {
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                }, fileInput);
                
                let waitTime = 0;
                while (dialogCount < 2 && waitTime < 10000) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    waitTime += 500;
                }

                if (dialogCount < 2) {
                    console.log(`  -> ⚠️ 警告: 想定される回数のポップアップが出ませんでした。（現在: ${dialogCount}回）`);
                }
                
                await new Promise(resolve => setTimeout(resolve, 1500));
                console.log(`[6] ScoreSupでの読み込み処理が完了しました`);
            } else {
                throw new Error('ScoreSupのファイルアップロードボタンが見つかりませんでした。');
            }

            page.off('dialog', scoreSupDialogHandler);
        }

        console.log(`[7] 画像ジェネレーターへアクセスします...`);
        await page.goto('https://reiwa.f5.si/newbestimg/chunithm/', { waitUntil: 'domcontentloaded' });

        const INPUT_SELECTOR = '#chunirec_username';   
        const BUTTON_SELECTOR = '#generate.general-button'; 
        const RESULT_SELECTOR = '#result-img'; 

        console.log(`[8] ユーザー名を入力します...`);
        await page.click(INPUT_SELECTOR);
        await page.keyboard.down('Control');
        await page.keyboard.press('A');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        await page.type(INPUT_SELECTOR, username);

        const waitForResult = new Promise((resolve, reject) => {
            page.once('dialog', async dialog => {
                const errorMessage = dialog.message(); 
                await dialog.accept(); 
                reject(new Error(errorMessage)); 
            });

            page.waitForSelector(RESULT_SELECTOR, { visible: true, timeout: 30000 })
                .then(() => resolve())
                .catch(() => reject(new Error('タイムアウト：画像の生成に時間がかかりすぎています。')));
        });

        console.log(`[9] 生成ボタンをクリックします...`);
        await page.click(BUTTON_SELECTOR);

        console.log(`[10] 画像の生成完了を待機しています...`);
        await waitForResult;
        
        await new Promise(resolve => setTimeout(resolve, 3000));

        console.log(`[11] スクリーンショットを撮影します...`);
        const resultElement = await page.$(RESULT_SELECTOR);
        const imageBuffer = await resultElement.screenshot();

        return imageBuffer;
        
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

module.exports = {
    exportUpdateData,
    generateImage
};