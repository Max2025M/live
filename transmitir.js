const fs = require('fs');
const { spawn } = require('child_process');

// Verificar stream_info.json
if (!fs.existsSync('stream_info.json')) {
  console.error('❌ stream_info.json não encontrado');
  process.exit(1);
}

const info = JSON.parse(fs.readFileSync('stream_info.json', 'utf-8'));
const streamUrl = info.stream;

if (!streamUrl || !streamUrl.startsWith('rtmp')) {
  console.error('❌ URL de stream inválida:', streamUrl);
  process.exit(1);
}

// Verificar vídeo
const inputFile = 'video_final_completo.mp4';
if (!fs.existsSync(inputFile)) {
  console.error(`❌ Arquivo ${inputFile} não encontrado`);
  process.exit(1);
}

console.log('🚀 Transmitindo para YouTube/Facebook em proporção 16:9 (1920x1080)');

let lastErrorLine = '';

// Comando FFmpeg
const ffmpeg = spawn('ffmpeg', [
  '-re',                            // Tempo real
  '-i', inputFile,                  // Arquivo de entrada
  '-vf', 'scale=1920:1080',        // Escala para 1080p (16:9)
  '-c:v', 'libx264',               // Codificador de vídeo
  '-preset', 'veryfast',           // Performance (pode ajustar)
  '-b:v', '6000k',                 // Bitrate de vídeo (6 Mbps)
  '-maxrate', '6500k',             // Máximo de bitrate
  '-bufsize', '9000k',             // Buffer
  '-pix_fmt', 'yuv420p',           // Compatibilidade
  '-g', '50',                     // Keyframe a cada ~2s (25fps)
  '-c:a', 'aac',                  // Áudio AAC
  '-b:a', '160k',                 // Bitrate de áudio
  '-ar', '44100',                 // Frequência de áudio
  '-f', 'flv',                    // Formato RTMP
  streamUrl                       // URL destino
]);

// Capturar saída de erro do FFmpeg (stream do servidor também aparece aqui)
ffmpeg.stderr.on('data', data => {
  const texto = data.toString();
  process.stderr.write(texto);

  // Guardar a última linha não vazia para mostrar em caso de erro
  const linhas = texto.trim().split('\n').filter(l => l.trim());
  if (linhas.length > 0) {
    lastErrorLine = linhas[linhas.length - 1];
  }
});

ffmpeg.on('close', code => {
  if (code === 0) {
    console.log('✅ Transmissão finalizada com sucesso');
  } else {
    console.error(`❌ FFmpeg terminou com código ${code}`);
    if (lastErrorLine) {
      console.error(`Última mensagem de erro: ${lastErrorLine}`);
    }
    process.exit(code);
  }
});
