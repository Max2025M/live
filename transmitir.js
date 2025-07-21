const fs = require('fs');
const { spawn } = require('child_process');

function corrigirStreamUrl(url) {
  // Corrige URLs com barras duplicadas depois do domínio
  const partes = url.split('/');
  const protocolo = partes[0]; // rtmp:
  const host = partes[2]; // live-api.facebook.com
  const caminho = partes.slice(3).join('/').replace(/\/+/g, '/'); // remove barras duplicadas
  return `${protocolo}//${host}/${caminho}`;
}

if (!fs.existsSync('video_final_completo.mp4')) {
  console.error('❌ Arquivo video_final_completo.mp4 não encontrado!');
  process.exit(1);
}

if (!fs.existsSync('stream_info.json')) {
  console.error('❌ Arquivo stream_info.json não encontrado!');
  process.exit(1);
}

const info = JSON.parse(fs.readFileSync('stream_info.json', 'utf-8'));
let streamUrl = info.stream;

if (!streamUrl || !streamUrl.startsWith('rtmp')) {
  console.error('❌ URL de stream inválida:', streamUrl);
  process.exit(1);
}

// Corrigir se necessário
const originalUrl = streamUrl;
streamUrl = corrigirStreamUrl(streamUrl);
if (originalUrl !== streamUrl) {
  console.log(`🔧 Corrigindo URL de stream:\n  Antes: ${originalUrl}\n  Depois: ${streamUrl}`);
}

console.log(`🚀 Transmitindo para ${streamUrl} em 1280x720 (HD)`);

const ffmpeg = spawn('ffmpeg', [
  '-re',
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
