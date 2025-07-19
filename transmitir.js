const fs = require('fs');
const { spawn } = require('child_process');

const infoPath = 'stream_info.json';
if (!fs.existsSync(infoPath)) {
  console.error('❌ Arquivo stream_info.json não encontrado.');
  process.exit(1);
}

const { id, stream_url } = JSON.parse(fs.readFileSync(infoPath, 'utf-8'));
if (!stream_url || !stream_url.startsWith('rtmp')) {
  console.error('❌ URL de stream inválida ou ausente.');
  process.exit(1);
}

const video = 'video_final_completo.mp4';
if (!fs.existsSync(video)) {
  console.error('❌ Arquivo de vídeo não encontrado:', video);
  process.exit(1);
}

console.log(`📡 Iniciando transmissão do evento ${id} para ${stream_url}...`);

const ffmpeg = spawn('ffmpeg', [
  '-re',
  '-i', video,
  '-c:v', 'libx264',
  '-preset', 'veryfast',
  '-maxrate', '3000k',
  '-bufsize', '6000k',
  '-c:a', 'aac',
  '-b:a', '128k',
  '-f', 'flv',
  stream_url
]);

ffmpeg.stderr.on('data', data => process.stderr.write(data));
ffmpeg.on('exit', code => {
  if (code === 0) {
    console.log('✅ Transmissão finalizada com sucesso.');
  } else {
    console.error(`❌ FFmpeg encerrou com erro (código ${code}).`);
    process.exit(code);
  }
});
