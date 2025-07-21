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
    // Colocando -fps_mode antes de arquivos de entrada
    const ffmpeg = spawn('ffmpeg', ['-y', '-fps_mode', 'cfr', ...args]);
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

async function reencode(input, output) {
  console.log(`🔄 Reencodificando ${input} para ${output}...`);
  await executarFFmpeg([
    '-i', input,
    '-vf', 'scale=1280:720,fps=30',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    output
  ]);
  registrarTemporario(output);
}

async function cortarVideo(input, out1, out2, meio) {
  console.log(`✂️ Cortando vídeo ${input}...`);
  await executarFFmpeg(['-i', input, '-t', meio.toString(), '-c', 'copy', out1]);
  await executarFFmpeg(['-i', input, '-ss', meio.toString(), '-c', 'copy', out2]);
  registrarTemporario(out1);
  registrarTemporario(out2);
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

        if (destino.toLowerCase().endsWith('.mp4')) {
          const temp = destino.replace(/(\.[^.]+)$/, '_temp$1');
          await reencode(destino, temp);
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
    [cut]scale=426:240[mini];
    [rod][mini]overlay=W-w-50:90[tmp];
    [tmp][2:v]overlay=W-w-20:20[rodfinal];
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

  await baixarERegistrar('video_principal', 'video_principal.mp4');
  await baixarERegistrar('video_inicial', 'video_inicial.mp4');
  await baixarERegistrar('video_miraplay', 'video_miraplay.mp4');
  await baixarERegistrar('video_final', 'video_final.mp4');
  await baixarERegistrar('rodape_id', 'rodape.mp4');
  await baixarERegistrar('logo_id', 'logo.png');

  // Cortando o vídeo principal ao meio
  const duracao = await obterDuracao(arquivos.video_principal);
  const meio = duracao / 2;
  await cortarVideo(arquivos.video_principal, 'parte1.mp4', 'parte2.mp4', meio);

  // Reencodificando as partes cortadas
  await reencode('parte1.mp4', 'parte1_final.mp4');
  await reencode('parte2.mp4', 'parte2_final.mp4');

  // Reencodificando outros vídeos, se necessário
  await reencode(arquivos.video_inicial, 'video_inicial_final.mp4');
  await reencode(arquivos.video_miraplay, 'video_miraplay_final.mp4');
  await reencode(arquivos.video_final, 'video_final_final.mp4');

  // Criando a lista de arquivos para concatenação
  const extras = [];
  for (let i = 0; i < input.videos_extras.length; i++) {
    const nome = `extra_${i}.mp4`;
    await baixarArquivo(input.videos_extras[i], nome);
    extras.push(nome);
  }

  // Ordem exata para concatenação
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
    '-fflags', '+genpts',
    '-avoid_negative_ts', 'make_zero',
    '-f', 'concat',
    '-safe', '0',
    '-i', listaConcat,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-c:a', 'aac',
    '-r', '25',
    '-movflags', '+faststart',
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

  // Iniciando a transmissão para o Facebook
  await transmitirFacebook('video_final_completo.mp4', input.stream_url);
}

montarSequencia()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Erro:', err.message);
    process.exit(1);
  });
