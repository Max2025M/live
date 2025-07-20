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

        const ext = path.extname(destino).toLowerCase();
        if (['.mp4', '.webm', '.mov'].includes(ext)) {
          const temp = destino.replace(/(\.[^.]+)$/, '_temp$1');
          await reencode(destino, temp);
          fs.renameSync(temp, destino);
          console.log(`📥 Vídeo baixado e reencodado: ${destino}`);
        } else {
          console.log(`📥 Imagem baixada: ${destino}`);
        }

        resolve();
      } else {
        reject(new Error(`Erro ao baixar ${remoto}`));
      }
    });
  });
}

async function cortarMeio(videoPath, parte1, parte2) {
  const { stdout } = await exec(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`);
  const duracao = parseFloat(stdout.trim());
  const metade = duracao / 2;

  await executarFFmpeg(['-i', videoPath, '-t', metade.toFixed(2), '-c', 'copy', parte1], parte1);
  await executarFFmpeg(['-i', videoPath, '-ss', metade.toFixed(2), '-c', 'copy', parte2], parte2);
}

async function inserirRodape(principal, rodape, saida) {
  const { stdout } = await exec(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${rodape}"`);
  const duracaoRodape = parseFloat(stdout.trim());

  await executarFFmpeg([
    '-i', principal,
    '-i', rodape,
    '-filter_complex',
    `[0:v]trim=0:240,setpts=PTS-STARTPTS[antes];` +
    `[0:v]trim=240:${240 + duracaoRodape},setpts=PTS-STARTPTS,scale=426:240[mini];` +
    `[1:v]scale=1280:720[rod];` +
    `[rod][mini]overlay=W-w-50:90[durante];` +
    `[0:v]trim=${240 + duracaoRodape},setpts=PTS-STARTPTS[depois];` +
    `[antes][durante][depois]concat=n=3:v=1:a=0[outv]`,
    '-map', '[outv]', '-map', '0:a?',
    '-c:v', 'libx264',
    '-c:a', 'aac',
    saida
  ], saida);
}

async function adicionarLogo(input, output, logo) {
  await executarFFmpeg([
    '-i', input,
    '-i', logo,
    '-filter_complex', 'overlay=W-w-10:10',
    '-c:v', 'libx264',
    '-c:a', 'aac',
    output
  ], output);
}

async function montarSequencia() {
  const arquivos = {};

  async function baixarERegistrar(key, nomeFinal) {
    await baixarArquivo(input[key], nomeFinal);
    arquivos[key] = nomeFinal;
  }

  await baixarERegistrar('video_principal', 'video_principal.mp4');
  await baixarERegistrar('video_inicial', 'video_inicial.mp4');
  await baixarERegistrar('video_miraplay', 'video_miraplay.mp4');
  await baixarERegistrar('video_final', 'video_final.mp4');
  await baixarERegistrar('logo_id', 'logo.png');
  if (input.rodape_id) await baixarERegistrar('rodape_id', 'rodape.mp4');

  const extras = [];
  for (let i = 0; i < input.videos_extras.length; i++) {
    const nome = `extra_${i}.mp4`;
    await baixarArquivo(input.videos_extras[i], nome);
    extras.push(nome);
  }

  await cortarMeio(arquivos.video_principal, 'parte1.mp4', 'parte2.mp4');

  await adicionarLogo('parte1.mp4', 'parte1_logo.mp4', arquivos.logo_id);
  await adicionarLogo('parte2.mp4', 'parte2_logo.mp4', arquivos.logo_id);

  let parte1_final = 'parte1_logo.mp4';
  let parte2_final = 'parte2_logo.mp4';

  if (arquivos.rodape_id) {
    await inserirRodape('parte1_logo.mp4', arquivos.rodape_id, 'parte1_final.mp4');
    await inserirRodape('parte2_logo.mp4', arquivos.rodape_id, 'parte2_final.mp4');
    parte1_final = 'parte1_final.mp4';
    parte2_final = 'parte2_final.mp4';
  }

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

  await executarFFmpeg([
    '-f', 'concat',
    '-safe', '0',
    '-i', listaConcat,
    '-c', 'copy',
    'video_final_completo.mp4'
  ], 'video_final_completo.mp4');

  // Obter informações finais
  const stats = fs.statSync('video_final_completo.mp4');
  const duracaoFinal = await obterDuracao('video_final_completo.mp4');
  const duracaoFormatada = formatarDuracao(duracaoFinal);
  const tamanhoMB = Math.round(stats.size / 1024 / 1024);

  // Gerar stream_info.json
  fs.writeFileSync('stream_info.json', JSON.stringify({
    id: input.id,
    stream: input.stream_url
  }, null, 2));

  console.log(`✅ Finalizado com ${tamanhoMB} MB e duração ${duracaoFormatada}`);
}

montarSequencia()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Erro:', err.message);
    process.exit(1);
  });
