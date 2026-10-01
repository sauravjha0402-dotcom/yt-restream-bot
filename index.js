const TelegramBot = require('node-telegram-bot-api');
const { spawn } = require('child_process');

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("FATAL: BOT_TOKEN Environment Variable is missing!");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

const userSessions = new Map();
const activeStreams = new Map();

console.log("Telegram Live Stream Bot started successfully...");

// 1. /start Command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  userSessions.delete(chatId);

  const welcomeMessage = 
    `👋 *Welcome to RTMP Restreamer Bot!*\n\n` +
    `Yeh bot aapki live stream ko direct YouTube Live par restream karta hai.\n\n` +
    `Aap direct YouTube link (\`https://www.youtube.com/live/...\`) ya koi bhi \`.m3u8\` link bhej sakte hain.`;

  const opts = {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '▶️ Start Restream', callback_data: 'init_stream' }],
        [{ text: '⏹ Stop Active Stream', callback_data: 'stop_stream' }]
      ]
    }
  };

  bot.sendMessage(chatId, welcomeMessage, opts);
});

// 2. Callback Query Handler (Buttons)
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const action = query.data;

  if (action === 'init_stream') {
    if (activeStreams.has(chatId)) {
      bot.answerCallbackQuery(query.id, { text: "⚠ You already have an active stream running!" });
      return;
    }
    userSessions.set(chatId, { step: 'AWAITING_SOURCE_URL' });
    bot.sendMessage(chatId, "🔗 Please send your **Source Live Stream Link** (YouTube URL, .m3u8, RTMP, or direct media link):", { parse_mode: 'Markdown' });
  } 

  else if (action === 'start_live') {
    const session = userSessions.get(chatId);
    if (!session || !session.sourceUrl || !session.streamKey) {
      bot.sendMessage(chatId, "❌ Invalid session data. Please start again with /start.");
      return;
    }

    startFfmpegStream(chatId, session.sourceUrl, session.streamKey);
    userSessions.delete(chatId);
  } 

  else if (action === 'stop_stream') {
    stopFfmpegStream(chatId);
  }

  bot.answerCallbackQuery(query.id);
});

// 3. Text Message Handler
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || text.startsWith('/')) return;

  const session = userSessions.get(chatId);
  if (!session) return;

  if (session.step === 'AWAITING_SOURCE_URL') {
    session.sourceUrl = text.trim();
    session.step = 'AWAITING_STREAM_KEY';
    userSessions.set(chatId, session);

    bot.sendMessage(chatId, "🔑 Source URL received!\n\nNow send your **YouTube Live RTMP Stream Key**:", { parse_mode: 'Markdown' });
  } 
  
  else if (session.step === 'AWAITING_STREAM_KEY') {
    session.streamKey = text.trim();
    session.step = 'READY';
    userSessions.set(chatId, session);

    const confirmOpts = {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔴 Go Live Now', callback_data: 'start_live' }],
          [{ text: '❌ Cancel', callback_data: 'stop_stream' }]
        ]
      }
    };

    bot.sendMessage(
      chatId,
      `📌 *Stream Details Configured:*\n\n` +
      `• *Source:* \`${session.sourceUrl}\`\n` +
      `• *Stream Key:* \`${session.streamKey.substring(0, 4)}****\`\n\n` +
      `Ready to start the stream?`,
      confirmOpts
    );
  }
});

// 4. Stream Handler with yt-dlp & FFmpeg
function startFfmpegStream(chatId, sourceUrl, streamKey) {
  const youtubeRtmpUrl = `rtmp://a.rtmp.youtube.com/live2/${streamKey}`;

  bot.sendMessage(chatId, "⏳ Processing source link and setting up stream...");

  // Agar YouTube Link hai toh yt-dlp se fresh M3U8 link extract karein
  if (sourceUrl.includes('youtube.com') || sourceUrl.includes('youtu.be')) {
    const ytDlpProcess = spawn('yt-dlp', ['-g', '-f', 'best', sourceUrl]);

    let extractedUrl = '';

    ytDlpProcess.stdout.on('data', (data) => {
      extractedUrl += data.toString();
    });

    ytDlpProcess.stderr.on('data', (err) => {
      console.error(`[yt-dlp log \({chatId}]:\){err.toString()}`);
    });

    ytDlpProcess.on('close', (code) => {
      const realM3u8Url = extractedUrl.trim().split('\n')[0]; // First stream URL

      if (code === 0 && realM3u8Url) {
        runFFmpeg(chatId, realM3u8Url, youtubeRtmpUrl);
      } else {
        bot.sendMessage(chatId, "❌ Failed to extract stream URL from YouTube link. Make sure the stream is live.");
      }
    });

  } else {
    // Regular M3U8 / MP4 Link
    runFFmpeg(chatId, sourceUrl, youtubeRtmpUrl);
  }
}

function runFFmpeg(chatId, mediaUrl, targetRtmp) {
  const ffmpegArgs = [
    '-re',
    '-i', mediaUrl,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-maxrate', '3000k',
    '-bufsize', '6000k',
    '-c:a', 'aac',
    '-ar', '44100',
    '-f', 'flv',
    targetRtmp
  ];

  const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
  activeStreams.set(chatId, ffmpegProcess);

  ffmpegProcess.stderr.on('data', (data) => {
    console.log(`[FFmpeg Log \({chatId}]:\){data.toString()}`);
  });

  ffmpegProcess.on('close', (code) => {
    activeStreams.delete(chatId);
    console.log(`FFmpeg process for chat \({chatId} exited with code\){code}`);
    bot.sendMessage(chatId, `ℹ️ Stream process ended (Exit code: ${code}).`);
  });

  ffmpegProcess.on('error', (err) => {
    activeStreams.delete(chatId);
    console.error(`FFmpeg error for chat ${chatId}:`, err);
    bot.sendMessage(chatId, `❌ Stream failed to start: ${err.message}`);
  });

  const stopOpts = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '⏹ Stop Stream', callback_data: 'stop_stream' }]
      ]
    }
  };

  bot.sendMessage(chatId, "⚡ *LIVE NOW!* Your stream is actively relaying to YouTube Live.", { parse_mode: 'Markdown', ...stopOpts });
}

// 5. Stop Stream
function stopFfmpegStream(chatId) {
  const ffmpegProcess = activeStreams.get(chatId);
  if (ffmpegProcess) {
    ffmpegProcess.kill('SIGTERM');
    activeStreams.delete(chatId);
    bot.sendMessage(chatId, "🛑 Stream process stopped successfully.");
  } else {
    bot.sendMessage(chatId, "ℹ️ No active stream found for your session.");
  }
}