// /api/identificar.js
// Endpoint serverless (Vercel) para identificação de pedras via IA (Claude API)
// Controla acesso via login (e-mail + senha, Supabase Auth) + crédito pago no banco.
// (Antes controlava por cookie de sessão vinculado à rota /api/reivindicar.)

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function pegarToken(req) {
  const cabecalho = req.headers.authorization || '';
  if (cabecalho.indexOf('Bearer ') === 0) {
    return cabecalho.slice(7);
  }
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const { base64, mediaType } = req.body || {};

  // ---- 1. Validações básicas de entrada ----
  if (!base64 || !mediaType) {
    return res.status(400).json({ error: 'Foto não enviada corretamente' });
  }

  const tiposPermitidos = ['image/jpeg', 'image/png', 'image/webp'];
  if (!tiposPermitidos.includes(mediaType)) {
    return res.status(400).json({ error: 'Formato de imagem não suportado' });
  }

  if (base64.length > 11_000_000) {
    return res.status(400).json({ error: 'Imagem muito grande. Envie uma foto menor.' });
  }

  // ---- 2. Validar login ----
  const token = pegarToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Você precisa entrar na sua conta primeiro.' });
  }

  const { data: userData, error: erroAuth } = await supabase.auth.getUser(token);
  if (erroAuth || !userData || !userData.user || !userData.user.email) {
    return res.status(401).json({ error: 'Sessão inválida. Faça login novamente.' });
  }

  const email = userData.user.email.toLowerCase();

  try {
    // ---- 3. Buscar o crédito pago vinculado a esse e-mail ----
    const { data: registro, error: erroBusca } = await supabase
      .from('creditos_avaliacao')
      .select('*')
      .eq('email', email)
      .eq('status', 'pago')
      .single();

    if (erroBusca || !registro) {
      return res.status(402).json({ error: 'Você ainda não pagou pela avaliação.', pago: false });
    }

    // ---- 4. Checar limite ----
    if (registro.usos >= registro.limite) {
      return res.status(403).json({
        error: 'Você já usou suas ' + registro.limite + ' identificações disponíveis.'
      });
    }

    // ---- 5. Chamar a Claude API ----
    const promptSistema = `Você é um especialista em gemologia e identificação de pedras e minerais.
Analise a imagem da pedra enviada e responda APENAS com um JSON válido, sem markdown, sem crases, sem texto antes ou depois, no seguinte formato exato:

{
  "nome_provavel": "nome da pedra em português",
  "confianca": "alta" | "media" | "baixa",
  "nomes_alternativos": ["nome1", "nome2"],
  "caracteristicas": ["característica 1", "característica 2", "característica 3"],
  "faixa_preco_brasil": "faixa de preço em reais praticada no mercado brasileiro, ex: R$20 a R$150 por grama/unidade bruta",
  "observacao": "uma frase curta com recomendação, ex: para confirmar o valor exato, procure um gemólogo"
}

Se não for possível identificar com segurança, defina confianca como "baixa" e ainda assim dê o palpite mais provável.`;

    const respostaClaude = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: promptSistema,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mediaType, data: base64 }
              },
              {
                type: 'text',
                text: 'Identifique esta pedra e responda apenas com o JSON pedido.'
              }
            ]
          }
        ]
      })
    });

    if (!respostaClaude.ok) {
      const erroTexto = await respostaClaude.text();
      console.error('Erro Claude API:', erroTexto);
      return res.status(502).json({ error: 'Erro ao analisar a imagem. Tente novamente.' });
    }

    const dataClaude = await respostaClaude.json();
    const textoResposta = (dataClaude.content || [])
      .filter(item => item.type === 'text')
      .map(item => item.text)
      .join('');

    let resultado;
    try {
      const limpo = textoResposta.replace(/```json|```/g, '').trim();
      resultado = JSON.parse(limpo);
    } catch (e) {
      console.error('Falha ao parsear JSON da Claude:', textoResposta);
      return res.status(502).json({ error: 'Não foi possível interpretar o resultado. Tente novamente.' });
    }

    // ---- 6. Incrementar contador de uso (só depois de sucesso) ----
    const { error: erroUpdate } = await supabase
      .from('creditos_avaliacao')
      .update({ usos: registro.usos + 1 })
      .eq('email', email);

    if (erroUpdate) {
      console.error('Erro Supabase (update):', erroUpdate);
    }

    resultado.usos_restantes = registro.limite - (registro.usos + 1);
    return res.status(200).json(resultado);

  } catch (err) {
    console.error('Erro inesperado:', err);
    return res.status(500).json({ error: 'Erro interno. Tente novamente em instantes.' });
  }
};
