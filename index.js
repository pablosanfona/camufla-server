const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const cors = require('cors');
const {v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
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
  próximo();
});

armazenamento const = multer.diskStorage({
  destino: (req, arquivo, cb) => cb(nulo, UPLOAD_DIR),
  nome do arquivo: (req, arquivo, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});

const upload = multer({
  armazenar,
  limites: { tamanhoArquivo: 200 * 1024 * 1024 }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', mensagem: 'Servidor Camufla rodando!' });
});

app.post('/processar', upload.fields([
  { nome: 'vídeo', contagemMáxima: 1 },
  { nome: 'capa', contagemMáxima: 1 }
]), async (req, res) => {

  const videoFile = req.files?.video?.[0];
  const capaFile = req.files?.capa?.[0];
  const nivel = ['básica','normal','agressiva'].includes(req.body.nivel)
    ? req.body.nivel : 'basica';

  se (!videoFile) {
    return res.status(400).json({ erro: 'Nenhum vídeo enviado' });
  }

  const inputPath = videoFile.path;
  const outputName = 'camufla_' + uuidv4() + '.mp4';
  const outputPath = path.join(OUTPUT_DIR, outputName);

  console.log('Processando:', videoFile.originalname, '| Nível:', nivel);

  tentar {
    se (capaFile) {
      await processarComCapa(inputPath, outputPath, nivel, capaFile.path);
    } outro {
      await processarSemCapa(inputPath, outputPath, nivel);
    }

    se (!fs.existsSync(outputPath)) {
      throw new Error('Arquivo de saída não foi gerado');
    }

    console.log('Concluído:', nomedasaída);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="' + outputName + '"');

    const stream = fs.createReadStream(outputPath);
    fluxo.pipe(res);
    stream.on('end', () => {
      limpar(caminho_de_entrada);
      limpar(caminho_saída);
      se (capaFile) limpar(capaFile.path);
    });
    stream.on('error', (err) => {
      limpar(caminho_de_entrada);
      limpar(caminho_saída);
      se (capaFile) limpar(capaFile.path);
    });

  } catch (erro) {
    console.error('Erro:', err.mensagem);
    limpar(caminho_de_entrada);
    limpar(caminho_saída);
    se (capaFile) limpar(capaFile.path);
    se (!res.headersSent) {
      res.status(500).json({ erro: 'Erro ao processar: ' + err.message });
    }
  }
});

// ============================================
// SEM CAPA — FIX ÁUDIO
// ============================================
function processarSemCapa(inputPath, outputPath, nivel) {
  retornar nova Promise((resolver, rejeitar) => {
    const crf = nível === 'básico'? 28: nível === 'normal'? 26:24;
    let vfiltro = 'noise=alls=1:allf=t';
    se (nível === 'normal') vfiltro = 'ruído=alls=2:allf=t,matiz=s=1.01';
    se (nível === 'agressiva') vfiltro = 'ruído=alls=3:allf=t,matiz=s=1.02';

    ffmpeg(caminho_de_entrada)
      .videoFilters(vfiltro)
      .outputOptions([
        '-mapa', '0:v:0',
        '-map', '0:a:0', // FIX: força pegar o primeiro stream de áudio
        '-map_metadata', '-1',
        '-c:v', 'libx264',
        '-predefinido', 'ultrarrápido',
        '-crf', String(crf),
        '-c:a', 'aac',
        '-b:a', '128k',
        '-estrito', 'experimental',
        '-movflags', '+faststart',
        '-y'
      ])
      .on('start', cmd => console.log('FFmpeg sem capa:', cmd))
      .on('progress', p => { if (p.percent) console.log(Math.round(p.percent) + '%'); })
      .on('end', resolve)
      .on('error', (err) => {
        console.error('Erro FFmpeg sem capa:', err.message);
        // Se falhar com áudio, tente sem mapear áudio explicitamente
        ffmpeg(caminho_de_entrada)
          .videoFilters(vfiltro)
          .outputOptions([
            '-map_metadata', '-1',
            '-c:v', 'libx264',
            '-predefinido', 'ultrarrápido',
            '-crf', String(crf),
            '-c:a', 'aac',
            '-b:a', '128k',
            '-movflags', '+faststart',
            '-y'
          ])
          .on('end', resolve)
          .on('error', reject)
          .salvar(caminho_de_saída);
      })
      .salvar(caminho_de_saída);
  });
}

// ============================================
// COM CAPA — FIX ÁUDIO + capa 0.3 segundos
// ============================================
function processarComCapa(inputPath, outputPath, nivel, capaPath) {
  retornar nova Promise((resolver, rejeitar) => {
    const capaVideoPath = path.join(OUTPUT_DIR, 'capa_' + uuidv4() + '.mp4');
    const silencioPath = path.join(OUTPUT_DIR, 'sil_' + uuidv4() + '.mp4');
    const concatPath = path.join(OUTPUT_DIR, 'concat_' + uuidv4() + '.txt');

    // Detectar resolução e informações de áudio do vídeo original
    ffmpeg.ffprobe(inputPath, function(err, metadata) {
      se (erro) { rejeitar(erro); retornar; }

      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
      const width = videoStream ? videoStream.width : 1080;
      const altura = videoStream ? videoStream.altura : 1920;
      const fps = videoStream ? (videoStream.r_frame_rate || '30/1') : '30/1';
      const temAudio = !!audioStream;

      console.log('Resolução:', largura + 'x' + altura, '| Áudio:', temAudio);

      // Passo 1: Criar capacidade de 0,3 segundos com a mesma resolução
      ffmpeg(capaPath)
        .loop(1)
        .duração(0.3)
        .outputOptions([
          '-c:v', 'libx264',
          '-predefinido', 'ultrarrápido',
          '-t', '0,3',
          '-pix_fmt', 'yuv420p',
          '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
          '-r', fps,
          '-um',
          '-y'
        ])
        .on('end', function() {
          console.log('Capa criada (0.3s)');

          se (temAudio) {
            // Criar silêncio de 0,3s para a capacidade de áudio
            ffmpeg()
              .input('anullsrc=r=44100:cl=stereo')
              .inputOptions(['-f', 'lavfi'])
              .outputOptions([
                '-t', '0,3',
                '-c:a', 'aac',
                '-b:a', '128k',
                '-y'
              ])
              .on('end', function() {
                // Combinar capa com silêncio
                ffmpeg()
                  .input(capaVideoPath)
                  .input(silencioPath)
                  .outputOptions([
                    '-c:v', 'cópia',
                    '-c:a', 'aac',
                    '-mais curto',
                    '-y'
                  ])
                  .on('end', function() {
                    concatenarEProcessar();
                  })
                  .on('error', function(e) {
                    console.error('Erro ao combinar silêncio:', e.message);
                    // Continua sem silêncio
                    concatenarEProcessar();
                  })
                  .save(capaVideoPath + '_com_audio.mp4');
              })
              .on('error', function() {
                concatenarEProcessar();
              })
              .save(silencioPath);
          } outro {
            concatenarEProcessar();
          }
        })
        .on('error', reject)
        .save(capaVideoPath);

      função concatenarEProcessar() {
        const capaFinal = fs.existsSync(capaVideoPath + '_com_audio.mp4')
          ? capaVideoPath + '_com_audio.mp4'
          : capaVideoPath;

        fs.writeFileSync(concatPath,
          `arquivo '${capaFinal}'\narquivo '${inputPath}'`
        );

        const crf = nível === 'básico'? 28: nível === 'normal'? 26:24;
        let vfiltro = 'noise=alls=1:allf=t';
        se (nível === 'normal') vfiltro = 'ruído=alls=2:allf=t,matiz=s=1.01';
        se (nível === 'agressiva') vfiltro = 'ruído=alls=3:allf=t,matiz=s=1.02';

        ffmpeg()
          .input(concatPath)
          .inputOptions(['-f', 'concat', '-safe', '0'])
          .videoFilters(vfiltro)
          .outputOptions([
            '-mapa', '0:v:0',
            '-mapa', '0:a?',
            '-map_metadata', '-1',
            '-c:v', 'libx264',
            '-predefinido', 'ultrarrápido',
            '-crf', String(crf),
            '-c:a', 'aac',
            '-b:a', '128k',
            '-movflags', '+faststart',
            '-y'
          ])
          .on('end', function() {
            limpar(capaVideoPath);
            limpar(capaVideoPath + '_com_audio.mp4');
            limpar(silencioPath);
            limpar(concatPath);
            resolver();
          })
          .on('error', function(err) {
            limpar(capaVideoPath);
            limpar(capaVideoPath + '_com_audio.mp4');
            limpar(silencioPath);
            limpar(concatPath);
            rejeitar(erro);
          })
          .salvar(caminho_de_saída);
      }
    });
  });
}

função limpar(caminho_do_arquivo) {
  try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch(e) {}
}

setInterval(() => {
  const agora = Date.now();
  [UPLOAD_DIR, OUTPUT_DIR].forEach(dir => {
    tentar {
      fs.readdirSync(dir).forEach(file => {
        const fp = path.join(dir, file);
        tente { if (agora - fs.statSync(fp).mtimeMs > 3600000) limpar(fp); } pegar(e) {}
      });
    } catch(e) {}
  });
}, 3600000);

app.listen(PORT, () => console.log('Camufla Server na porta ' + PORT));
