const { Client, GatewayIntentBits, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { downloadScoreSup, cleanupScoreSup, readAndDecodeScoreSup, encodeScoreSup } = require('./scoresup_manager.js');
const zlib = require('zlib');
const { generateImage, exportUpdateData } = require('./generator.js'); 
const { token } = require('./config.json');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.once('ready', () => {
    console.log(`Botがログインしました: ${client.user.tag}`);
});

async function getScoreSupAttachment(startMessage) {
    let attachment = startMessage.attachments.first();
    let depth = 0;
    let currentMessage = startMessage;

    while ((!attachment || !attachment.name.endsWith('.scoresup')) && currentMessage.reference && depth < 10) {
        try {
            currentMessage = await startMessage.channel.messages.fetch(currentMessage.reference.messageId);
            const refAttachment = currentMessage.attachments.first();
            if (refAttachment && refAttachment.name.endsWith('.scoresup')) {
                attachment = refAttachment;
                console.log(`[0] 返信を遡ってファイルを発見: ${attachment.name} (遡った回数: ${depth + 1}回)`);
                break;
            }
            depth++;
        } catch (err) { break; }
    }
    return attachment;
}


const taskQueue = [];
let isProcessing = false;

async function processQueue() {
    if (isProcessing || taskQueue.length === 0) return;
    
    isProcessing = true; 

    while (taskQueue.length > 0) {
        const task = taskQueue.shift();
        try {
            await task.execute();
        } catch (error) {
            console.error('タスク実行中にエラーが発生しました:', error);
        }
    }

    isProcessing = false;
}

client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const cmdStr = message.content.split(' ')[0];

    if (cmdStr === 'c!help') {
        const embed = new EmbedBuilder()
            .setTitle('📚 コマンドヘルプ')
            .setDescription('**🖼️ ベスト枠画像の生成**\n`c!gen [ユーザー名]`\nベスト枠画像を生成します。（例: `c!gen username`）\n※`.scoresup` ファイルを**添付**、またはファイルがあるメッセージに**返信（引用）**して実行すると、そのデータを反映して生成します。')
            .addFields(
                { name: '📝 データ編集・管理コマンド', value: '以下のコマンドは、`.scoresup` ファイルを**添付**、または**返信（引用）**して実行してください。' },
                { name: 'c!view', value: '収録されている楽曲を番号付きのリストで表示します。' },
                { name: 'c!score [番号] [スコア] ...', value: '指定した番号の楽曲のスコアを更新します。\n例: `c!score 1 1010000 3 998000`' },
                { name: 'c!fc [番号] ... / c!aj [番号] ...', value: '指定した番号の楽曲のFC/AJを切り替えます。\n例: `c!fc 1 3 5`' },
                { name: 'c!update', value: '最新の楽曲リストを取得し、現在のデータを引き継ぎます。' },
                { name: 'c!clean (番号 ...)', value: 'スコアが `0` の曲をすべて削除します。番号を指定して特定の曲だけを削除することもできます。\n例: `c!clean 1 3 5`' },
                { name: 'c!detail [番号]', value: '指定した番号の楽曲の詳細データを確認します。' }
            )
            .setColor('#00aaff');

        return message.reply({ embeds: [embed] });
    }
    const validCommands = ['c!view', 'c!score', 'c!fc', 'c!aj', 'c!detail', 'c!update', 'c!clean', 'c!gen'];
    
    if (!validCommands.includes(cmdStr)) return;

    const position = taskQueue.length + (isProcessing ? 1 : 0);
    let waitMsg = null;
    
    if (position > 0) {
        waitMsg = await message.reply(`⏳ 現在 **${position}件** の処理が進行中です。順番待ちリストに追加しました...`);
    }

    taskQueue.push({
        execute: async () => {
            if (waitMsg) {
                try { await waitMsg.delete(); } catch(e) {}
            }

            if (cmdStr === 'c!view') {
                const attachment = await getScoreSupAttachment(message);
                if (!attachment) return message.reply('❌ `.scoresup` ファイルが見つかりません。ファイルを**添付**するか、ファイル付きのメッセージに**返信（引用）**して実行してください。');

                let localFilePath = null;
                try {
                    localFilePath = await downloadScoreSup(attachment);
                    const scoreData = await readAndDecodeScoreSup(localFilePath);
                    
                    let listString = scoreData.map((song, index) => {
                        let statusMark = "";
                        if (song.is_alljustice) statusMark = " (AJ)";
                        else if (song.is_fullcombo) statusMark = " (FC)";
                        return `[${index + 1}] ${song.title} (${song.diff}) - スコア: ${song.score}${statusMark}`;
                    }).join('\n');

                    const totalSongs = Array.isArray(scoreData) ? scoreData.length : '不明';

                    if (listString.length > 4000) {
                        listString = listString.substring(0, 3990) + '\n... (以降は文字数制限のため省略)';
                    }

                    const embed = new EmbedBuilder()
                        .setTitle(`📄 ${attachment.name} の収録データ`)
                        .setDescription(`\`\`\`\n${listString}\n\`\`\``)
                        .addFields({ name: '登録楽曲数', value: `${totalSongs}曲`, inline: true })
                        .setColor('#00ff00');

                    await message.reply({ embeds: [embed] });
                } catch (error) {
                    console.error(error);
                    await message.reply(`⚠️ **エラーが発生しました:** ${error.message}`);
                } finally {
                    await cleanupScoreSup(localFilePath);
                }
                return;
            }

            if (cmdStr === 'c!score') {
                const args = message.content.split(' ').slice(1);
                
                if (args.length === 0 || args.length % 2 !== 0) {
                    return message.reply('❌ 入力内容が正しくありません。\n例: `c!score 1 1000000 3 998000` のように、曲の番号とスコアをセットで入力してください。');
                }

                const attachment = await getScoreSupAttachment(message);
                if (!attachment) return message.reply('❌ `.scoresup` ファイルが見つかりません。ファイルを**添付**するか、ファイル付きのメッセージに**返信（引用）**して実行してください。');

                let localFilePath = null;
                try {
                    localFilePath = await downloadScoreSup(attachment);
                    const scoreData = await readAndDecodeScoreSup(localFilePath);
                    let editLogs = []; 

                    for (let i = 0; i < args.length; i += 2) {
                        const targetIndex = parseInt(args[i]) - 1; 
                        const newScore = parseInt(args[i + 1]);

                        if (isNaN(targetIndex) || isNaN(newScore) || !scoreData[targetIndex]) {
                            editLogs.push(`❌ 番号 \`${args[i]}\` の楽曲は見つかりませんでした。`);
                            continue; 
                        }

                        const song = scoreData[targetIndex];
                        const oldScore = song.score;
                        song.score = newScore;
                        song.rating = 0;
                        song.ratingDetailed = 0;
                        
                        const now = new Date();
                        song.updated_at = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}T${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}+0900`;

                        editLogs.push(`✅ [${args[i]}] ${song.title} (${song.diff}): \`${oldScore}\` ➡️ **\`${newScore}\`**`);
                    }

                    const newBase64String = await encodeScoreSup(scoreData);
                    const fileBuffer = Buffer.from(newBase64String, 'utf-8');
                    const newAttachment = new AttachmentBuilder(fileBuffer, { name: 'updated_data.scoresup' });

                    const embed = new EmbedBuilder()
                        .setTitle('📝 スコアを更新しました！')
                        .setDescription(editLogs.join('\n'))
                        .setColor('#0099ff');

                    await message.reply({ embeds: [embed], files: [newAttachment] });
                } catch (error) {
                    console.error(error);
                    await message.reply(`⚠️ **エラーが発生しました:** ${error.message}`);
                } finally {
                    await cleanupScoreSup(localFilePath);
                }
                return;
            }

            if (['c!fc', 'c!aj'].includes(cmdStr)) {
                const args = message.content.split(' ').slice(1);
                
                if (args.length === 0) return message.reply(`❌ 番号が指定されていません。\n例: \`${cmdStr} 1 3 5\` のように、対象の番号を入力してください。`);

                const attachment = await getScoreSupAttachment(message);
                if (!attachment) return message.reply('❌ `.scoresup` ファイルが見つかりません。ファイルを**添付**するか、ファイル付きのメッセージに**返信（引用）**して実行してください。');

                let localFilePath = null;
                try {
                    localFilePath = await downloadScoreSup(attachment);
                    const scoreData = await readAndDecodeScoreSup(localFilePath);
                    let editLogs = [];

                    let propName = '';
                    let displayLabel = '';
                    if (cmdStr === 'c!fc') { propName = 'is_fullcombo'; displayLabel = 'FC'; }
                    else if (cmdStr === 'c!aj') { propName = 'is_alljustice'; displayLabel = 'AJ'; }

                    const uniqueArgs = [...new Set(args)];

                    for (let arg of uniqueArgs) {
                        const targetIndex = parseInt(arg) - 1;

                        if (isNaN(targetIndex) || !scoreData[targetIndex]) {
                            editLogs.push(`❌ 番号 \`${arg}\` の楽曲は見つかりませんでした。`);
                            continue;
                        }

                        const song = scoreData[targetIndex];
                        song[propName] = !song[propName];

                        if (cmdStr === 'c!fc') song.is_alljustice = false;
                        else if (cmdStr === 'c!aj') song.is_fullcombo = false;

                        const now = new Date();
                        song.updated_at = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}T${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}+0900`;

                        const stateStr = song[propName] ? "ON 🟢" : "OFF 🔴";
                        editLogs.push(`✅ [${arg}] ${song.title} (${song.diff}): ${displayLabel} ➡️ **${stateStr}**`);
                    }

                    const newBase64String = await encodeScoreSup(scoreData);
                    const fileBuffer = Buffer.from(newBase64String, 'utf-8');
                    const newAttachment = new AttachmentBuilder(fileBuffer, { name: 'updated_data.scoresup' });

                    const embed = new EmbedBuilder()
                        .setTitle(`🔄 ${displayLabel} の状態を更新しました！`)
                        .setDescription(editLogs.join('\n'))
                        .setColor('#ffaa00');

                    await message.reply({ embeds: [embed], files: [newAttachment] });
                } catch (error) {
                    console.error(error);
                    await message.reply(`⚠️ **エラーが発生しました:** ${error.message}`);
                } finally {
                    await cleanupScoreSup(localFilePath);
                }
                return;
            }

            if (cmdStr === 'c!detail') {
                const args = message.content.split(' ');
                
                if (args.length < 2 || !args[1] || isNaN(parseInt(args[1]))) {
                    return message.reply('❌ 番号が正しく指定されていません。\n例: `c!detail 1` のように、詳細を見たい楽曲の番号を入力してください。');
                }

                const inputNumber = parseInt(args[1]);
                const targetIndex = inputNumber - 1; 

                const attachment = await getScoreSupAttachment(message);
                if (!attachment) return message.reply('❌ `.scoresup` ファイルが見つかりません。ファイルを**添付**するか、ファイル付きのメッセージに**返信（引用）**して実行してください。');

                let localFilePath = null;
                try {
                    localFilePath = await downloadScoreSup(attachment);
                    const scoreData = await readAndDecodeScoreSup(localFilePath);

                    const song = scoreData[targetIndex];
                    if (!song) return message.reply(`❌ 番号 \`${inputNumber}\` のデータは見つかりませんでした。`);

                    const jsonString = JSON.stringify(song, null, 2);
                    const embed = new EmbedBuilder()
                        .setTitle(`🔍 [${inputNumber}] ${song.title} (${song.diff}) の詳細データ`)
                        .setDescription(`\`\`\`json\n${jsonString}\n\`\`\``)
                        .setColor('#ffaa00'); 

                    await message.reply({ embeds: [embed] });
                } catch (error) {
                    console.error(error);
                    await message.reply(`⚠️ **エラーが発生しました:** ${error.message}`);
                } finally {
                    await cleanupScoreSup(localFilePath);
                }
                return;
            }

            if (cmdStr === 'c!update') {
                const attachment = await getScoreSupAttachment(message);
                if (!attachment) return message.reply('❌ 引き継ぎ元の `.scoresup` ファイルが見つかりません。ファイルを**添付**するか、ファイル付きのメッセージに**返信（引用）**して実行してください。');

                const replyMsg = await message.reply('🔄 最新の楽曲データを取得し、これまでのスコアを引き継いでいます。数十秒お待ちください...');
                let localFilePath = null;
                
                try {
                    localFilePath = await downloadScoreSup(attachment);
                    const oldData = await readAndDecodeScoreSup(localFilePath);
                    
                    const oldMap = new Map();
                    oldData.forEach(song => {
                        oldMap.set(`${song.title}_${song.diff}`, song);
                    });

                    const newUpdateBase64 = await exportUpdateData();
                    const buffer = Buffer.from(newUpdateBase64.trim(), 'base64');
                    const decompressed = zlib.gunzipSync(buffer);
                    const newUpdateData = JSON.parse(decompressed.toString('utf-8'));

                    const addedSongs = [];
                    const mergedData = newUpdateData.map(newSong => {
                        const key = `${newSong.title}_${newSong.diff}`;
                        if (oldMap.has(key)) {
                            const oldSong = oldMap.get(key);
                            newSong.score = oldSong.score;
                            newSong.is_fullcombo = oldSong.is_fullcombo;
                            newSong.is_alljustice = oldSong.is_alljustice;
                            newSong.updated_at = oldSong.updated_at;
                            newSong.rating = 0; 
                            newSong.ratingDetailed = 0;
                            oldMap.delete(key);
                        } else {
                            if (newSong.score === 1) newSong.score = 0; 
                            addedSongs.push(`${newSong.title} (${newSong.diff})`);
                        }
                        return newSong;
                    });

                    const removedSongs = Array.from(oldMap.values()).map(s => `${s.title} (${s.diff})`);

                    const finalBase64String = await encodeScoreSup(mergedData);
                    const fileBuffer = Buffer.from(finalBase64String, 'utf-8');
                    const newAttachment = new AttachmentBuilder(fileBuffer, { name: 'merged_latest.scoresup' });

                    let resultText = `**新しく追加された楽曲:** ${addedSongs.length} 曲\n`;
                    if (addedSongs.length > 0) resultText += `\`\`\`\n${addedSongs.slice(0, 20).join('\n')}${addedSongs.length > 20 ? '\n...他' : ''}\n\`\`\`\n`;
                    
                    resultText += `**削除・名称変更された楽曲:** ${removedSongs.length} 曲\n`;
                    if (removedSongs.length > 0) resultText += `\`\`\`\n${removedSongs.slice(0, 20).join('\n')}${removedSongs.length > 20 ? '\n...他' : ''}\n\`\`\``;

                    const embed = new EmbedBuilder()
                        .setTitle('✨ 楽曲データのアップデートが完了しました！')
                        .setDescription(resultText)
                        .setColor('#ff55ff');

                    await message.reply({ embeds: [embed], files: [newAttachment] });
                    await replyMsg.delete().catch(() => {});
                } catch (error) {
                    console.error(error);
                    await replyMsg.edit(`⚠️ **エラーが発生しました:** ${error.message}`).catch(() => {});
                } finally {
                    await cleanupScoreSup(localFilePath);
                }
                return;
            }

            if (cmdStr === 'c!clean') {
                const args = message.content.split(' ').slice(1);
                
                const attachment = await getScoreSupAttachment(message);
                if (!attachment) return message.reply('❌ `.scoresup` ファイルが見つかりません。ファイルを**添付**するか、ファイル付きのメッセージに**返信（引用）**して実行してください。');

                let localFilePath = null;
                try {
                    localFilePath = await downloadScoreSup(attachment);
                    const scoreData = await readAndDecodeScoreSup(localFilePath);
                    
                    let cleanedData = [];
                    let removedCount = 0;
                    let removedTitles = [];

                    if (args.length === 0) {
                        cleanedData = scoreData.filter(song => song.score > 0);
                        removedCount = scoreData.length - cleanedData.length;
                    } else {
                        const targetIndices = [...new Set(args.map(arg => parseInt(arg) - 1).filter(idx => !isNaN(idx)))];
                        cleanedData = scoreData.filter((song, index) => {
                            if (targetIndices.includes(index)) {
                                removedTitles.push(`[${index + 1}] ${song.title} (${song.diff})`);
                                return false;
                            }
                            return true;
                        });
                        removedCount = scoreData.length - cleanedData.length;
                    }

                    const finalBase64String = await encodeScoreSup(cleanedData);
                    const fileBuffer = Buffer.from(finalBase64String, 'utf-8');
                    const newAttachment = new AttachmentBuilder(fileBuffer, { name: 'cleaned_data.scoresup' });

                    let desc = "";
                    if (args.length === 0) {
                        desc = `スコアが \`0\` だった未プレイ曲を **${removedCount} 曲** 削除しました。\n現在の収録数: **${cleanedData.length} 曲**`;
                    } else {
                        if (removedCount > 0) {
                            desc = `指定された **${removedCount} 曲** を削除しました。\n現在の収録数: **${cleanedData.length} 曲**\n\`\`\`\n${removedTitles.join('\n')}\n\`\`\``;
                        } else {
                            desc = `指定された番号の楽曲は見つかりませんでした。\n現在の収録数: **${cleanedData.length} 曲**`;
                        }
                    }

                    const embed = new EmbedBuilder()
                        .setTitle('🧹 データの整理が完了しました！')
                        .setDescription(desc)
                        .setColor('#00ffcc');

                    await message.reply({ embeds: [embed], files: [newAttachment] });
                } catch (error) {
                    console.error(error);
                    await message.reply(`⚠️ **エラーが発生しました:** ${error.message}`);
                } finally {
                    await cleanupScoreSup(localFilePath);
                }
                return;
            }

            // ---------------------------------------------------------
            // 【コマンド5】 c!gen
            // ---------------------------------------------------------
            if (cmdStr === 'c!gen') {
                const args = message.content.split(' ');
                const username = args[1];

                if (!username) return message.reply('❌ 画像に出力するユーザー名が指定されていません。\n例: `c!gen ユーザー名` のように、コマンドの後に続けて入力してください。');

                const attachment = await getScoreSupAttachment(message);
                let localFilePath = null;
                let processMsg = null;

                if (attachment) {
                    processMsg = await message.reply(`ユーザーネーム「${username}」で画像を生成します。\n添付・引用された \`.scoresup\` ファイルを読み込んでいます...`);
                    try {
                        localFilePath = await downloadScoreSup(attachment);
                    } catch (err) {
                        if (processMsg) await processMsg.delete().catch(() => {});
                        return message.reply('❌ 添付ファイルのダウンロードに失敗しました。');
                    }
                } else {
                    processMsg = await message.reply(`ユーザーネーム「${username}」で画像を生成しています。数十秒お待ちください...`);
                }

                try {
                    const imageBuffer = await generateImage(username, localFilePath);
                    const attachmentToSend = new AttachmentBuilder(imageBuffer, { name: 'chunithm_best.png' });
                    
                    if (processMsg) {
                        await processMsg.delete().catch(() => {});
                    }

                    await message.reply({ 
                        content: `${username} さんのベスト枠画像です！`, 
                        files: [attachmentToSend] 
                    });
                } catch (error) {
                    console.error(error);
                    if (processMsg) {
                        await processMsg.edit(`⚠️ **エラーが発生しました:** ${error.message}`).catch(() => {});
                    } else {
                        await message.reply(`⚠️ **エラーが発生しました:** ${error.message}`);
                    }
                } finally {
                    await cleanupScoreSup(localFilePath);
                }
            }

        }
    });

    processQueue();
});

client.login(token);