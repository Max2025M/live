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

async function reencodePadronizado(inputFile, outputFile) {
  await executarFFmpeg([
    '-fflags', '+genpts',
    '-avoid_negative_ts', 'make_zero',
    '-i', inputFile,
    '-vf', 'scale=1280:720',
    '-r', '25',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-map', '0:v:0',
    '-map', '0:a?',
    '-shortest',
    '-movflags', '+faststart',
    '-vsync', '1', 
    '-async', '1', 
    '-copyts',  
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

        if (destino.toLowerCase().endswith('.mp4')) {
          const temp = destino.replace(/(\.[^.]+)$/, '_temp$1');
          await reencodePadronizado(destino, temp);
          fs.renameSync(temp, destino);
          console.log(`📥 Vídeo reencodado e padronizado: ${destino}`);
        } else {
          console.log(`📥 Arquivo não é mp4, pulando reencode: ${destino}`);
        }

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

  await executarFFmpeg([
    '-fflags', '+genpts',
    '-avoid_negative_ts', 'make_zero',
    '-i', videoPath,
    '-t', metade.toFixed(2),
    '-r', '25',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-map', '0:v:0',
    '-map', '0:a?',
    '-shortest',
    '-vsync', '1',
    '-async', '1',
    '-copyts',
    parte1
  ], parte1);

  await executarFFmpeg([
    '-fflags', '+genpts',
    '-avoid_negative_ts', 'make_zero',
    '-i', videoPath,
    '-ss', metade.toFixed(2),
    '-r', '25',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-map', '0:v:0',
    '-map', '0:a?',
    '-shortest',
    '-vsync', '1',
    '-async', '1',
    '-copyts',
    parte2
  ], parte2);
}

async function inserirRodape(principal, rodape, logo, saida) {
  const duracaoRodape = await obterDuracao(rodape);
  const inicioRodape = 240;
  const fimRodape = inicioRodape + duracaoRodape;

  await executarFFmpeg([
    '-fflags', '+genpts',
    '-avoid_negative_ts', 'make_zero',
    '-i', principal,
    '-i', rodape,
    '-i', logo,
    '-filter_complex',
    `
    [0:v]trim=0:${inicioRodape},setpts=PTS-STARTPTS[pre];
    [0:v]trim=${inicioRodape}:${fimRodape},setpts=PTS-STARTPTS[cut];
    [0:v]trim=${fimRodape},setpts=PTS-STARTPTS[post];
    [1:v]scale=1280:720[rod];
    [cut]scale=1920:1080[mainvideo];  // Aumentando o tamanho do vídeo principal
    [rod][mainvideo]overlay=W-w-50:90[tmp];  // Ajustando o overlay para o rodapé
    [tmp][2:v]scale=200:200[logo_scaled];  // Ajustando o tamanho do logo para 200x200
    [logo_scaled]overlay=W-w-20:20[rodfinal]; // Logo posicionado no canto superior direito
    [pre][2:v]overlay=W-w-20:20[prelogo];
    [post][2:v]overlay=W-w-20:20[postlogo];
    [prelogo][rodfinal][postlogo]concat=n=3:v=1:a=0[outv]
    `.replace(/\s+/g, ' ').trim(),
    '-map', '[outv]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-c:a', 'aac',
    '-shortest',
    '-vsync', '1',
    '-async', '1',
    '-copyts',
    saida
  ], saida);
}

async function transmitirFacebook(videoPath, rtmpUrl) {
  console.log(`📡 Iniciando transmissão para: ${rtmpUrl}`);
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-re',
      '-i', videoPath,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-maxrate', '3000k',
      '-bufsize', '6000k',
      '-pix_fmt', 'yuv420p',
      '-g', '50',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-f', 'flv',
      rtmpUrl,
      '-vsync', '1',
      '-async', '1',
      '-copyts',
    ]);
    ffmpeg.stderr.on('data', data => process.stderr.write(data));
    ffmpeg.on('close', code => {
      if (code === 0) {
        console.log('✅ Transmissão concluída com sucesso!');
        resolve();
      } else {
        reject(new Error(`❌ Falha na transmissão. Código ${code}`));
      }
    });
  });
}

async function montarSequencia() {
  const arquivos = {};

  async function baixarERegistrar(key, nomeFinal) {
    if (!input[key]) return;
    await baixarArquivo(input[key], nomeFinal);
    arquivos[key] = nomeFinal;
  }

  await baixarERegistrar('video_principal', 'video.mp4');
  await baixarERegistrar('video_rodape', 'rodape.mp4');
  await baixarERegistrar('logo', 'logo.png');
  await baixarERegistrar('rtmpUrl', 'rtmpUrl.txt');

  const rtmpUrl = fs.readFileSync('rtmpUrl.txt', 'utf-8').trim();
  console.log(`RTMP URL: ${rtmpUrl}`);

  const parte1 = 'parte1.mp4';
  const parte2 = 'parte2.mp4';

  await cortarMeio(arquivos.video_principal, parte1, parte2);
  await inserirRodape(parte1, arquivos.video_rodape, arquivos.logo, 'video_com_rodape.mp4');
  await transmitirFacebook('video_com_rodape.mp4', rtmpUrl);
}

montarSequencia().catch(err => {
  console.error(err);
});
