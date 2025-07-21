const { spawn, execSync } = require('child_process');
const fs = require('fs');

// Verifica se o FFmpeg está instalado
try {
  execSync('ffmpeg -version', { stdio: 'ignore' });
} catch (err) {
  console.log('⬇️ FFmpeg não encontrado, instalando...');
  execSync('sudo apt update && sudo apt install -y ffmpeg');
}

// Carrega as configurações
if (!fs.existsSync('stream_info.json')) {
  console.error('❌ stream_info.json não encontrado!');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync('stream_info.json', 'utf-8'));
const streamUrl = config.stream_url || config.stream;

if (!streamUrl || !streamUrl.startsWith('rtmp')) {
  console.error('❌ URL de transmissão inválida:', streamUrl);
  process.exit(1);
}

const video = 'video_final_completo.mp4';
if (!fs.existsSync(video)) {
  console.error('❌ Arquivo de vídeo não encontrado:', video);
  process.exit(1);
}

console.log(`🚀 Transmitindo para ${streamUrl} em 1280x720 (HD)`);

// Comando do FFmpeg
const ffmpegArgs = [
  '-re',                   // Leitura em tempo real
  '-i', video,             // Vídeo de entrada
  '-vf', 'scale=1280:720', // Força proporção 16:9 HD
  '-c:v', 'libx264',
  '-preset', 'veryfast',
  '-b:v', '2500k',
  '-maxrate', '3000k',
  '-bufsize', '6000k',
  '-pix_fmt', 'yuv420p',
  '-g', '50',              // Keyframe a cada ~2s (25fps)
  '-c:a', 'aac',
  '-b:a', '128k',
  '-ar', '44100',
  '-f', 'flv',             // Formato para RTMP
  streamUrl
];

const ffmpeg = spawn('ffmpeg', ffmpegArgs);

// Captura logs detalhados
ffmpeg.stdout?.on('data', (data) => {
  console.log(`[stdout] ${data}`);
});

ffmpeg.stderr?.on('data', (data) => {
  const msg = data.toString();
  if (msg.includes('error') || msg.includes('Error') || msg.includes('Invalid')) {
    console.error(`[stderr] ⚠️ ${msg}`);
  } else {
    console.log(`[stderr] ${msg}`);
  }
});

ffmpeg.on('close', (code) => {
  if (code === 0) {
    console.log('✅ Transmissão encerrada com sucesso');
  } else {
    console.error(`❌ FFmpeg terminou com erro. Código de saída: ${code}`);
  }
});

ffmpeg.on('error', (err) => {
  console.error('❌ Erro ao executar FFmpeg:', err);
});
