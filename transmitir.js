const fs = require('fs');
const { spawn } = require('child_process');

if (!fs.existsSync('video_final_completo.mp4')) {
  console.error('❌ Arquivo video_final_completo.mp4 não encontrado!');
  process.exit(1);
}

if (!fs.existsSync('stream_info.json')) {
  console.error('❌ Arquivo stream_info.json não encontrado!');
  process.exit(1);
}

const info = JSON.parse(fs.readFileSync('stream_info.json', 'utf-8'));
const streamUrl = info.stream;

if (!streamUrl || !streamUrl.startsWith('rtmp')) {
  console.error('❌ URL de stream inválida:', streamUrl);
  process.exit(1);
}

console.log('🚀 Iniciando transmissão para:', streamUrl);

const ffmpeg = spawn('ffmpeg', [
  '-re',                        // Envia em tempo real
  '-i', 'video_final_completo.mp4',
  '-c:v', 'libx264',
  '-preset', 'veryfast',
  '-tune', 'zerolatency',
  '-b:v', '2500k',
  '-maxrate', '2500k',
  '-bufsize', '5000k',
  '-c:a', 'aac',
  '-b:a', '128k',
  '-f', 'flv',
  streamUrl
]);

ffmpeg.stdout.on('data', data => {
  console.log(`[ffmpeg] ${data}`);
});

ffmpeg.stderr.on('data', data => {
  console.error(`[ffmpeg] ${data}`);
});

ffmpeg.on('close', code => {
  if (code === 0) {
    console.log('✅ Transmissão finalizada com sucesso!');
  } else {
    console.error(`❌ FFmpeg finalizou com erro. Código: ${code}`);
  }
});
