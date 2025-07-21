const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 1. Verifica se o FFmpeg está instalado
try {
  execSync('ffmpeg -version', { stdio: 'ignore' });
  console.log('✅ FFmpeg está instalado');
} catch (error) {
  console.log('⬇️ Instalando FFmpeg...');
  execSync('sudo apt update && sudo apt install -y ffmpeg');
}

// 2. Verifica se stream_info.json existe
const configPath = path.resolve('stream_info.json');
if (!fs.existsSync(configPath)) {
  console.error('❌ stream_info.json não encontrado');
  process.exit(1);
}

// 3. Lê e valida a stream_url
const info = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const streamUrl = info.stream_url || info.stream;

if (!streamUrl || !streamUrl.startsWith('rtmp')) {
  console.error('❌ URL de stream inválida ou ausente:', streamUrl);
  process.exit(1);
}

// 4. Define vídeo de entrada
const inputVideo = path.resolve('video_final_completo.mp4');
if (!fs.existsSync(inputVideo)) {
  console.error(`❌ Vídeo de entrada não encontrado: ${inputVideo}`);
  process.exit(1);
}

// 5. Comando FFmpeg com redimensionamento forçado para 1920x1080 (16:9)
const ffmpegArgs = [
  '-re',                          // Lê em tempo real
  '-i', inputVideo,              // Entrada
  '-vf', 'scale=1920:1080',      // Força proporção 16:9
  '-c:v', 'libx264',             // Codec de vídeo
  '-preset', 'veryfast',         // Encoder rápido
  '-b:v', '4500k',               // Bitrate de vídeo
  '-maxrate', '5000k',
  '-bufsize', '10000k',
  '-pix_fmt', 'yuv420p',
  '-g', '60',                    // Keyframe a cada 2 segundos (30fps)
  '-c:a', 'aac',                 // Codec de áudio
  '-b:a', '160k',
  '-ar', '44100',
  '-f', 'flv',                   // Formato para RTMP
  streamUrl
];

// 6. Iniciar transmissão
console.log(`🚀 Transmitindo para ${streamUrl} com resolução forçada 1920x1080`);

const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: 'inherit' });

ffmpeg.on('close', code => {
  if (code === 0) {
    console.log('✅ Transmissão finalizada com sucesso!');
  } else {
    console.error(`❌ Erro na transmissão. Código: ${code}`);
  }
});
