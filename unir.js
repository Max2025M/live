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

async function obterDuracao(caminho) {
  const { stdout } = await exec(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${caminho}"`);
  return parseFloat(stdout.trim());
}

async function reencode(entrada, saida) {
  await executarFFmpeg([
    '-i', entrada,
    '-vf', 'scale=1280:720,setdar=16/9',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    saida
  ], saida);
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
        console.log(`📥 Baixado e reencodado: ${destino}`);
        resolve();
      } else {
        reject(new Error(`Erro ao baixar ${remoto}`));
      }
    });
  });
}

async function inserirLogoERodape(videoEntrada, rodape, logo, saida) {
  const duracaoRodape = await obterDuracao(rodape);

  await executarFFmpeg([
    '-i', videoEntrada,
    '-i', rodape,
    '-i', logo,
    '-filter_complex',
    `[1:v]scale=1280:720[rod];` +
    `[2:v]scale=120:120[logo];` +
    `[0:v][logo]overlay=W-w-10:10[tmp1];` +
    `[tmp1][rod]overlay=W-w-50:90:enable='between(t,240,${240 + duracaoRodape})'[outv]`,
    '-map', '[outv]', '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    saida
  ], saida);
}

async function cortarVideo(video, parte1, parte2) {
  const duracao = await obterDuracao(video);
  const meio = duracao / 2;

  await executarFFmpeg(['-i', video, '-t', meio.toFixed(2), '-c', 'copy', parte1], parte1);
  await executarFFmpeg(['-i', video, '-ss', meio.toFixed(2), '-c', 'copy', parte2], parte2);
}

async function montarVideoFinal() {
  const arquivos = {};

  const baixar = async (nome, destino) => {
    if (input[nome]) {
      const caminho = `${nome}.mp4`;
      await baixarArquivo(input[nome], caminho);
      arquivos[nome] = caminho;
    }
  };

  await baixar('video_principal', 'principal.mp4');
  await baixar('video_inicial', 'inicial.mp4');
  await baixar('video_miraplay', 'miraplay.mp4');
  await baixar('video_final', 'final.mp4');
  await baixar('logo_id', 'logo.png');
  await baixarArquivo(input.rodape_id, 'rodape.mp4');

  const extras = [];
  for (let i = 0; i < input.videos_extras.length; i++) {
    const nome = `extra_${i}.mp4`;
    await baixarArquivo(input.videos_extras[i], nome);
    extras.push(nome);
  }

  // Cortar principal
  await cortarVideo('principal.mp4', 'parte1.mp4', 'parte2.mp4');

  // Inserir rodapé e logo nas duas partes
  await inserirLogoERodape('parte1.mp4', 'rodape.mp4', 'logo.png', 'parte1_final.mp4');
  await inserirLogoERodape('parte2.mp4', 'rodape.mp4', 'logo.png', 'parte2_final.mp4');

  // Montar lista
  const listaConcat = [
    'parte1_final.mp4',
    arquivos.video_inicial,
    arquivos.video_miraplay,
    ...extras,
    arquivos.video_inicial,
    'parte2_final.mp4',
    arquivos.video_final
  ];

  const concatList = 'arquivos.txt';
  fs.writeFileSync(concatList, listaConcat.map(f => `file '${f}'`).join('\n'));

  await executarFFmpeg([
    '-f', 'concat',
    '-safe', '0',
    '-i', concatList,
    '-c', 'copy',
    'video_final_completo.mp4'
  ], 'video_final_completo.mp4');

  // Duração e tamanho
  const duracao = await obterDuracao('video_final_completo.mp4');
  const tamanho = fs.statSync('video_final_completo.mp4').size / 1024 / 1024;

  console.log(`⏱️ Duração: ${Math.floor(duracao / 60)}:${Math.floor(duracao % 60).toString().padStart(2, '0')} minutos`);
  console.log(`📦 Tamanho: ${tamanho.toFixed(2)} MB`);
  console.log(`🌐 URL da transmissão: ${input.stream_url}`);

  // stream_info.json
  fs.writeFileSync('stream_info.json', JSON.stringify({
    id: input.id,
    stream: input.stream_url
  }, null, 2));
}

montarVideoFinal().catch(err => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
