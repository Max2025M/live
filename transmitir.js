const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

// Função para formatar a duração em mm:ss
function formatarDuracao(segundos) {
  const minutos = Math.floor(segundos / 60);
  const seg = Math.floor(segundos % 60);
  return `${minutos}:${seg.toString().padStart(2, '0')} minutos`;
}

// Função para obter a duração do vídeo usando ffprobe
function obterDuracao(videoPath) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath
    ]);

    let output = '';
    ffprobe.stdout.on('data', data => output += data.toString());
    ffprobe.on('close', () => {
      const duracao = parseFloat(output.trim());
      if (!isNaN(duracao)) resolve(duracao);
      else reject(new Error('❌ Não foi possível obter a duração do vídeo.'));
    });
  });
}

// Caminhos dos arquivos
const infoPath = 'stream_info.json';
const videoPath = 'video_final_completo.mp4';

// Verificações de existência
if (!fs.existsSync(infoPath)) {
  console.error('❌ Arquivo stream_info.json não encontrado.');
  process.exit(1);
}
if (!fs.existsSync(videoPath)) {
  console.error('❌ Arquivo de vídeo não encontrado:', videoPath);
  process.exit(1);
}

// Leitura das informações
const { id, stream_url } = JSON.parse(fs.readFileSync(infoPath, 'utf-8'));

if (!stream_url || !stream_url.startsWith('rtmp')) {
  console.error('❌ URL de stream inválida ou ausente.');
  process.exit(1);
}

(async () => {
  try {
    const stats = fs.statSync(videoPath);
    const duracao = await obterDuracao(videoPath);
    const duracaoFormatada = formatarDuracao(duracao);

    console.log(`📡 Iniciando transmissão do evento ${id}`);
    console.log(`🎬 Duração do vídeo: ${duracaoFormatada}`);
    console.log(`📁 Tamanho do vídeo: ${Math.round(stats.size / 1024 / 1024)} MB`);
    console.log(`🔗 Transmitindo para: ${stream_url}`);

    const ffmpeg = spawn('ffmpeg', [
      '-re',
      '-i', videoPath,
      '-c:v', 'libx264',
      '-preset', 'slow', // Melhor qualidade com mais uso de CPU
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

  } catch (err) {
    console.error('❌ Erro ao iniciar a transmissão:', err.message);
    process.exit(1);
  }
})();
