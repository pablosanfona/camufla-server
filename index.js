const express = require('express');
const multer  = require('multer');
const ffmpeg  = require('fluent-ffmpeg');
const cors    = require('cors');
const { v4: uuidv4 } = require('uuid');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = '/tmp/uploads';
const OUTPUT_DIR = '/tmp/outputs';
[UPLOAD_DIR, OUTPUT_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, {recursive: true});
});

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  req.setTimeout(600000);
  res.setTimeout(600000);
  next();
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Camufla Server rodando!' });
});

app.post('/processar', upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'capa',  maxCount: 1 }
]), async (req, res) => {

  const videoFile = req.files?.video?.[0];
  const capaFile  = req.files?.capa?.[0];
  const nivel     = ['basica','normal','agressiva'].includes(req.body.nivel)
    ? req.body.nivel : 'basica';

  if (!videoFile) {
    return res.status(400).json({ erro: 'Nenhum vídeo enviado' });
  }

  const inputPath  = videoFile.path;
  const outputName = 'camufla_' + uuidv4() + '.mp4';
  const outputPath = path.join(OUTPUT_DIR, outputName);

  console.log('Processando:', videoFile.originalname, '| Nível:', nivel, '| Capa:', !!capaFile);

  try {
    if (capaFile) {
      await processarComCapa(inputPath, outputPath, nivel, capaFile.path);
    } else {
      await processarSemCapa(inputPath, outputPath, nivel);
    }

    if (!fs.existsSync(outputPath)) {
      throw new Error('Arquivo de saída não foi gerado');
    }

    console.log('Concluído:', outputName);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="' + outputName + '"');

    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('end', () => {
      limpar(inputPath);
      limpar(outputPath);
      if (capaFile) limpar(capaFile.path);
    });
    stream.on('error', () => {
      limpar(inputPath);
      limpar(outputPath);
      if (capaFile) limpar(capaFile.path);
    });

  } catch (err) {
    console.error('Erro:', err.message);
    limpar(inputPath);
    limpar(outputPath);
    if (capaFile) limpar(capaFile.path);
    if (!res.headersSent) {
      res.status(500).json({ erro: 'Erro: ' + err.message });
    }
  }
});

// ============================================
// SEM CAPA — simples e direto
// ============================================
function processarSemCapa(inputPath, outputPath, nivel) {
  return new Promise((resolve, reject) => {
    const crf = nivel === 'basica' ? 28 : nivel === 'normal' ? 26 : 24;
    let vf = 'noise=alls=1:allf=t';
    if (nivel === 'normal')    vf = 'noise=alls=2:allf=t,hue=s=1.01';
    if (nivel === 'agressiva') vf = 'noise=alls=3:allf=t,hue=s=1.02';

    ffmpeg(inputPath)
      .videoFilters(vf)
      .outputOptions([
        '-map_metadata', '-1',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', String(crf),
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        '-y'
      ])
      .on('start', cmd => console.log('FFmpeg sem capa iniciado'))
      .on('end', resolve)
      .on('error', reject)
      .save(outputPath);
  });
}

// ============================================
// COM CAPA — overlay nos primeiros 0.3s
// Áudio do vídeo original preservado 100%
// ============================================
function processarComCapa(inputPath, outputPath, nivel, capaPath) {
  return new Promise((resolve, reject) => {

    // Detectar resolução do vídeo
    ffmpeg.ffprobe(inputPath, function(err, metadata) {
      if (err) { reject(err); return; }

      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      const width  = videoStream ? videoStream.width  : 1080;
      const height = videoStream ? videoStream.height : 1920;

      console.log('Resolução:', width + 'x' + height);

      const crf = nivel === 'basica' ? 28 : nivel === 'normal' ? 26 : 24;
      let ruido = 'noise=alls=1:allf=t';
      if (nivel === 'normal')    ruido = 'noise=alls=2:allf=t,hue=s=1.01';
      if (nivel === 'agressiva') ruido = 'noise=alls=3:allf=t,hue=s=1.02';

      // Usar overlay da capa nos primeiros 0.3 segundos
      // O vídeo original fica como base — áudio preservado
      const capaFiltro = `[1:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2[capa];[0:v]${ruido}[vid];[vid][capa]overlay=0:0:enable='between(t,0,0.3)'[out]`;

      ffmpeg()
        .input(inputPath)   // input 0: vídeo original (com áudio)
        .input(capaPath)    // input 1: imagem de capa
        .complexFilter(capaFiltro, 'out')
        .outputOptions([
          '-map', '[out]',    // vídeo processado com overlay
          '-map', '0:a?',     // áudio do vídeo original
          '-map_metadata', '-1',
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-crf', String(crf),
          '-c:a', 'aac',
          '-b:a', '128k',
          '-movflags', '+faststart',
          '-y'
        ])
        .on('start', cmd => console.log('FFmpeg com capa overlay iniciado'))
        .on('progress', p => { if (p.percent) console.log(Math.round(p.percent) + '%'); })
        .on('end', resolve)
        .on('error', (err) => {
          console.error('Erro overlay:', err.message);
          // Fallback: processa sem capa se overlay falhar
          console.log('Tentando sem capa como fallback...');
          processarSemCapa(inputPath, outputPath, nivel).then(resolve).catch(reject);
        })
        .save(outputPath);
    });
  });
}

function limpar(filePath) {
  try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch(e) {}
}

setInterval(() => {
  const agora = Date.now();
  [UPLOAD_DIR, OUTPUT_DIR].forEach(dir => {
    try {
      fs.readdirSync(dir).forEach(file => {
        const fp = path.join(dir, file);
        try { if (agora - fs.statSync(fp).mtimeMs > 3600000) limpar(fp); } catch(e) {}
      });
    } catch(e) {}
  });
}, 3600000);

app.listen(PORT, () => console.log('Camufla Server na porta ' + PORT));
