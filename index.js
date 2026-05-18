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

// Processar vídeo e devolver o arquivo processado
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

    // Retorna o arquivo processado como download
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
      console.error('Erro no stream:', err.message);
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

function processarSemCapa(inputPath, outputPath, nivel) {
  return new Promise((resolve, reject) => {
    const crf = nivel === 'basica' ? 28 : nivel === 'normal' ? 26 : 24;
    let filtros = 'noise=alls=1:allf=t';
    if (nivel === 'normal')    filtros = 'noise=alls=2:allf=t,hue=s=1.01';
    if (nivel === 'agressiva') filtros = 'noise=alls=3:allf=t,hue=s=1.02';

    ffmpeg(inputPath)
      .videoFilters(filtros)
      .outputOptions([
        '-map_metadata', '-1',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', String(crf),
        '-c:a', 'copy',
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

function processarComCapa(inputPath, outputPath, nivel, capaPath) {
  return new Promise((resolve, reject) => {
    const capaVideoPath = path.join(OUTPUT_DIR, 'capa_' + uuidv4() + '.mp4');
    const concatPath    = path.join(OUTPUT_DIR, 'concat_' + uuidv4() + '.txt');

    ffmpeg(capaPath)
      .loop(1)
      .duration(1)
      .outputOptions([
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-t', '1',
        '-pix_fmt', 'yuv420p',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-r', '30',
        '-an', '-y'
      ])
      .on('end', function() {
        fs.writeFileSync(concatPath, `file '${capaVideoPath}'\nfile '${inputPath}'`);
        const crf = nivel === 'basica' ? 28 : nivel === 'normal' ? 26 : 24;
        let filtros = 'noise=alls=1:allf=t';
        if (nivel === 'normal')    filtros = 'noise=alls=2:allf=t,hue=s=1.01';
        if (nivel === 'agressiva') filtros = 'noise=alls=3:allf=t,hue=s=1.02';

        ffmpeg()
          .input(concatPath)
          .inputOptions(['-f', 'concat', '-safe', '0'])
          .videoFilters(filtros)
          .outputOptions([
            '-map_metadata', '-1',
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-crf', String(crf),
            '-c:a', 'copy',
            '-movflags', '+faststart',
            '-y'
          ])
          .on('end', () => { limpar(capaVideoPath); limpar(concatPath); resolve(); })
          .on('error', (err) => { limpar(capaVideoPath); limpar(concatPath); reject(err); })
          .save(outputPath);
      })
      .on('error', reject)
      .save(capaVideoPath);
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
