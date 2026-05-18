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

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Camufla Server rodando!' });
});

// Processar vídeo
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

  console.log('Processando:', videoFile.originalname, '| Nível:', nivel);

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
    stream.on('error', (err) => {
      console.error('Erro stream:', err.message);
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
      res.status(500).json({ erro: 'Erro ao processar: ' + err.message });
    }
  }
});

// ============================================
// Processar sem capa
// FIX: mantém formato original + áudio correto
// ============================================
function processarSemCapa(inputPath, outputPath, nivel) {
  return new Promise((resolve, reject) => {
    const crf = nivel === 'basica' ? 28 : nivel === 'normal' ? 26 : 24;

    // Filtro de ruído sem alterar resolução ou aspecto
    let filtros = 'noise=alls=1:allf=t';
    if (nivel === 'normal')    filtros = 'noise=alls=2:allf=t,hue=s=1.01';
    if (nivel === 'agressiva') filtros = 'noise=alls=3:allf=t,hue=s=1.02';

    ffmpeg(inputPath)
      .videoFilters(filtros)
      .outputOptions([
        '-map', '0:v:0',      // FIX: mapeia vídeo do input original
        '-map', '0:a?',       // FIX: mapeia áudio do input original (? = opcional)
        '-map_metadata', '-1',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', String(crf),
        '-c:a', 'aac',        // FIX: recodifica áudio em AAC compatível
        '-b:a', '128k',
        '-movflags', '+faststart',
        '-y'
      ])
      .on('start', cmd => console.log('FFmpeg:', cmd))
      .on('progress', p => { if (p.percent) console.log('Progresso:', Math.round(p.percent) + '%'); })
      .on('end', resolve)
      .on('error', reject)
      .save(outputPath);
  });
}

// ============================================
// Processar com capa
// FIX: mantém formato original + áudio correto
// ============================================
function processarComCapa(inputPath, outputPath, nivel, capaPath) {
  return new Promise((resolve, reject) => {
    const capaVideoPath = path.join(OUTPUT_DIR, 'capa_' + uuidv4() + '.mp4');
    const concatPath    = path.join(OUTPUT_DIR, 'concat_' + uuidv4() + '.txt');

    console.log('Criando capa...');

    // Passo 1: Detectar resolução do vídeo original
    ffmpeg.ffprobe(inputPath, function(err, metadata) {
      if (err) { reject(err); return; }

      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      const width  = videoStream ? videoStream.width  : 1080;
      const height = videoStream ? videoStream.height : 1920;

      console.log('Resolução detectada:', width + 'x' + height);

      // Passo 2: Criar capa com mesma resolução do vídeo original
      ffmpeg(capaPath)
        .loop(1)
        .duration(1)
        .outputOptions([
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-t', '1',
          '-pix_fmt', 'yuv420p',
          // FIX: escala capa para a mesma resolução do vídeo original
          '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
          '-r', '30',
          '-an',
          '-y'
        ])
        .on('end', function() {
          console.log('Capa criada, concatenando...');

          fs.writeFileSync(concatPath,
            `file '${capaVideoPath}'\nfile '${inputPath}'`
          );

          const crf = nivel === 'basica' ? 28 : nivel === 'normal' ? 26 : 24;
          let filtros = 'noise=alls=1:allf=t';
          if (nivel === 'normal')    filtros = 'noise=alls=2:allf=t,hue=s=1.01';
          if (nivel === 'agressiva') filtros = 'noise=alls=3:allf=t,hue=s=1.02';

          // Passo 3: Concatenar capa + vídeo com áudio correto
          ffmpeg()
            .input(concatPath)
            .inputOptions(['-f', 'concat', '-safe', '0'])
            .videoFilters(filtros)
            .outputOptions([
              '-map', '0:v:0',
              '-map', '0:a?',
              '-map_metadata', '-1',
              '-c:v', 'libx264',
              '-preset', 'ultrafast',
              '-crf', String(crf),
              '-c:a', 'aac',
              '-b:a', '128k',
              '-movflags', '+faststart',
              '-y'
            ])
            .on('end', () => {
              limpar(capaVideoPath);
              limpar(concatPath);
              resolve();
            })
            .on('error', (err) => {
              limpar(capaVideoPath);
              limpar(concatPath);
              reject(err);
            })
            .save(outputPath);
        })
        .on('error', reject)
        .save(capaVideoPath);
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
