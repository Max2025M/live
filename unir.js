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

/**
 * Reencode vídeo para padrão fixo:
 * - Resolução 1280x720
 * - Codec vídeo libx264, preset veryfast, crf 23
 * - Codec áudio AAC 128k
 * - Taxa de frames 25 fps
 * - Formato mp4
 */
async function reencodePadronizado(inputFile, outputFile) {
  await executarFFmpeg([
    '-i', inputFile,
    '-vf', 'scale=1280:720',
    '-r', '25',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart', // ajuda em compatibilidade de streaming
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

        // Só reencode se for vídeo (supondo extensão mp4)
        if (destino.toLowerCase().endsWith('.mp4')) {
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
    '-i', videoPath,
    '-t', metade.toFixed(2),
    '-r', '25',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    parte1
  ], parte1);

  await executarFFmpeg([
    '-i', videoPath,
    '-ss', metade.toFixed(2),
    '-r', '25',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    parte2
  ], parte2);
}

async function inserirRodape(principal, rodape, logo, saida) {
  const duracaoRodape = await obterDuracao(rodape);
  const fimRodape = 240 + duracaoRodape;

  await executarFFmpeg([
    '-i', principal,
    '-i', rodape,
    '-i', logo,
    '-filter_complex',
    `
    [0:v]trim=0:240,setpts=PTS-STARTPTS[pre];
    [0:v]trim=240:${fimRodape},setpts=PTS-STARTPTS[cut];
    [1:v]scale=1280:720[rod];
    [cut]scale=426:240[mini];
    [rod][mini]overlay=W-w-50:90[tmp];
    [tmp][2:v]overlay=W-w-10:10[rodfinal];
    [0:v]trim=${fimRodape},setpts=PTS-STARTPTS[post];
    [post][2:v]overlay=W-w-10:10[postlogo];
    [pre][2:v]overlay=W-w-10:10[prelogo];
    [prelogo][rodfinal][postlogo]concat=n=3:v=1:a=0[outv]
    `.replace(/\s+/g, ' ').trim(),
    '-map', '[outv]', '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-c:a', 'aac',
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
      rtmpUrl
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

  // Baixar e reencode padronizado de todos os vídeos (logo assumed PNG)
  await baixarERegistrar('video_principal', 'video_principal.mp4');
  await baixarERegistrar('video_inicial', 'video_inicial.mp4');
  await baixarERegistrar('video_miraplay', 'video_miraplay.mp4');
  await baixarERegistrar('video_final', 'video_final.mp4');
  await baixarERegistrar('rodape_id', 'rodape.mp4');
  await baixarERegistrar('logo_id', 'logo.png'); // imagem, não reencode

  const extras = [];
  for (let i = 0; i < input.videos_extras.length; i++) {
    const nome = `extra_${i}.mp4`;
    await baixarArquivo(input.videos_extras[i], nome);
    extras.push(nome);
  }

  await cortarMeio(arquivos.video_principal, 'parte1.mp4', 'parte2.mp4');

  await inserirRodape('parte1.mp4', arquivos.rodape_id, arquivos.logo_id, 'parte1_final.mp4');
  await inserirRodape('parte2.mp4', arquivos.rodape_id, arquivos.logo_id, 'parte2_final.mp4');

  const ordem = [
    'parte1_final.mp4',
    'video_inicial.mp4',
    'video_miraplay.mp4',
    ...extras,
    'video_inicial.mp4',
    'parte2_final.mp4',
    'video_final.mp4'
  ];

  const listaConcat = 'lista.txt';
  fs.writeFileSync(listaConcat, ordem.map(v => `file '${v}'`).join('\n'));

  await executarFFmpeg([
    '-f', 'concat',
    '-safe', '0',
    '-i', listaConcat,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-c:a', 'aac',
    '-r', '25',
    'video_final_completo.mp4'
  ], 'video_final_completo.mp4');

  const stats = fs.statSync('video_final_completo.mp4');
  const duracaoFinal = await obterDuracao('video_final_completo.mp4');
  const duracaoFormatada = formatarDuracao(duracaoFinal);
  const tamanhoMB = Math.round(stats.size / 1024 / 1024);

  fs.writeFileSync('stream_info.json', JSON.stringify({
    id: input.id,
    stream: input.stream_url
  }, null, 2));

  console.log(`✅ Finalizado com ${tamanhoMB} MB e duração ${duracaoFormatada}`);

  await transmitirFacebook('video_final_completo.mp4', input.stream_url);
}

montarSequencia()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Erro:', err.message);
    process.exit(1);
  });
