const express = require('express');
const multer  = require('multer');
const ffmpeg  = require('fluent-ffmpeg');
const cors    = require('cors');
const { v4: uuidv4 } = require('uuid');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// Pastas temporárias
const UPLOAD_DIR = '/tmp/uploads';
const OUTPUT_DIR = '/tmp/outputs';
[UPLOAD_DIR, OUTPUT_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, {recursive: true}); });

// CORS — permite requisições do seu domínio
app.use(cors({
  origin: ['https://subdigital.site', 'http://subdigital.site', 'http://localhost'],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json());

// Multer — recebe vídeo e capa
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 } // 200MB
});

// ============================================
// ROTA: Health check
// ============================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Camufla Server rodando!' });
});

// ============================================
// ROTA: Processar vídeo
// ============================================
app.post('/processar', upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'capa',  maxCount: 1 }
]), async (req, res) => {

  const videoFile = req.files?.video?.[0];
  const capaFile  = req.files?.capa?.[0];
  const nivel     = ['basica','normal','agressiva'].includes(req.body.nivel) ? req.body.nivel : 'basica';

  if (!videoFile) {
    return res.status(400).json({ erro: 'Nenhum vídeo enviado' });
  }

  const inputPath  = videoFile.path;
  const outputName = 'camufla_' + uuidv4() + '.mp4';
  const outputPath = path.join(OUTPUT_DIR, outputName);

  try {
    await processarVideo(inputPath, outputPath, nivel, capaFile?.path);

    // Enviar vídeo processado
    res.download(outputPath, outputName, (err) => {
      // Limpar arquivos temporários após envio
      limparArquivo(inputPath);
      limparArquivo(outputPath);
      if (capaFile) limparArquivo(capaFile.path);
    });

  } catch (err) {
    console.error('Erro ao processar:', err.message);
    limparArquivo(inputPath);
    if (capaFile) limparArquivo(capaFile.path);
    res.status(500).json({ erro: 'Erro ao processar vídeo: ' + err.message });
  }
});

// ============================================
// FUNÇÃO: Processar vídeo com FFmpeg
// ============================================
function processarVideo(inputPath, outputPath, nivel, capaPath) {
  return new Promise((resolve, reject) => {

    // Configurações por nível
    const configs = {
      basica: {
        fps: null,
        filtros: 'noise=alls=1:allf=t',
        velocidade: null,
        crf: 23,
        preset: 'fast'
      },
      normal: {
        fps: '29.97',
        filtros: 'noise=alls=2:allf=t,hue=s=1.01',
        velocidade: null,
        crf: 22,
        preset: 'medium'
      },
      agressiva: {
        fps: '29.97',
        filtros: 'noise=alls=3:allf=t,hue=s=1.02,eq=brightness=0.01',
        velocidade: '1.01',
        crf: 21,
        preset: 'medium'
      }
    };

    const cfg = configs[nivel];

    // Se tem capa: cria vídeo da capa + concatena com o original
    if (capaPath) {
      processarComCapa(inputPath, outputPath, capaPath, cfg, resolve, reject);
    } else {
      processarSemCapa(inputPath, outputPath, cfg, resolve, reject);
    }
  });
}

// ============================================
// Processar sem capa
// ============================================
function processarSemCapa(inputPath, outputPath, cfg, resolve, reject) {
  let cmd = ffmpeg(inputPath)
    .outputOptions([
      '-map_metadata', '-1',      // Remove metadados
      '-crf', cfg.crf.toString(), // Qualidade
      '-preset', cfg.preset,
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart'
    ]);

  // Filtros de vídeo
  let filtroFinal = cfg.filtros;
  if (cfg.velocidade) {
    filtroFinal += ',setpts=' + cfg.velocidade + '*PTS';
  }
  cmd.videoFilters(filtroFinal);

  // FPS
  if (cfg.fps) cmd.fps(cfg.fps);

  cmd
    .on('end', resolve)
    .on('error', reject)
    .save(outputPath);
}

// ============================================
// Processar com capa (insere como primeiro frame)
// ============================================
function processarComCapa(inputPath, outputPath, capaPath, cfg, resolve, reject) {
  const capaVideoPath = path.join(OUTPUT_DIR, 'capa_' + uuidv4() + '.mp4');
  const concatPath    = path.join(OUTPUT_DIR, 'concat_' + uuidv4() + '.txt');

  // Passo 1: Converter capa em vídeo de 1 segundo
  ffmpeg(capaPath)
    .loop(1)
    .duration(1)
    .outputOptions([
      '-c:v', 'libx264',
      '-t', '1',
      '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', // garante dimensões pares
      '-r', '30',
      '-an' // sem áudio na capa
    ])
    .on('end', function() {
      // Passo 2: Concatenar capa + vídeo original
      const concatContent = `file '${capaVideoPath}'\nfile '${inputPath}'`;
      fs.writeFileSync(concatPath, concatContent);

      // Passo 3: Processar concatenado com camuflagem
      let filtroFinal = cfg.filtros;
      if (cfg.velocidade) {
        filtroFinal += ',setpts=' + cfg.velocidade + '*PTS';
      }

      let cmd = ffmpeg()
        .input(concatPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .videoFilters(filtroFinal)
        .outputOptions([
          '-map_metadata', '-1',
          '-crf', cfg.crf.toString(),
          '-preset', cfg.preset,
          '-c:v', 'libx264',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-movflags', '+faststart'
        ]);

      if (cfg.fps) cmd.fps(cfg.fps);

      cmd
        .on('end', function() {
          limparArquivo(capaVideoPath);
          limparArquivo(concatPath);
          resolve();
        })
        .on('error', function(err) {
          limparArquivo(capaVideoPath);
          limparArquivo(concatPath);
          reject(err);
        })
        .save(outputPath);
    })
    .on('error', reject)
    .save(capaVideoPath);
}

// ============================================
// LIMPAR ARQUIVOS TEMPORÁRIOS
// ============================================
function limparArquivo(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch(e) {}
}

// Limpar arquivos antigos a cada hora
setInterval(() => {
  const agora = Date.now();
  [UPLOAD_DIR, OUTPUT_DIR].forEach(dir => {
    try {
      fs.readdirSync(dir).forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (agora - stat.mtimeMs > 3600000) limparArquivo(filePath);
      });
    } catch(e) {}
  });
}, 3600000);

// ============================================
// INICIAR SERVIDOR
// ============================================
app.listen(PORT, () => {
  console.log('Camufla Server rodando na porta ' + PORT);
});
