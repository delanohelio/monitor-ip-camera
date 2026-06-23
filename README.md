# Monitor IP Camera

Aplicação web para exibir streams de câmeras IP via RTSP na LAN.  
Sem frameworks — apenas Node.js (stdlib) + FFmpeg no back-end e HTML/CSS/JS puro no front-end.

## Requisitos

| Dependência | Versão mínima |
|-------------|--------------|
| [Node.js](https://nodejs.org) | 16+ |
| [FFmpeg](https://ffmpeg.org/download.html) | qualquer versão recente com codec AAC |

### Instalar FFmpeg

**macOS (Homebrew)**
```bash
brew install ffmpeg
```

**Ubuntu / Debian**
```bash
sudo apt update && sudo apt install ffmpeg
```

**Windows** — baixar o binário em <https://ffmpeg.org/download.html> e adicionar ao `PATH`.

## Como executar

```bash
node server.js
# ou
npm start
```

Acesse **http://localhost:3000** no navegador da mesma máquina (ou de outro dispositivo na mesma LAN usando o IP da máquina servidora).

A porta padrão é `3000`. Para mudar:

```bash
PORT=8080 node server.js
```

## Uso

1. **Adicionar câmera** — preencha Nome (opcional), IP, Login e Senha no painel lateral.  
   A URL RTSP gerada automaticamente segue o padrão:
   ```
   rtsp://<login>:<senha>@<IP>:554/onvif1
   ```
   Porta e caminho podem ser alterados nas *Opções avançadas*.

2. **Remover câmera** — clique no ✕ ao lado do nome na lista.

3. **Reordenar** — arraste os itens pelo ícone ⠿ na lista lateral.

4. **Grade automática** — a tela se divide automaticamente de acordo com o número de câmeras (1 → 1×1, 2 → 2×1, 4 → 2×2, 9 → 3×3, etc.).

5. **Áudio** — cada tile inicia mudo (requisito de autoplay dos navegadores). Clique em 🔇 para ativar o som individualmente.

6. **Tela cheia** — clique em ⛶ (aparece ao passar o mouse sobre o tile).

## Como funciona

```
Câmera IP ──RTSP──► FFmpeg ──HLS (m3u8/ts)──► Node.js HTTP ──► Navegador
                                                                 (hls.js)
```

- O servidor Node.js (apenas stdlib) escuta requisições REST e serve os arquivos estáticos.
- Para cada câmera adicionada, um processo `ffmpeg` é criado, que converte o stream RTSP em HLS e grava segmentos `.ts` no diretório temporário do sistema.
- O navegador consome os segmentos HLS via [hls.js](https://github.com/video-dev/hls.js) (carregado via CDN).
- Credenciais RTSP **nunca** saem do servidor; o cliente só conhece o ID da câmera.

## Estrutura

```
monitor-ip-camera/
├── server.js          # Servidor HTTP + gestão dos processos FFmpeg
├── package.json
└── public/
    ├── index.html     # Estrutura da página
    ├── style.css      # Tema escuro (NVR-like)
    └── app.js         # Lógica do cliente (sem framework)
```
# monitor-ip-camera
