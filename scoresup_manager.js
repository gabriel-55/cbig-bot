const fs = require('fs/promises');
const path = require('path');
const zlib = require('zlib'); 

async function downloadScoreSup(attachment) {
    const response = await fetch(attachment.url);
    const buffer = await response.arrayBuffer();
    const localFilePath = path.join(__dirname, attachment.name);
    await fs.writeFile(localFilePath, Buffer.from(buffer));
    return localFilePath;
}

async function cleanupScoreSup(localFilePath) {
    if (localFilePath) {
        try {
            await fs.unlink(localFilePath);
        } catch (err) {
            console.error('一時ファイルの削除に失敗しました:', err);
        }
    }
}

async function readAndDecodeScoreSup(localFilePath) {
    const base64Data = await fs.readFile(localFilePath, 'utf-8');
    const buffer = Buffer.from(base64Data.trim(), 'base64');
    const decompressed = zlib.gunzipSync(buffer);
    return JSON.parse(decompressed.toString('utf-8'));
}


async function encodeScoreSup(scoreData) {
    const jsonString = JSON.stringify(scoreData);
    const compressed = zlib.gzipSync(jsonString);
    return compressed.toString('base64');
}

module.exports = {
    downloadScoreSup,
    cleanupScoreSup,
    readAndDecodeScoreSup,
    encodeScoreSup
};