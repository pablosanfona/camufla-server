const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const cors = require('cors');

const app = express();

// Limite de 50MB para evitar crash de memória no Free tier
const upload = multer({ 
  dest: '/tmp/uploads/',
  limits: { fileSize: 50 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json());

// Técnicas otimizadas para usar MENOS memória
const TECNICAS = {
  basica: {
    preset: 'veryfast',      // Mais rápido = menos RAM
    crf: 28,                 // Compressão maior = arquivo menor
    filtros: ['noise=alls=1:allf=t']
  },
  normal: {
    preset: 'fast',
    crf: 26,
    filtros: ['noise=alls=2:allf=t', 'fps=29.97']
  },
  agressiva: {
    preset: 'fast',
    crf: 25,
    filtros: ['noise=alls=3:allf=t', 'fps=29.97', 'hue=s=1.01']
  }
};

app.post('/processar', upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'capa', maxCount: 1 }
]), async (req, res) => {
  console.log('[INICIO] Nova requisição');
  
  let videoPath, capaPath, outputPath;
  
  try {
    if (!req.files || !req.files.video) {
      return res.status(400).json({ erro: 'Nenhum vídeo enviado' });
    }

    const nivel = req.body.nivel || 'basica';
    videoPath = req.files.video[0].path;
    capaPath = req.files.capa ? req.files.capa[0].path : null;
    outputPath = `/tmp/output_${Date.now()}.mp4`;

    const tamanhoMB = (req.files.video[0].size / 1024 / 1024).toFixed(2);
    console.log(`[INFO] Vídeo: ${req.files.video[0].originalname} (${tamanhoMB} MB)`);
    console.log(`[INFO] Nível: ${nivel}`);

    // Limite de segurança para Free tier
    if (req.files.video[0].size > 50 * 1024 * 1024) {
      throw new Error('Vídeo muito grande. Máximo 50MB no plano Free.');
    }

    const tec = TECNICAS[nivel];
    
    // Construir comando FFmpeg OTIMIZADO para baixo uso de memória
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-threads', '2',          // Limitar threads
      '-i', videoPath
    ];

    // Se tiver capa, adicionar como overlay APENAS no primeiro frame
    if (capaPath) {
      args.push('-i', capaPath);
      args.push('-filter_complex',
        `[1:v]${tec.filtros.join(',')}[v];[0:v][v]overlay=enable='lte(t,0.04)'[outv]`
      );
      args.push('-map', '[outv]');
      args.push('-map', '1:a?');
    } else {
      args.push('-vf', tec.filtros.join(','));
      args.push('-map', '0:v', '-map', '0:a?');
    }

    args.push(
      '-c:v', 'libx264',
      '-preset', tec.preset,    // veryfast/fast = menos RAM
      '-crf', String(tec.crf),
      '-c:a', 'copy',           // Não recodificar áudio = menos RAM
      '-movflags', '+faststart',
      '-y',
      outputPath
    );

    console.log(`[EXEC] ffmpeg com preset ${tec.preset}`);

    // Usar spawn ao invés de execSync para controlar memória
    const ffmpeg = spawn('ffmpeg', args);
    
    let stderr = '';
    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        console.error('[ERRO FFmpeg]', stderr);
        cleanup();
        return res.status(500).json({ erro: 'Erro ao processar vídeo', detalhes: stderr });
      }

      console.log('[SUCESSO] Vídeo processado');

      // Limpar metadados (rápido, pouca RAM)
      const finalPath = `/tmp/final_${Date.now()}.mp4`;
      const metaArgs = [
        '-hide_banner',
        '-i', outputPath,
        '-map_metadata', '-1',
        '-metadata', `creation_time=${new Date(Date.now() + Math.random() * 86400000).toISOString()}`,
        '-c', 'copy',
        '-y',
        finalPath
      ];

      const ffmpegMeta = spawn('ffmpeg', metaArgs);
      
      ffmpegMeta.on('close', (metaCode) => {
        if (metaCode !== 0) {
          // Se falhar, enviar sem limpar metadata
          console.warn('[AVISO] Falha ao limpar metadata, enviando vídeo mesmo assim');
          enviarArquivo(outputPath);
        } else {
          // Adicionar bytes extras (técnica de camuflagem)
          if (nivel !== 'basica') {
            const bytesExtras = Buffer.alloc(50 + Math.floor(Math.random() * 100), 0);
            fs.appendFileSync(finalPath, bytesExtras);
          }
          enviarArquivo(finalPath);
        }
      });
    });

    function enviarArquivo(path) {
      res.sendFile(path, (err) => {
        cleanup();
        if (err) {
          console.error('[ERRO ENVIO]', err.message);
        }
      });
    }

    function cleanup() {
      try {
        if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        if (capaPath && fs.existsSync(capaPath)) fs.unlinkSync(capaPath);
        if (outputPath && fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        if (finalPath && fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
      } catch (e) {
        console.error('[CLEANUP]', e.message);
      }
    }

  } catch (error) {
    console.error('[ERRO FATAL]', error.message);
    
    // Cleanup
    try {
      if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
      if (capaPath && fs.existsSync(capaPath)) fs.unlinkSync(capaPath);
      if (outputPath && fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch (e) {}
    
    res.status(500).json({ 
      erro: error.message
    });
  }
});

app.get('/health', (req, res) => {
  // Verificar memória disponível
  const usado = process.memoryUsage();
  const usoMB = Math.round(usado.heapUsed / 1024 / 1024);
  
  res.json({ 
    status: 'ok',
    message: 'Camufla Server rodando!',
    memoria_uso_mb: usoMB,
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🎭 Camufla Server OTIMIZADO na porta ${PORT}`);
  console.log(`💾 Memória inicial: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`);
});
