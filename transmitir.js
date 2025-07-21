const fs = require('fs');
const { spawn } = require('child_process');

// Verificar se o arquivo stream_info.json existe
if (!fs.existsSync('stream_info.json')) {
  console.error('❌ stream_info.json não encontrado');
  process.exit(1);
}

// Ler URL do stream
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

console.log('🚀 Transmitindo em 1280x720 (HD) - Bitrate reduzido');
console.log(`🎯 URL de destino: ${streamUrl}`);

// Buffer para capturar erros
let stderrBuffer = '';

const ffmpeg = spawn('ffmpeg', [
  '-re',                      // Tempo real
  '-i', inputFile,            // Entrada
  '-vf', 'scale=1280:720',    // Reduz resolução
  '-c:v', 'libx264',          // Vídeo: H.264
  '-preset', 'veryfast',      // Desempenho
  '-b:v', '3000k',            // Bitrate de vídeo mais leve
  '-maxrate', '3500k',        // Pico de bitrate
  '-bufsize', '5000k',        // Buffer
  '-pix_fmt', 'yuv420p',      // Compatibilidade
  '-g', '50',                 // Keyframes
  '-c:a', 'aac',              // Áudio: AAC
  '-b:a', '128k',             // Bitrate de áudio menor
  '-ar', '44100',             // Sample rate
  '-f', 'flv',                // Formato RTMP
  streamUrl                   // Destino
]);

// Captura do stderr
ffmpeg.stderr.on('data', data => {
  const msg = data.toString();
  stderrBuffer += msg;
  process.stderr.write(msg);
});

// Finalização
ffmpeg.on('close', code => {
  console.log('\n🔚 FFmpeg finalizado');
  if (code === 0) {
    console.log('✅ Transmissão concluída com sucesso');
  } else {
    console.error(`❌ FFmpeg terminou com código ${code}`);
    const ultimas = stderrBuffer.split('\n').slice(-30).filter(l => l.trim() !== '');
    const ultimaLinha = ultimas[ultimas.length - 1] || 'Sem detalhes';

    console.log('\n📄 Últimas mensagens relevantes do FFmpeg:');
    console.log(ultimas.join('\n'));

    console.log('\n🔍 Última linha de erro detectada:');
    console.error('👉', ultimaLinha);

    // Sugestão de causa
    if (ultimaLinha.includes('TLS') || ultimaLinha.includes('Input/output error')) {
      console.error('⚠️ Problema possível: erro de conexão (RTMPS), verifique chave de transmissão ou conectividade.');
    } else if (ultimaLinha.includes('Could not write') || ultimaLinha.includes('Connection reset')) {
      console.error('⚠️ Problema ao enviar dados. Verifique internet ou bloqueio na plataforma de destino.');
    }
  }
});

// Erro direto no spawn
ffmpeg.on('error', err => {
  console.error('❌ Erro ao executar FFmpeg:', err.message || err);
});
