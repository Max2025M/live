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

async function obterDuracao(arquivo) {
  const { stdout } = await exec(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${arquivo}"`);
  return parseFloat(stdout.trim());
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
          console.log(`📥 Vídeo reencodado: ${destino}`);
        }

        resolve();
      } else {
        reject(new Error(`Erro ao baixar ${remoto}`));
      }
    });
  });
}

async function inserirRodape(principal, rodape, logo, saida, inicioRodape) {
  const duracaoRodape = await obterDuracao(rodape);
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

async function main() {
  const {
    id,
    video_principal,
    video_inicial,
    video_miraplay,
    video_final,
    logo_id,
    rodape_id,
    videos_extras,
    stream_url
  } = input;

  // Baixar e preparar os arquivos principais
  await baixarArquivo(video_principal, 'principal.mp4');
  await baixarArquivo(rodape_id, 'rodape.mp4');
  await baixarArquivo(logo_id, 'logo.png');

  const duracaoPrincipal = await obterDuracao('principal.mp4');
  const meio = Math.floor(duracaoPrincipal / 2);

  // Cortar em duas partes
  await cortarVideo('principal.mp4', 'parte1.mp4', 'parte2.mp4', meio);

  // Inserir rodapé com logo sempre visível
  await inserirRodape('parte2.mp4', 'rodape.mp4', 'logo.png', 'parte2_final.mp4', 0);
  await executarFFmpeg([
    '-i', 'parte1.mp4',
    '-i', 'logo.png',
    '-filter_complex', '[0:v][1:v]overlay=W-w-20:20[out]',
    '-map', '[out]',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-an',
    'parte1_final.mp4'
  ]);
  registrarTemporario('parte1_final.mp4');

  // Baixar e reencodar partes adicionais
  await baixarArquivo(video_inicial, 'video_inicial.mp4');
  await baixarArquivo(video_miraplay, 'video_miraplay.mp4');
  await baixarArquivo(video_final, 'video_final.mp4');

  const extras = [];
  for (let i = 0; i < videos_extras.length; i++) {
    const nome = `extra${i}.mp4`;
    await baixarArquivo(videos_extras[i], nome);
    extras.push(nome);
  }

  // Ordem final
  const ordem = [
    'parte1_final.mp4',
    'video_inicial.mp4',
    'video_miraplay.mp4',
    ...extras,
    'video_inicial.mp4',
    'parte2_final.mp4',
    'video_final.mp4'
  ];

  // Criar lista para concatenação
  fs.writeFileSync('lista.txt', ordem.map(v => `file '${v}'`).join('\n'));

  console.log('🧩 Unindo vídeos finais...');
  await executarFFmpeg([
    '-f', 'concat',
    '-safe', '0',
    '-i', 'lista.txt',
    '-c', 'copy',
    'video_final_completo.mp4'
  ]);

  console.log('✅ Vídeo final criado: video_final_completo.mp4');

  fs.writeFileSync('stream_info.json', JSON.stringify({ id, stream: stream_url }, null, 2));
  console.log('📝 stream_info.json criado com sucesso.');
}

main().catch(err => {
  console.error('❌ Erro geral:', err);
  process.exit(1);
});
