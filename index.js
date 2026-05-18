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

    const tamanho = fs.statSync(outputPath).size;
    console.log('Concluído:', outputName, '| Tamanho:', Math.round(tamanho/1024/1024) + 'MB');

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="' + outputName + '"');

    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('end', () => { limpar(inputPath); limpar(outputPath); if (capaFile) limpar(capaFile.path); });
    stream.on('error', () => { limpar(inputPath); limpar(outputPath); if (capaFile) limpar(capaFile.path); });

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
// SEM CAPA
// FIX: bitrate controlado + áudio sincronizado
// ============================================
function processarSemCapa(inputPath, outputPath, nivel) {
  return new Promise((resolve, reject) => {

    // Detectar bitrate original para manter tamanho similar
    ffmpeg.ffprobe(inputPath, function(err, metadata) {
      if (err) { reject(err); return; }

      const vStream = metadata.streams.find(s => s.codec_type === 'video');
      const aStream = metadata.streams.find(s => s.codec_type === 'audio');
      const origBitrate = vStream ? Math.round(parseInt(vStream.bit_rate || '1000000') / 1000) : 1000;
      const targetBitrate = Math.min(origBitrate + 100, 2000); // ligeiramente maior que original

      let vf = 'noise=alls=1:allf=t';
      if (nivel === 'normal')    vf = 'noise=alls=2:allf=t,hue=s=1.01';
      if (nivel === 'agressiva') vf = 'noise=alls=3:allf=t,hue=s=1.02';

      console.log('Bitrate original:', origBitrate + 'k', '| Target:', targetBitrate + 'k');

      const cmd = ffmpeg(inputPath)
        .videoFilters(vf)
        .outputOptions([
          '-map_metadata', '-1',
          '-c:v', 'libx264',
          '-preset', 'fast',        // FIX: fast é melhor que ultrafast para qualidade/tamanho
          '-b:v', targetBitrate + 'k', // FIX: controla bitrate para não inflar o arquivo
          '-c:a', 'aac',
          '-b:a', '96k',
          '-async', '1',            // FIX: sincroniza áudio com vídeo
          '-vsync', '1',            // FIX: sincroniza frames de vídeo
          '-movflags', '+faststart',
          '-y'
        ]);

      // Só adiciona mapa de áudio se existir stream de áudio
      if (aStream) {
        cmd.outputOptions(['-map', '0:v:0', '-map', '0:a:0']);
      } else {
        cmd.outputOptions(['-map', '0:v:0', '-an']);
      }

      cmd
        .on('start', () => console.log('FFmpeg sem capa iniciado'))
        .on('progress', p => { if (p.percent) console.log(Math.round(p.percent) + '%'); })
        .on('end', resolve)
        .on('error', reject)
        .save(outputPath);
    });
  });
}

// ============================================
// COM CAPA — overlay nos primeiros 0.3s
// FIX: áudio sincronizado + tamanho controlado
// ============================================
function processarComCapa(inputPath, outputPath, nivel, capaPath) {
  return new Promise((resolve, reject) => {

    ffmpeg.ffprobe(inputPath, function(err, metadata) {
      if (err) { reject(err); return; }

      const vStream = metadata.streams.find(s => s.codec_type === 'video');
      const aStream = metadata.streams.find(s => s.codec_type === 'audio');
      const width   = vStream ? vStream.width  : 1080;
      const height  = vStream ? vStream.height : 1920;
      const origBitrate   = vStream ? Math.round(parseInt(vStream.bit_rate || '1000000') / 1000) : 1000;
      const targetBitrate = Math.min(origBitrate + 100, 2000);
      const temAudio = !!aStream;

      console.log('Resolução:', width + 'x' + height, '| Áudio:', temAudio, '| Bitrate target:', targetBitrate + 'k');

      let ruido = 'noise=alls=1:allf=t';
      if (nivel === 'normal')    ruido = 'noise=alls=2:allf=t,hue=s=1.01';
      if (nivel === 'agressiva') ruido = 'noise=alls=3:allf=t,hue=s=1.02';

      // Filtro complexo: aplica ruído + overlay da capa nos primeiros 0.3s
      const complexFilter = [
        // Prepara capa escalada para mesma resolução do vídeo
        `[1:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1[capaescalada]`,
        // Aplica ruído no vídeo original
        `[0:v]${ruido}[vidcomruido]`,
        // Overlay da capa apenas nos primeiros 0.3 segundos
        `[vidcomruido][capaescalada]overlay=0:0:enable='between(t,0,0.3)'[final]`
      ];

      const outputOpts = [
        '-map_metadata', '-1',
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-b:v', targetBitrate + 'k',
        '-async', '1',
        '-vsync', '1',
        '-movflags', '+faststart',
        '-y'
      ];

      if (temAudio) {
        outputOpts.push('-map', '0:a:0');
        outputOpts.push('-c:a', 'aac');
        outputOpts.push('-b:a', '96k');
      } else {
        outputOpts.push('-an');
      }

      ffmpeg()
        .input(inputPath)
        .input(capaPath)
        .complexFilter(complexFilter, 'final')
        .outputOptions(outputOpts)
        .on('start', () => console.log('FFmpeg com capa overlay iniciado'))
        .on('progress', p => { if (p.percent) console.log(Math.round(p.percent) + '%'); })
        .on('end', resolve)
        .on('error', (err) => {
          console.error('Erro overlay, tentando sem capa:', err.message);
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
