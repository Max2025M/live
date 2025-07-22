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

function baixarVideo(remoto, destino) {
  return new Promise((resolve, reject) => {
    const rclone = spawn('rclone', ['copy', `meudrive:${remoto}`, '.', '--config', keyFile]);
    rclone.stderr.on('data', data => process.stderr.write(data));
    rclone.on('close', async code => {
      if (code === 0) {
        const nome = path.basename(remoto);
        if (!fs.existsSync(nome)) return reject(new Error(`Arquivo não encontrado: ${nome}`));
        fs.renameSync(nome, destino);
        registrarTemporario(destino);
        resolve();
      } else {
        reject(new Error(`Erro ao baixar ${remoto}`));
      }
    });
  });
}

async function reencode(input, output) {
  await executarFFmpeg([
    '-fflags', '+genpts',
    '-i', input,
    '-vf', 'scale=1280:720,setdar=16/9',
    '-c:v', 'libx264',
    '-crf', '23',
    '-preset', 'veryfast',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-avoid_negative_ts', 'make_zero',
    '-vsync', '1',
    output
  ]);
  registrarTemporario(output);
}

function executarFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', process.stdout, process.stderr] });
    ffmpeg.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`❌ FFmpeg falhou com código ${code}`));
    });
  });
}

async function obterDuracao(arquivo) {
  const { stdout } = await exec(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${arquivo}"`);
  return parseFloat(stdout.trim());
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

  // Baixar vídeos
  await baixarVideo(video_principal, 'principal.mp4');
  await baixarVideo(rodape_id, 'rodape.mp4');
  await baixarVideo(logo_id, 'logo.png');

  // Reencodar extras
  const extrasReenc = [];
  for (let i = 0; i < videos_extras.length; i++) {
    const nome = `extra_${i}.mp4`;
    await baixarVideo(videos_extras[i], nome);
    const nomeReenc = `extra_${i}_reenc.mp4`;
    await reencode(nome, nomeReenc);
    extrasReenc.push(nomeReenc);
  }

  let videoInicialReenc = null;
  if (video_inicial) {
    await baixarVideo(video_inicial, 'video_inicial.mp4');
    videoInicialReenc = 'video_inicial_reenc.mp4';
    await reencode('video_inicial.mp4', videoInicialReenc);
  }

  let videoMiraplayReenc = null;
  if (video_miraplay) {
    await baixarVideo(video_miraplay, 'video_miraplay.mp4');
    videoMiraplayReenc = 'video_miraplay_reenc.mp4';
    await reencode('video_miraplay.mp4', videoMiraplayReenc);
  }

  let videoFinalReenc = null;
  if (video_final) {
    await baixarVideo(video_final, 'video_final.mp4');
    videoFinalReenc = 'video_final_reenc.mp4';
    await reencode('video_final.mp4', videoFinalReenc);
  }

  // Cortar vídeo principal em duas partes iguais
  const durPrincipal = await obterDuracao('principal.mp4');
  const meio = durPrincipal / 2;

  await executarFFmpeg([
    '-fflags', '+genpts',
    '-i', 'principal.mp4',
    '-t', meio.toString(),
    '-c', 'copy',
    'parte1.mp4'
  ]);
  await executarFFmpeg([
    '-fflags', '+genpts',
    '-ss', meio.toString(),
    '-i', 'principal.mp4',
    '-c', 'copy',
    'parte2.mp4'
  ]);
  registrarTemporario('parte1.mp4');
  registrarTemporario('parte2.mp4');

  // Obter duração do rodapé para filtro
  const durRodape = await obterDuracao('rodape.mp4');

  // Inputs do ffmpeg na ordem da live
  // Vídeos:
  // 0: parte1.mp4
  // 1: video_inicial (se existir)
  // 2: video_miraplay (se existir)
  // 3..: extras
  // next: video_inicial (de novo se existir)
  // penúltimo: parte2.mp4
  // último: video_final (se existir)
  // rodape e logo no final inputs

  const inputs = [];
  inputs.push('-re', '-i', 'parte1.mp4');
  if (videoInicialReenc) inputs.push('-re', '-i', videoInicialReenc);
  if (videoMiraplayReenc) inputs.push('-re', '-i', videoMiraplayReenc);
  for (const extra of extrasReenc) {
    inputs.push('-re', '-i', extra);
  }
  if (videoInicialReenc) inputs.push('-re', '-i', videoInicialReenc);
  inputs.push('-re', '-i', 'parte2.mp4');
  if (videoFinalReenc) inputs.push('-re', '-i', videoFinalReenc);

  inputs.push('-i', 'rodape.mp4', '-i', 'logo.png');

  // Índices vídeos
  let idx = 0;
  const videoInputs = [];
  videoInputs.push(idx++); // parte1
  if (videoInicialReenc) videoInputs.push(idx++);
  if (videoMiraplayReenc) videoInputs.push(idx++);
  for (let i = 0; i < extrasReenc.length; i++) videoInputs.push(idx++);
  if (videoInicialReenc) videoInputs.push(idx++);
  videoInputs.push(idx++); // parte2
  if (videoFinalReenc) videoInputs.push(idx++);

  const rodapeIdx = idx++;
  const logoIdx = idx++;

  // Função para filtro do vídeo principal (parte1 e parte2) com trim e overlay de rodapé e logo
  // Aplica rodapé no minuto 4 (240s) usando trims: pre, cut, post
  // Logo menor no canto superior direito (20px margem)
  function filtroPrincipal(inputLabel, rodapeLabel, logoLabel, durRodape, outLabel) {
    return `
      [${inputLabel}]trim=0:240,setpts=PTS-STARTPTS[pre];
      [${inputLabel}]trim=240:${240 + durRodape},setpts=PTS-STARTPTS[cut];
      [${inputLabel}]trim=${240 + durRodape},setpts=PTS-STARTPTS[post];
      [${rodapeLabel}]scale=1280:240[rod];
      [cut]scale=426:240[mini];
      [rod][mini]overlay=W-w-50:90[tmpcut];
      [pre][logoLabel]overlay=W-w-20:20[pre_logo];
      [tmpcut][logoLabel]overlay=W-w-20:20[cut_logo];
      [post][logoLabel]overlay=W-w-20:20[post_logo];
      [pre_logo][cut_logo][post_logo]concat=n=3:v=1:a=0[${outLabel}]
    `
      .replace(/\[logoLabel\]/g, `[${logoLabel}]`);
  }

  // Construir o filtro complex para todos os vídeos:

  let filterComplex = '';

  // Primeiro vídeos principais: parte1 e parte2 com rodapé e logo, usando trim
  filterComplex += `
    ${filtroPrincipal(videoInputs[0], 'rodape', 'logo', durRodape, 'v0')}
  `;

  // Outros vídeos só com logo
  for (let i = 1; i < videoInputs.length; i++) {
    if (videoInputs[i] === videoInputs[videoInputs.length - 2]) {
      // parte2 (penúltimo vídeo) já tratado acima, pular aqui para não duplicar
      continue;
    }
    filterComplex += `
      [${videoInputs[i]}:v]scale=1280:720,setdar=16/9[sv${i}];
      [sv${i}][logo]overlay=W-w-20:20[v${i}]
    `;
  }

  // Mapeamento de vídeos para concat
  // [v0] = parte1 com rodapé e logo
  // [v1], [v2], ... são demais vídeos (com logo)
  // Ajustar label dos vídeos no array para concat

  // Gerar array de labels para concatenação vídeo
  let videoLabels = ['[v0]'];
  for (let i = 1; i < videoInputs.length; i++) {
    if (videoInputs[i] === videoInputs[videoInputs.length - 2]) {
      // parte2 vídeo principal que falta aplicar rodapé e logo
      // Aplicar filtro trim e rodapé também aqui para parte2
      filterComplex += `
        ${filtroPrincipal(videoInputs[i], 'rodape', 'logo', durRodape, `v${i}`)}
      `;
      videoLabels.push(`[v${i}]`);
    } else {
      videoLabels.push(`[v${i}]`);
    }
  }

  // Áudio labels
  let audioLabels = videoInputs.map(i => `[${i}:a]`);

  // Concat filtro final
  filterComplex += `
    ${videoLabels.join('')}${audioLabels.join('')}concat=n=${videoLabels.length}:v=1:a=1[outv][outa]
  `;

  // Montar args do ffmpeg
  const ffmpegArgs = [
    '-y',
    ...inputs,
    '-filter_complex', filterComplex,
    '-map', '[outv]',
    '-map', '[outa]',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-f', 'flv',
    stream_url
  ];

  console.log('🚀 Iniciando live com sequência, rodapé no minuto 4 e logo sempre visível...');
  await executarFFmpeg(ffmpegArgs);

  arquivosTemporarios.forEach(file => {
    try {
      fs.unlinkSync(file);
    } catch {}
  });
  console.log('🧹 Arquivos temporários removidos.');
})();
