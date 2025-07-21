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

function executarFFmpeg(args, outputLabel) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', ['-y', ...args]);
    ffmpeg.stderr.on('data', data => process.stderr.write(data));
    ffmpeg.on('close', code => {
      if (code === 0) {
        console.log(`✅ Criado: ${outputLabel}`);
        resolve();
      } else {
        reject(new Error(`❌ FFmpeg falhou com código ${code}`));
      }
    });
  });
}

async function obterDuracao(videoPath) {
  const { stdout } = await exec(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`);
  return parseFloat(stdout.trim());
}

function formatarDuracao(segundos) {
  const m = Math.floor(segundos / 60);
  const s = Math.floor(segundos % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function reencode(inputFile, outputFile) {
  await executarFFmpeg([
    '-i', inputFile,
    '-vf', 'scale=1280:720',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-f', 'mp4',
    outputFile
  ], outputFile);
}

async function baixarArquivo(remoto, destino) {
  return new Promise((resolve, reject) => {
    const rclone = spawn('rclone', ['copy', `meudrive:${remoto}`, '.', '--config', keyFile]);
    rclone.stderr.on('data', data => process.stderr.write(data));
    rclone.on('close', async code => {
      if (code === 0) {
        const nome = path.basename(remoto);
        if (!fs.existsSync(nome)) return reject(new Error(`Arquivo não encontrado: ${nome}`));
        fs.renameSync(nome, destino);
        registrarTemporario(destino);

        const temp = destino.replace(/(\.[^.]+)$/, '_temp$1');
        await reencode(destino, temp);
        fs.renameSync(temp, destino);
        console.log(`📥 Arquivo baixado e reencodado: ${destino}`);
        resolve();
      } else {
        reject(new Error(`Erro ao baixar ${remoto}`));
      }
    });
  });
}

async function cortarMeio(videoPath, parte1, parte2) {
  const duracao = await obterDuracao(videoPath);
  const metade = duracao / 2;

  await executarFFmpeg(['-i', videoPath, '-t', metade.toFixed(2), '-c', 'copy', parte1], parte1);
  await executarFFmpeg(['-i', videoPath, '-ss', metade.toFixed(2), '-c', 'copy', parte2], parte2);
}

async function inserirRodape(principal, rodape, logo, saida) {
  const duracaoRodape = await obterDuracao(rodape);

  await executarFFmpeg([
    '-i', principal,
    '-i', rodape,
    '-i', logo,
    '-filter_complex',
    `[0:v]trim=0:240,setpts=PTS-STARTPTS[v0];` +
    `[0:v]trim=240:${240 + duracaoRodape},setpts=PTS-STARTPTS,scale=1000:500[v1];` +
    `[1:v]scale=1280:720[v2];` +
    `[2:v]scale=120:120[logo];` +
    `[v2][v1]overlay=W-w-50:90[tmp];` +
    `[tmp][logo]overlay=W-w-10:10[v_rod];` +
    `[0:v]trim=${240 + duracaoRodape},setpts=PTS-STARTPTS[v3];` +
    `[v0][v_rod][v3]concat=n=3:v=1:a=0[outv]`,
    '-map', '[outv]', '-map', '0:a?',
    '-c:v', 'libx264',
    '-c:a', 'aac',
    saida
  ], saida);
}

function normalizarStreamUrl(url) {
  if (!url) return null;
  return url.replace(/(rtmps:\/\/[^/]+\/rtmp)\/+/, '$1/');
}

async function transmitirLive(arquivo, streamUrl) {
  return new Promise((resolve, reject) => {
    console.log(`🚀 Iniciando transmissão ao vivo para: ${streamUrl}`);
    const ffmpeg = spawn('ffmpeg', [
      '-re',
      '-i', arquivo,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-b:v', '3000k',
      '-maxrate', '3000k',
      '-bufsize', '6000k',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-f', 'flv',
      streamUrl
    ]);

    ffmpeg.stderr.on('data', data => process.stderr.write(data));
    ffmpeg.on('close', code => {
      if (code === 0) {
        console.log('✅ Live encerrada com sucesso!');
        resolve();
      } else {
        reject(new Error(`❌ Live falhou com código ${code}`));
      }
    });
  });
}

function limparArquivosTemporarios() {
  console.log('🧹 Limpando arquivos temporários...');
  for (const arquivo of arquivosTemporarios) {
    try {
      if (fs.existsSync(arquivo)) fs.unlinkSync(arquivo);
    } catch (err) {
      console.warn(`⚠️ Falha ao remover ${arquivo}: ${err.message}`);
    }
  }
  console.log('✅ Limpeza concluída.');
}

async function montarSequencia() {
  const arquivos = {};

  async function baixarERegistrar(key, nomeFinal) {
    if (!input[key]) return;
    await baixarArquivo(input[key], nomeFinal);
    arquivos[key] = nomeFinal;
  }

  await baixarERegistrar('video_principal', 'video_principal.mp4');
  await baixarERegistrar('video_inicial', 'video_inicial.mp4');
  await baixarERegistrar('video_miraplay', 'video_miraplay.mp4');
  await baixarERegistrar('video_final', 'video_final.mp4');
  await baixarERegistrar('logo_id', 'logo.png');
  await baixarERegistrar('rodape_id', 'rodape.mp4');

  const extras = [];
  if (Array.isArray(input.videos_extras)) {
    for (let i = 0; i < input.videos_extras.length; i++) {
      const nome = `extra_${i}.mp4`;
      await baixarArquivo(input.videos_extras[i], nome);
      extras.push(nome);
    }
  }

  await cortarMeio(arquivos.video_principal, 'parte1.mp4', 'parte2.mp4');
  registrarTemporario('parte1.mp4');
  registrarTemporario('parte2.mp4');

  let parte1_final = 'parte1_final.mp4';
  let parte2_final = 'parte2_final.mp4';
  registrarTemporario(parte1_final);
  registrarTemporario(parte2_final);

  await inserirRodape('parte1.mp4', arquivos.rodape_id, arquivos.logo_id, parte1_final);
  await inserirRodape('parte2.mp4', arquivos.rodape_id, arquivos.logo_id, parte2_final);

  const ordem = [
    parte1_final,
    'video_inicial.mp4',
    'video_miraplay.mp4',
    ...extras,
    'video_inicial.mp4',
    parte2_final,
    'video_final.mp4'
  ];

  const listaConcat = 'lista.txt';
  fs.writeFileSync(listaConcat, ordem.map(v => `file '${v}'`).join('\n'));
  registrarTemporario(listaConcat);

  const arquivoFinal = 'video_final_completo.mp4';
  registrarTemporario(arquivoFinal);

  await executarFFmpeg([
    '-f', 'concat',
    '-safe', '0',
    '-i', listaConcat,
    '-c', 'copy',
    arquivoFinal
  ], arquivoFinal);

  const streamUrl = normalizarStreamUrl(input.stream_url);
  if (!streamUrl) throw new Error('URL da stream não encontrada.');

  await transmitirLive(arquivoFinal, streamUrl);
  limparArquivosTemporarios();
}

montarSequencia()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Erro:', err.message);
    process.exit(1);
  });
