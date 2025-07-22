const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

const keyFile = path.join(os.homedir(), '.config', 'rclone', 'rclone.conf');
const input = JSON.parse(fs.readFileSync('input.json', 'utf-8'));
const arquivosTemporarios = [];

function registrarTemporario(caminho) {
  arquivosTemporarios.push(caminho);
}

function limparTemporarios() {
  console.log('\n🧹 Limpando arquivos temporários...');
  for (const arq of arquivosTemporarios) {
    if (fs.existsSync(arq)) {
      fs.unlinkSync(arq);
      console.log(`🗑️ Removido: ${arq}`);
    }
  }
}

function executarFFmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log(`\n🛠️ FFmpeg:\nffmpeg ${args.join(' ')}`);
    const proc = spawn('ffmpeg', ['-y', ...args]);
    proc.stderr.on('data', d => process.stderr.write(d.toString()));
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg falhou: ${code}`)));
  });
}

async function baixarArquivo(remoto, destino, reencode = true) {
  return new Promise((resolve, reject) => {
    console.log(`⬇️ Baixando: ${remoto}`);
    const rclone = spawn('rclone', ['copy', `meudrive:${remoto}`, '.', '--config', keyFile]);
    rclone.stderr.on('data', d => process.stderr.write(d.toString()));
    rclone.on('close', async code => {
      if (code !== 0) return reject(new Error(`Erro ao baixar ${remoto}`));
      const base = path.basename(remoto);
      if (!fs.existsSync(base)) return reject(new Error(`Arquivo não encontrado: ${base}`));
      fs.renameSync(base, destino);
      console.log(`✅ Baixado: ${destino}`);
      if (reencode) {
        const temp = destino.replace(/(\.[^.]+)$/, '_temp$1');
        await reencodeVideo(destino, temp);
        fs.renameSync(temp, destino);
      }
      registrarTemporario(destino);
      resolve();
    });
  });
}

async function reencodeVideo(entrada, saida) {
  console.log(`🎞️ Reencode: ${entrada} → ${saida}`);
  await executarFFmpeg([
    '-i', entrada,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-profile:v', 'main',
    '-pix_fmt', 'yuv420p',
    '-r', '30',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-shortest',
    saida
  ]);
  registrarTemporario(saida);
}

async function obterDuracao(arquivo) {
  const { stdout } = await exec(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${arquivo}"`);
  return parseFloat(stdout.trim());
}

async function cortarVideo(inputPath, inicio, duracao, output) {
  console.log(`✂️ Cortando: ${inputPath} início: ${inicio}s duração: ${duracao}s`);
  await executarFFmpeg([
    '-i', inputPath,
    '-ss', inicio.toString(),
    '-t', duracao.toString(),
    '-c', 'copy',
    output
  ]);
  registrarTemporario(output);
}

async function aplicarOverlayParte(parte, logo, rodape, output) {
  const filtros = [
    `[0:v][1:v] overlay=W-w-10:10 [logo]`,
    `[logo][2:v] overlay=0:H-h:enable='between(t,240,250)'`
  ];
  console.log(`🖼️ Aplicando overlay: ${parte} + logo + rodapé → ${output}`);
  await executarFFmpeg([
    '-i', parte,
    '-loop', '1', '-i', logo,
    '-loop', '1', '-i', rodape,
    '-filter_complex', filtros.join('; '),
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'veryfast',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-t', (await obterDuracao(parte)).toString(),
    output
  ]);
  registrarTemporario(output);
}

async function iniciarTransmissaoEmTempoReal(listaArquivos, streamURL) {
  const playlistPath = 'sequencia_da_transmissao.txt';
  fs.writeFileSync(playlistPath, listaArquivos.map(f => `file '${f}'`).join('\n'));
  registrarTemporario(playlistPath);

  console.log(`📡 Enviando vídeos em tempo real para: ${streamURL}`);
  await executarFFmpeg([
    '-f', 'concat',
    '-safe', '0',
    '-i', playlistPath,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-profile:v', 'main',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-f', 'flv',
    streamURL
  ]);
}

(async () => {
  try {
    console.log('🚀 Preparando vídeos para live...');

    const arquivos = [
      { campo: 'video_principal', saida: 'video_principal.mp4' },
      { campo: 'video_inicial', saida: 'video_inicial.mp4' },
      { campo: 'video_miraplay', saida: 'video_miraplay.mp4' },
      { campo: 'video_final', saida: 'video_final.mp4' },
      { campo: 'logo_id', saida: 'logo.png', reencode: false },
      { campo: 'rodape_id', saida: 'rodape.png', reencode: false }
    ];

    for (const arq of arquivos) {
      const origem = input[arq.campo];
      if (origem) await baixarArquivo(origem, arq.saida, arq.reencode !== false);
    }

    for (let i = 0; i < input.videos_extras.length; i++) {
      await baixarArquivo(input.videos_extras[i], `extra${i}.mp4`);
    }

    const duracao = await obterDuracao('video_principal.mp4');
    const metade = duracao / 2;
    await cortarVideo('video_principal.mp4', 0, metade, 'parte1_bruta.mp4');
    await cortarVideo('video_principal.mp4', metade, metade, 'parte2_bruta.mp4');

    await aplicarOverlayParte('parte1_bruta.mp4', 'logo.png', 'rodape.png', 'parte1.mp4');
    await aplicarOverlayParte('parte2_bruta.mp4', 'logo.png', 'rodape.png', 'parte2.mp4');

    console.log('✅ Vídeos prontos! Criando sequência da live...');

    const sequencia = ['parte1.mp4'];

    if (fs.existsSync('video_inicial.mp4')) sequencia.push('video_inicial.mp4');
    if (fs.existsSync('video_miraplay.mp4')) sequencia.push('video_miraplay.mp4');

    const extras = fs.readdirSync('.').filter(f => /^extra\d+\.mp4$/.test(f)).sort();
    sequencia.push(...extras);

    if (fs.existsSync('video_inicial.mp4')) sequencia.push('video_inicial.mp4');
    sequencia.push('parte2.mp4');
    if (fs.existsSync('video_final.mp4')) sequencia.push('video_final.mp4');

    console.log('📜 Sequência criada:');
    console.log(sequencia.map(s => ' - ' + s).join('\n'));

    await iniciarTransmissaoEmTempoReal(sequencia, input.stream_url);

    console.log('🎉 Live finalizada com sucesso!');
    limparTemporarios();

  } catch (err) {
    console.error('\n❌ ERRO DETECTADO:', err.message);
    limparTemporarios();
    process.exit(1);
  }
})();
