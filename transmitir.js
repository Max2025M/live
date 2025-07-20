const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ARTIFACT_DIR = path.join(__dirname, 'video_final'); // Diretório onde foi extraído o artefato
const infoPath = path.join(ARTIFACT_DIR, 'stream_info.json');
const videoPath = path.join(ARTIFACT_DIR, 'video_final_completo.mp4');

// Verificar stream_info.json
if (!fs.existsSync(infoPath)) {
  console.error('❌ Arquivo stream_info.json não encontrado em:', infoPath);
  process.exit(1);
}

let json;
try {
  json = JSON.parse(fs.readFileSync(infoPath, 'utf-8'));
} catch (e) {
  console.error('❌ Erro ao ler stream_info.json:', e.message);
  process.exit(1);
}

const { id, stream_url } = json;
if (!stream_url || !/^rtmps?:\/\//.test(stream_url)) {
  console.error('❌ URL do stream inválida ou ausente:', stream_url);
  process.exit(1);
}

// Verificar vídeo
if (!fs.existsSync(videoPath)) {
  console.error('❌ Arquivo de vídeo não encontrado:', videoPath);
  process.exit(1);
}

console.log(`📡 Iniciando transmissão do evento ${id} para ${stream_url}...`);

const ffmpeg = spawn('ffmpeg', [
  '-re',
  '-i', videoPath,
  '-c:v', 'libx264',
  '-preset', 'veryfast',
  '-maxrate', '4500k',
  '-bufsize', '9000k',
  '-c:a', 'aac',
  '-b:a', '192k',
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
