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
  for (const arq of arquivosTemporarios) {
    if (fs.existsSync(arq)) {
      fs.unlinkSync(arq);
      console.log(`🧹 Arquivo temporário removido: ${arq}`);
    }
  }
}

function executarFFmpeg(args, options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`🛠️ Executando FFmpeg:\nffmpeg ${args.join(' ')}`);
    const ffmpeg = spawn('ffmpeg', ['-y', ...args], options);
    ffmpeg.stdout.on('data', data => process.stdout.write(data.toString()));
    ffmpeg.stderr.on('data', data => process.stderr.write(data.toString()));
    ffmpeg.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`❌ FFmpeg falhou com código ${code}`));
    });
  });
}

async function baixarArquivo(remoto, destino) {
  return new Promise((resolve, reject) => {
    console.log(`⬇️ Baixando de: ${remoto}`);
    const rclone = spawn('rclone', ['copy', `meudrive:${remoto}`, '.', '--config', keyFile]);
    rclone.stderr.on('data', data => process.stderr.write(data.toString()));
    rclone.on('close', async code => {
      if (code !== 0) return reject(new Error(`Erro ao baixar ${remoto}`));
      const base = path.basename(remoto);
      if (!fs.existsSync(base)) return reject(new Error(`Arquivo não encontrado: ${base}`));
      fs.renameSync(base, destino);
      console.log(`✅ Arquivo baixado: ${destino}`);

      const temp = destino.replace(/(\.[^.]+)$/, '_temp$1');
      await reencode(destino, temp);
      fs.renameSync(temp, destino);

      registrarTemporario(destino);
      resolve();
    });
  });
}

async function reencode(entrada, saida) {
  console.log(`🎞️ Recodificando: ${entrada} → ${saida}`);
  await executarFFmpeg([
    '-i', entrada,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-profile:v', 'main',
    '-pix_fmt', 'yuv420p',
    '-r', '30',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-shortest',
    saida
  ]);
  registrarTemporario(saida);
}

async function obterDuracao(arquivo) {
  console.log(`⏱️ Calculando duração de: ${arquivo}`);
  const { stdout } = await exec(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${arquivo}"`);
  return parseFloat(stdout.trim());
}

async function cortarVideo(entrada, inicio, fim, saida) {
  console.log(`✂️ Cortando vídeo: ${entrada} de ${inicio}s até ${fim}s → ${saida}`);
  await executarFFmpeg([
    '-ss', inicio.toString(),
    '-to', fim.toString(),
    '-i', entrada,
    '-c:v', 'libx264',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-shortest',
    saida
  ]);
  registrarTemporario(saida);
}

async function inserirLogo(videoInput, logo, saida) {
  console.log(`🏷️ Inserindo logo em: ${videoInput}`);
  await executarFFmpeg([
    '-i', videoInput,
    '-i', logo,
    '-filter_complex', '[0:v][1:v] overlay=W-w-20:20',
    '-map', '0:v',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-shortest',
    saida
  ]);
  registrarTemporario(saida);
}

async function transmitirSequencia() {
  try {
    console.log('🚦 Iniciando preparação da live...');

    const videoPrincipal = 'video_principal.mp4';
    const logo = 'logo.mp4';
    const rodape = 'rodape.mp4';

    await baixarArquivo(input.video_principal, videoPrincipal);
    await baixarArquivo(input.logo_id, logo);
    await baixarArquivo(input.rodape_id, rodape);

    const duracao = await obterDuracao(videoPrincipal);
    const metade = duracao / 2;

    const parte1 = 'parte1.mp4';
    const parte2 = 'parte2.mp4';

    await cortarVideo(videoPrincipal, 0, metade, parte1);
    await cortarVideo(videoPrincipal, metade, duracao, parte2);

    const parte1Logo = 'parte1_logo.mp4';
    await inserirLogo(parte1, logo, parte1Logo);

    async function baixarEPreparar(caminho, nomeLocal) {
      if (!caminho) return null;
      await baixarArquivo(caminho, nomeLocal);
      const reencoded = 'reenc_' + nomeLocal;
      await reencode(nomeLocal, reencoded);
      return reencoded;
    }

    const videoInicial = await baixarEPreparar(input.video_inicial, 'video_inicial.mp4');
    const videoMiraplay = await baixarEPreparar(input.video_miraplay, 'video_miraplay.mp4');
    const videoFinal = await baixarEPreparar(input.video_final, 'video_final.mp4');

    const extras = [];
    for (let i = 0; i < input.videos_extras.length; i++) {
      const nomeExtra = `extra_${i}.mp4`;
      const reencExtra = await baixarEPreparar(input.videos_extras[i], nomeExtra);
      if (reencExtra) extras.push(reencExtra);
    }

    const inputs = [
      { path: parte1Logo, withRodape: false },
      { path: videoInicial, withRodape: true },
      { path: videoMiraplay, withRodape: true },
      ...extras.map(p => ({ path: p, withRodape: true })),
      { path: videoInicial, withRodape: true },
      { path: parte2, withRodape: true },
      { path: videoFinal, withRodape: true }
    ].filter(Boolean);

    const ffmpegArgs = [];
    const filterParts = [];
    const videoLabels = [];

    inputs.forEach((input, i) => {
      ffmpegArgs.push('-i', input.path);
    });

    ffmpegArgs.push('-i', logo);     // logo = penúltimo input
    ffmpegArgs.push('-i', rodape);   // rodape = último input

    const logoIdx = inputs.length;
    const rodapeIdx = inputs.length + 1;

    inputs.forEach((input, i) => {
      filterParts.push(`[${i}:v]scale=1280:720[vs${i}]`);
      if (input.withRodape) {
        filterParts.push(`[${rodapeIdx}:v]scale=426:240[rod${i}]`);
        filterParts.push(`[vs${i}][rod${i}]overlay=W-w-50:H-h-10[tmp${i}]`);
        filterParts.push(`[tmp${i}][${logoIdx}:v]overlay=W-w-20:20[v${i}]`);
      } else {
        filterParts.push(`[vs${i}][${logoIdx}:v]overlay=W-w-20:20[v${i}]`);
      }
      videoLabels.push(`[v${i}]`);
    });

    const filter = filterParts.join('; ') + `; ${videoLabels.join('')}concat=n=${videoLabels.length}:v=1:a=0[outv]`;

    const args = [
      '-hide_banner',
      '-loglevel', 'info',
      ...ffmpegArgs,
      '-filter_complex', filter,
      '-map', '[outv]',
      ...inputs.map((_, i) => ['-map', `${i}:a?`]).flat(),
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-f', 'flv',
      input.stream_url
    ];

    console.log('🚀 Transmitindo para:', input.stream_url);
    const ffmpegProc = spawn('ffmpeg', args, { stdio: 'inherit' });

    ffmpegProc.on('exit', code => {
      console.log(code === 0 ? '✅ Live finalizada com sucesso.' : `❌ Erro na live. Código: ${code}`);
      limparTemporarios();
    });

  } catch (err) {
    console.error('❌ Erro:', err.message || err);
    limparTemporarios();
    process.exit(1);
  }
}

transmitirSequencia();
