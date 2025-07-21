const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

const keyFile = path.join(os.homedir(), '.config', 'rclone', 'rclone.conf');
const input = JSON.parse(fs.readFileSync('input.json', 'utf-8'));
const arquivosTemporarios = [];
const arquivos = {};

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
  if (!fs.existsSync(caminho)) {
    throw new Error(`Arquivo não encontrado para ffprobe: ${caminho}`);
  }
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
        const nomeOriginal = path.basename(remoto);
        if (!fs.existsSync(nomeOriginal)) return reject(new Error(`Arquivo não encontrado: ${nomeOriginal}`));
        fs.renameSync(nomeOriginal, destino);
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
    `[0:v]trim=0:240,setpts=PTS-STARTPTS[v0];` +
    `[0:v]trim=240:${240 + duracaoRodape},setpts=PTS-STARTPTS,scale=1000:500[v1];` +
    `[1:v]scale=1280:720,setsar=1[v2];` +
    `[2:v]scale=120:120[logo];` +
    `[v2][v1]overlay=W-w-50:90[tmp];` +
    `[v0][logo]overlay=W-w-10:10[pre];` +
    `[pre][tmp]concat=n=2:v=1:a=0[outv]`,
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

function corrigirURL(url) {
  return url.replace(/([^:]\/)\/+/g, '$1');
}

async function montarVideoFinal() {
  const baixar = async (chave, nomeArquivo) => {
    if (input[chave]) {
      await baixarArquivo(input[chave], nomeArquivo);
      arquivos[chave] = nomeArquivo;
    } else {
      throw new Error(`Chave ausente no input: ${chave}`);
    }
  };

  // Baixar arquivos com nomes fixos
  await baixar('video_principal', 'video_principal.mp4');
  await baixar('video_inicial', 'video_inicial.mp4');
  await baixar('video_miraplay', 'video_miraplay.mp4');
  await baixar('video_final', 'video_final.mp4');
  await baixarArquivo(input.rodape_id, 'rodape.mp4');
  await baixarArquivo(input.logo_id, 'logo.png');

  arquivos['rodape'] = 'rodape.mp4';
  arquivos['logo'] = 'logo.png';

  // Baixar vídeos extras
  arquivos.extras = [];
  if (Array.isArray(input.videos_extras)) {
    for (let i = 0; i < input.videos_extras.length; i++) {
      const nome = `video_extra_${i}.mp4`;
      await baixarArquivo(input.videos_extras[i], nome);
      arquivos.extras.push(nome);
    }
  }

  // Cortar e processar partes do principal
  await cortarVideo('video_principal.mp4', 'parte1.mp4', 'parte2.mp4');
  await inserirLogoERodape('parte1.mp4', arquivos.rodape, arquivos.logo, 'parte1_final.mp4');
  await inserirLogoERodape('parte2.mp4', arquivos.rodape, arquivos.logo, 'parte2_final.mp4');

  // Lista de concatenação com nomes corretos
  const listaConcat = [
    'parte1_final.mp4',
    'video_inicial.mp4',
    'video_miraplay.mp4',
    ...arquivos.extras,
    'video_inicial.mp4',
    'parte2_final.mp4',
    'video_final.mp4'
  ];

  for (const f of listaConcat) {
    if (!fs.existsSync(f)) {
      throw new Error(`Arquivo para concatenação não encontrado: ${f}`);
    }
  }

  const concatList = 'arquivos.txt';
  fs.writeFileSync(concatList, listaConcat.map(f => `file '${f}'`).join('\n'));
  registrarTemporario(concatList);

  await executarFFmpeg([
    '-f', 'concat',
    '-safe', '0',
    '-i', concatList,
    '-c', 'copy',
    'video_final_completo.mp4'
  ], 'video_final_completo.mp4');

  // Corrigir URL da stream
  const stream_url = corrigirURL(input.stream_url);
  const duracao = await obterDuracao('video_final_completo.mp4');
  const tamanho = fs.statSync('video_final_completo.mp4').size / 1024 / 1024;

  console.log(`⏱️ Duração: ${Math.floor(duracao / 60)}:${Math.floor(duracao % 60).toString().padStart(2, '0')} minutos`);
  console.log(`📦 Tamanho: ${tamanho.toFixed(2)} MB`);
  console.log(`🌐 URL da transmissão corrigida: ${stream_url}`);

  fs.writeFileSync('stream_info.json', JSON.stringify({
    id: input.id,
    stream: stream_url
  }, null, 2));

  // Limpeza
  for (const file of arquivosTemporarios) {
    try {
      fs.unlinkSync(file);
      console.log(`🧹 Removido: ${file}`);
    } catch (e) {
      console.warn(`⚠️ Não foi possível remover ${file}: ${e.message}`);
    }
  }

  console.log('✅ Finalizado com sucesso.');
}

montarVideoFinal().catch(err => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
