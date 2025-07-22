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

function executarFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', ['-y', ...args]);
    ffmpeg.stdout.on('data', data => process.stdout.write(data));
    ffmpeg.stderr.on('data', data => process.stderr.write(data));
    ffmpeg.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`❌ FFmpeg falhou com o código ${code}`));
    });
  });
}

async function baixarVideo(remoto, destino) {
  return new Promise((resolve, reject) => {
    const rclone = spawn('rclone', ['copy', `meudrive:${remoto}`, '.', '--config', keyFile]);
    rclone.stderr.on('data', data => process.stderr.write(data));
    rclone.on('close', async code => {
      if (code === 0) {
        const nome = path.basename(remoto);
        if (!fs.existsSync(nome)) return reject(new Error(`Arquivo não encontrado: ${nome}`));
        fs.renameSync(nome, destino);

        if (destino.toLowerCase().endsWith('.mp4')) {
          const temp = destino.replace(/(\.[^.]+)$/, '_temp$1');
          await reencode(destino, temp);
          fs.renameSync(temp, destino);
        }
        registrarTemporario(destino);
        resolve();
      } else {
        reject(new Error(`Erro ao baixar ${remoto}`));
      }
    });
  });
}

async function obterDuracao(arquivo) {
  const { stdout } = await exec(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${arquivo}"`);
  return parseFloat(stdout.trim());
}

async function cortarVideo(video, parte1, parte2) {
  const duracao = await obterDuracao(video);
  const meio = duracao / 2;

  await executarFFmpeg(['-i', video, '-t', meio.toString(), '-c', 'copy', parte1]);
  await executarFFmpeg(['-i', video, '-ss', meio.toString(), '-c', 'copy', parte2]);

  registrarTemporario(parte1);
  registrarTemporario(parte2);
}

async function reencode(input, output) {
  await executarFFmpeg([
    '-i', input,
    '-vf', 'scale=1280:720,setdar=16/9',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    output
  ]);
}

async function inserirRodapeELogoSempreVisivel(videoInput, rodape, logo, saida) {
  const inicioRodape = 4 * 60;
  const duracaoRodape = await obterDuracao(rodape);
  const fimRodape = inicioRodape + duracaoRodape;

  await executarFFmpeg([
    '-fflags', '+genpts',
    '-avoid_negative_ts', 'make_zero',
    '-i', videoInput,
    '-i', rodape,
    '-i', logo,
    '-filter_complex',
    `
    [0:v]trim=0:${inicioRodape},setpts=PTS-STARTPTS[pre];
    [0:v]trim=${inicioRodape}:${fimRodape},setpts=PTS-STARTPTS[cut];
    [0:v]trim=${fimRodape},setpts=PTS-STARTPTS[post];
    [1:v]scale=1280:720[rod];
    [cut]scale=426:240[mini];
    [rod][mini]overlay=W-w-50:90[tmpcut];
    [tmpcut][2:v]overlay=W-w-20:20[cut_logo];
    [pre][2:v]overlay=W-w-20:20[pre_logo];
    [post][2:v]overlay=W-w-20:20[post_logo];
    [pre_logo][cut_logo][post_logo]concat=n=3:v=1:a=0[outv]
    `,
    '-map', '[outv]',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-an',
    saida
  ]);
  registrarTemporario(saida);
}

async function unirVideos(lista, saidaFinal) {
  const listFile = 'lista.txt';
  fs.writeFileSync(listFile, lista.map(v => `file '${v}'`).join('\n'));
  await executarFFmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', saidaFinal]);
}

async function iniciarLive(streamUrl, arquivo) {
  await executarFFmpeg([
    '-re',
    '-i', arquivo,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-maxrate', '3000k',
    '-bufsize', '6000k',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-f', 'flv',
    streamUrl
  ]);
}

(async () => {
  const {
    video_principal,
    video_inicial,
    video_miraplay,
    video_final,
    rodape_id,
    logo_id,
    videos_extras,
    stream_url
  } = input;

  // Baixar e preparar partes principais
  await baixarVideo(video_principal, 'principal.mp4');
  await cortarVideo('principal.mp4', 'parte1.mp4', 'parte2.mp4');
  await baixarVideo(rodape_id, 'rodape.mp4');
  await baixarVideo(logo_id, 'logo.png');

  await inserirRodapeELogoSempreVisivel('parte1.mp4', 'rodape.mp4', 'logo.png', 'parte1_final.mp4');
  await inserirRodapeELogoSempreVisivel('parte2.mp4', 'rodape.mp4', 'logo.png', 'parte2_final.mp4');

  // Baixar outros vídeos
  if (video_inicial) await baixarVideo(video_inicial, 'video_inicial.mp4');
  if (video_miraplay) await baixarVideo(video_miraplay, 'video_miraplay.mp4');
  if (video_final) await baixarVideo(video_final, 'video_final.mp4');

  const extrasPaths = [];
  for (let i = 0; i < videos_extras.length; i++) {
    const nome = `extra_${i}.mp4`;
    await baixarVideo(videos_extras[i], nome);
    extrasPaths.push(nome);
  }

  // Montar ordem exata
  const ordemFinal = [
    'parte1_final.mp4',
    'video_inicial.mp4',
    'video_miraplay.mp4',
    ...extrasPaths,
    'video_inicial.mp4',
    'parte2_final.mp4',
    'video_final.mp4'
  ].filter(Boolean);

  await unirVideos(ordemFinal, 'video_final_completo.mp4');
  console.log('✅ Vídeo final montado com sucesso.');

  await iniciarLive(stream_url, 'video_final_completo.mp4');
  console.log('📡 Transmissão iniciada.');

  arquivosTemporarios.forEach(arquivo => {
    try {
      fs.unlinkSync(arquivo);
    } catch (e) {
      console.warn(`⚠️ Erro ao remover ${arquivo}`);
    }
  });
})();
