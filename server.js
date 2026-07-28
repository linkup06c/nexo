const WebSocket = require('ws');
const http = require('http');

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
        status: "online", 
        totalDispositivos: dispositivosUnicosMap.size,
        modoStandby: filaMidias.length === 0
    }));
});

const wss = new WebSocket.Server({ server });

let filaMidias = []; 
let indiceReproduzindo = 0; 
let isPlaying = false;
let timestampInicioEpoch = 0; 
let milissegundosAcumuladosAntesDoPause = 0; 
let duracaoAtualMs = 0; // NOVO: Armazena a duração do vídeo para a barra do celular funcionar

// MAPA DE DISPOSITIVOS REAIS
const dispositivosUnicosMap = new Map();

function calcularTempoAtualMs() {
    if (!isPlaying || filaMidias.length === 0) return milissegundosAcumuladosAntesDoPause;
    let tempoCalculado = milissegundosAcumuladosAntesDoPause + (Date.now() - timestampInicioEpoch);
    // Trava para não ultrapassar a duração do vídeo, se ela for conhecida
    if (duracaoAtualMs > 0 && tempoCalculado > duracaoAtualMs) {
        return duracaoAtualMs;
    }
    return tempoCalculado;
}

// SINCRONIZAÇÃO DA MÍDIA (A cada 1 segundo avisa o Android)
setInterval(() => {
    if (isPlaying && filaMidias.length > 0) {
        broadcastParaTodos({
            tipo: "SYNC_TEMPO", // O Android agora usa essa chave para ler a mensagem
            comando: "SYNC_TEMPO", 
            posicaoMs: calcularTempoAtualMs(),
            duracaoMs: duracaoAtualMs > 0 ? duracaoAtualMs : 120000, // Envia 2 min por padrão se a TV não avisar a duração real
            timestampServidor: Date.now(), 
            reproduzindo: isPlaying
        });
    }
}, 1000);

// RADAR ANTI-FANTASMA
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 4000);

wss.on('connection', (ws) => {
    let meuIdRegistrado = null;
    ws.isAlive = true;

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.tipo === 'REGISTRAR_DISPOSITIVO' && data.deviceId) {
                meuIdRegistrado = data.deviceId;
                if (dispositivosUnicosMap.has(meuIdRegistrado)) {
                    const socketAntigo = dispositivosUnicosMap.get(meuIdRegistrado);
                    if (socketAntigo !== ws && socketAntigo.readyState === WebSocket.OPEN) {
                        socketAntigo.close();
                    }
                }
                dispositivosUnicosMap.set(meuIdRegistrado, ws);
                enviarEstadoInicial(ws);
                broadcastContador();
                return;
            }

            if (data.tipo === 'DESCONECTAR') {
                if (meuIdRegistrado && dispositivosUnicosMap.get(meuIdRegistrado) === ws) {
                    dispositivosUnicosMap.delete(meuIdRegistrado);
                    broadcastContador();
                }
                ws.close();
                return;
            }

            // CORREÇÃO: Padronizando variáveis para não bloquear comandos do celular
            const tipo = (data.tipo || data.acao || "").toLowerCase();
            const url = data.url;
            const slink = (data.slink || data.comando || "").toLowerCase();

            // ROTA EXCLUSIVA PARA A TV AVISAR O SERVIDOR DO TEMPO REAL
            if (tipo === 'status_player' || tipo === 'sync_tv') {
                if (data.duracaoMs) duracaoAtualMs = parseInt(data.duracaoMs, 10);
                if (data.posicaoMs !== undefined) {
                    milissegundosAcumuladosAntesDoPause = parseInt(data.posicaoMs, 10);
                    timestampInicioEpoch = Date.now();
                }
                return; // Atualiza o servidor sem gerar loop de broadcast
            }

            if (tipo === 'midia' || tipo === 'adicionar_midia' || url) {
                if (url) {
                    const estavaVazio = filaMidias.length === 0;
                    filaMidias.push({ id: Date.now().toString(), url: url, titulo: data.titulo || `Mídia ${filaMidias.length + 1}` });

                    if (estavaVazio) {
                        indiceReproduzindo = 0; 
                        milissegundosAcumuladosAntesDoPause = 0; 
                        duracaoAtualMs = data.duracaoMs || 0; // Pega a duração inicial se enviada
                        timestampInicioEpoch = Date.now(); 
                        isPlaying = true;
                    }
                    broadcastEstadoTotal();
                }
            } 
            else if (tipo === 'proximo_video') {
                if (filaMidias.length > 0) {
                    filaMidias.shift(); // Consome/apaga o vídeo antigo
                    milissegundosAcumuladosAntesDoPause = 0; 
                    duracaoAtualMs = 0;
                    timestampInicioEpoch = Date.now(); 

                    if (filaMidias.length > 0) {
                        indiceReproduzindo = 0;
                        isPlaying = true;
                    } else {
                        isPlaying = false; // Entra em Standby
                    }
                    broadcastEstadoTotal();
                }
            } 
            else {
                // CORREÇÃO DA FALHA DO SEEK: Garante que "cmd" pegue o "tipo" caso "slink" não exista
                const cmd = slink || tipo; 

                if (cmd === 'clear' || cmd === 'limpar') { 
                    filaMidias = []; 
                    indiceReproduzindo = 0; 
                    milissegundosAcumuladosAntesDoPause = 0; 
                    duracaoAtualMs = 0;
                    isPlaying = false; 
                }
                else if (cmd === 'next') { 
                    if (filaMidias.length > 0) {
                        filaMidias.shift();
                        milissegundosAcumuladosAntesDoPause = 0; 
                        duracaoAtualMs = 0;
                        timestampInicioEpoch = Date.now();
                        isPlaying = filaMidias.length > 0;
                    } 
                }
                else if (cmd === 'forward' || cmd === 'avancar_15' || cmd === 'forward_15') {
                    if (isPlaying && filaMidias.length > 0) {
                        let tempoAtual = calcularTempoAtualMs() + 15000;
                        if (duracaoAtualMs > 0 && tempoAtual > duracaoAtualMs) tempoAtual = duracaoAtualMs;
                        milissegundosAcumuladosAntesDoPause = tempoAtual;
                        timestampInicioEpoch = Date.now();
                    }
                }
                else if (cmd === 'rewind' || cmd === 'voltar_15' || cmd === 'rewind_15') {
                    if (isPlaying && filaMidias.length > 0) {
                        let tempoAtual = Math.max(0, calcularTempoAtualMs() - 15000);
                        milissegundosAcumuladosAntesDoPause = tempoAtual;
                        timestampInicioEpoch = Date.now();
                    }
                }
                // --- TRATAMENTO DE SEEK FUNCIONANDO ---
                else if (cmd === 'seek' || data.posicaoMs !== undefined) {
                    let novaPosicao = data.posicaoMs !== undefined ? data.posicaoMs : data.posicao;
                    if (typeof novaPosicao === 'string') novaPosicao = parseInt(novaPosicao, 10);

                    if (!isNaN(novaPosicao) && filaMidias.length > 0) {
                        milissegundosAcumuladosAntesDoPause = Math.max(0, novaPosicao);
                        if (duracaoAtualMs > 0 && milissegundosAcumuladosAntesDoPause > duracaoAtualMs) {
                            milissegundosAcumuladosAntesDoPause = duracaoAtualMs;
                        }
                        timestampInicioEpoch = Date.now();
                    }
                }
                else if (cmd === 'pause') { 
                    if (isPlaying) { 
                        milissegundosAcumuladosAntesDoPause = calcularTempoAtualMs(); 
                        isPlaying = false; 
                    } 
                }
                else if (cmd === 'play') { 
                    if (!isPlaying && filaMidias.length > 0) { 
                        timestampInicioEpoch = Date.now(); 
                        isPlaying = true; 
                    } 
                }
                
                // Transmite para todos (TV e Celular) se o comando foi de controle
                const comandosValidos = ['clear','limpar','next','forward','avancar_15','forward_15','rewind','voltar_15','rewind_15','seek','pause','play'];
                if (comandosValidos.includes(cmd) || data.posicaoMs !== undefined) {
                    broadcastEstadoTotal();
                }
            }
        } catch (e) { console.error("Erro ao processar mensagem JSON:", e.message); }
    });

    ws.on('close', () => {
        if (meuIdRegistrado && dispositivosUnicosMap.get(meuIdRegistrado) === ws) {
            dispositivosUnicosMap.delete(meuIdRegistrado);
            broadcastContador();
        }
    });
});

function enviarEstadoInicial(ws) {
    if (ws.readyState === WebSocket.OPEN) {
        const emStandby = filaMidias.length === 0;
        ws.send(JSON.stringify({
            tipo: "ESTADO_TOTAL", // Android lê isso
            comando: "ESTADO_TOTAL", 
            fila: filaMidias, 
            indice: indiceReproduzindo,
            modoStandby: emStandby,
            midiaAtual: emStandby ? null : filaMidias[0],
            posicaoMs: calcularTempoAtualMs(), 
            duracaoMs: duracaoAtualMs > 0 ? duracaoAtualMs : 120000, 
            timestampServidor: Date.now(),
            reproduzindo: isPlaying, 
            totalDispositivos: dispositivosUnicosMap.size
        }));
    }
}

function broadcastContador() {
    const payload = JSON.stringify({ totalDispositivos: dispositivosUnicosMap.size });
    dispositivosUnicosMap.forEach((client) => { if (client.readyState === WebSocket.OPEN) client.send(payload); });
}

function broadcastParaTodos(obj) {
    obj.totalDispositivos = dispositivosUnicosMap.size;
    obj.modoStandby = filaMidias.length === 0;
    const str = JSON.stringify(obj);
    dispositivosUnicosMap.forEach((client) => { if (client.readyState === WebSocket.OPEN) client.send(str); });
}

function broadcastEstadoTotal() { dispositivosUnicosMap.forEach((client) => enviarEstadoInicial(client)); }

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
