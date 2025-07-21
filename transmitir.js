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

// Verificar vídeo de entrada
const inputFile = 'video_final_completo.mp4';
if (!fs.existsSync(inputFile)) {
  console.error(`❌ Arquivo ${inputFile} não encontrado`);
  process.exit(1);
}

console.log('🚀 Transmitindo para YouTube/Facebook em proporção 16:9 (1920x1080)');
console.log(`🎯 URL de destino: ${streamUrl}`);

let stderrBuffer = '';

const ffmpeg = spawn('ffmpeg', [
  '-re',                            // Tempo real
  '-i', inputFile,                  // Arquivo de entrada
  '-vf', 'scale=1920:1080',         // Escala para 1080p
  '-c:v', 'libx264',                // Codificador de vídeo
  '-preset', 'veryfast',            // Performance
  '-b:v', '6000k',                  // Bitrate vídeo
  '-maxrate', '6500k',              // Bitrate máximo
  '-bufsize', '9000k',              // Buffer
  '-pix_fmt', 'yuv420p',            // Compatibilidade
  '-g', '50',                       // Keyframe a cada 2s (25fps)
  '-c:a', 'aac',                    // Codificador de áudio
  '-b:a', '160k',                   // Bitrate de áudio
  '-ar', '44100',                   // Sample rate
  '-f', 'flv',                      // Formato de saída
  streamUrl                         // URL de destino
]);

// Captura o stderr e também imprime ao vivo
ffmpeg.stderr.on('data', data => {
  const msg = data.toString();
  stderrBuffer += msg;
  process.stderr.write(msg);
});

// Quando o processo terminar, exibe resumo
ffmpeg.on('close', code => {
  console.log('\n🔚 FFmpeg finalizado');
  if (code === 0) {
    console.log('✅ Transmissão finalizada com sucesso');
  } else {
    console.error(`❌ FFmpeg terminou com código ${code}`);
    if (stderrBuffer.includes('TLS') || stderrBuffer.includes('Input/output error')) {
      console.error('\n⚠️ Detalhe: erro de conexão TLS. Verifique se a chave está correta ou se há problema com a URL RTMPS.');
    }
    console.log('\n📄 Últimas mensagens do FFmpeg:');
    console.log(stderrBuffer.split('\n').slice(-20).join('\n')); // mostra últimas 20 linhas
  }
});

ffmpeg.on('error', err => {
  console.error('❌ Erro ao executar o FFmpeg:', err.message || err);
});
