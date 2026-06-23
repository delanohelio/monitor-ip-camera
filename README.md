# Monitor IP Camera

Aplicação web para monitorar câmeras IP via RTSP, com Node.js (stdlib), FFmpeg e frontend puro (HTML/CSS/JS).

## Recursos

- Multi-câmeras com RTSP -> HLS.
- Fallback automático de transporte RTSP (UDP/TCP).
- Fallback de codec para transcode (libx264) quando stream HEVC/timestamps falha.
- Reconexão automática por câmera.
- Edição de câmera (nome, IP, login, senha, porta, path) sem remover manualmente.
- Layout de grade automático ou manual (1x1, 2x2, 3x3, 4x4).
- Controles por câmera na lateral: subir/descer, áudio on/off, visível on/off, editar, remover.
- Ações globais: ativar/desativar todos os áudios, fullscreen.
- Modo economia de energia com tela preta e despertar por áudio.
- Token de acesso obrigatório.
- Defaults de câmeras via arquivo JSON (para provisionamento).
- Gerenciamento de viewers por câmera (id do viewer = ip:porta): remove câmera sem viewers ativos.

## Requisitos

| Dependência | Versão mínima |
|-------------|---------------|
| [Node.js](https://nodejs.org) | 20+ |
| [FFmpeg](https://ffmpeg.org/download.html) | versão recente com AAC e HLS |

## Instalação rápida

```bash
npm install
npm start
```

## Execução local

```bash
node server.js
```

Por padrão sobe em `http://localhost:3000`.

Ao iniciar, o serviço exibe:

- token de acesso (gerado ou vindo de env)
- URL de acesso com `?token=...`

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `PORT` | `3000` | Porta HTTP do servidor |
| `ACCESS_TOKEN` | gerado automático | Token de acesso fixo |
| `IPCAM_ACCESS_TOKEN` | vazio | Alias para `ACCESS_TOKEN` |
| `DEFAULT_CAMERAS_FILE` | vazio | Caminho para JSON com câmeras padrão |
| `VIEWER_TTL_MS` | `30000` | TTL de atividade do viewer por câmera |
| `EMPTY_CAMERA_GRACE_MS` | `45000` | Tempo sem viewers para remover câmera |

## Docker

### Build

```bash
docker build -t monitor-ip-camera:latest .
```

### Run (token fixo)

```bash
docker run --name monitor-ip-camera -p 3000:3000 \
    -e ACCESS_TOKEN=seu_token_forte \
    --restart unless-stopped \
    monitor-ip-camera:latest
```

### Run com defaults via arquivo JSON

```bash
docker run --name monitor-ip-camera -p 3000:3000 \
    -e ACCESS_TOKEN=seu_token_forte \
    -e DEFAULT_CAMERAS_FILE=/config/default-cameras.json \
    -v /caminho/local/default-cameras.json:/config/default-cameras.json:ro \
    --restart unless-stopped \
    monitor-ip-camera:latest
```

## Formato do arquivo de defaults

Arquivo JSON deve conter um array:

```json
[
    {
        "name": "Portao",
        "ip": "192.168.1.10",
        "login": "admin",
        "password": "123456",
        "port": 554,
        "path": "/onvif1"
    },
    {
        "name": "Garagem",
        "ip": "192.168.1.11",
        "login": "admin",
        "password": "abcdef",
        "port": 554,
        "path": "/onvif1"
    }
]
```

## Fluxo de configuração no frontend

- Se já existir câmera ativa no backend, usa as câmeras ativas.
- Se backend estiver vazio, tenta restaurar do `localStorage` do navegador.
- Se `localStorage` estiver vazio, tenta carregar do `DEFAULT_CAMERAS_FILE` via API.
- Botão `Restaurar padrão` substitui as câmeras atuais pelas do arquivo default.

## Segurança de acesso

- Toda rota exige token válido.
- Pode autenticar via query `?token=<token>`.
- Após autenticar por query, o backend grava cookie (`ipcam_token`) para próximas requisições.

## Viewers e ciclo de vida de câmera

- Viewer é identificado por `ip:porta` da conexão HTTP.
- Cada requisição HLS marca o viewer como ativo para aquela câmera.
- Se não houver viewers ativos por `EMPTY_CAMERA_GRACE_MS`, a câmera é removida automaticamente do backend.
- Endpoint para inspeção: `GET /api/viewers`.

## Endpoints principais

- `GET /api/cameras`
- `POST /api/cameras`
- `PUT /api/cameras/:id`
- `DELETE /api/cameras/:id`
- `PUT /api/cameras/reorder`
- `POST /api/cameras/:id/reconnect`
- `GET /api/cameras/health`
- `GET /api/default-cameras`
- `GET /api/viewers`
- `GET /hls/:id/:file`

## Estrutura

```text
monitor-ip-camera/
├── server.js
├── package.json
├── Dockerfile
└── public/
        ├── index.html
        ├── style.css
        └── app.js
```
