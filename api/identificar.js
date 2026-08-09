// /api/identificar.js
// Endpoint serverless (Vercel) para identificação de pedras via IA (Claude API).
// Agora a identificação em si é GRÁTIS para quem está logado (não exige pagamento).
// Preço e onde vender só entram na resposta se a conta já tiver crédito pago
// disponível — nesse caso, 1 crédito é consumido na hora. Se não tiver crédito,
// o resultado completo fica salvo no banco (tabela identificacoes) e a pessoa
// libera depois via /api/desbloquear, sem precisar rodar a IA de novo.

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

  // ---- 2. Validar login (pagamento NÃO é mais exigido aqui) ----
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
    // ---- 3. Chamar a Claude API ----
    const promptSistema = `Você é um especialista em gemologia e identificação de pedras e minerais.
Analise a imagem da pedra enviada e responda APENAS com um JSON válido, sem markdown, sem crases, sem texto antes ou depois, no seguinte formato exato:

{
  "nome_provavel": "nome da pedra em português",
  "confianca": "alta" | "media" | "baixa",
  "nomes_alternativos": ["nome1", "nome2"],
  "caracteristicas": ["característica 1", "característica 2", "característica 3"],
  "faixa_preco_brasil": "faixa de preço em reais praticada no mercado brasileiro, ex: R$20 a R$150 por grama/unidade bruta",
  "onde_vender": "sugestões objetivas de onde vender esse tipo de pedra no Brasil, ex: lojas de minerais, feiras de gemas, colecionadores, joalherias, marketplaces especializados",
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

    let resultadoIA;
    try {
      const limpo = textoResposta.replace(/```json|```/g, '').trim();
      resultadoIA = JSON.parse(limpo);
    } catch (e) {
      console.error('Falha ao parsear JSON da Claude:', textoResposta);
      return res.status(502).json({ error: 'Não foi possível interpretar o resultado. Tente novamente.' });
    }

    // ---- 4. Salvar o resultado COMPLETO no banco (preço/onde vender inclusive) ----
    const { data: linhaSalva, error: erroInsert } = await supabase
      .from('identificacoes')
      .insert({
        email: email,
        nome_provavel: resultadoIA.nome_provavel || null,
        confianca: resultadoIA.confianca || null,
        nomes_alternativos: resultadoIA.nomes_alternativos || [],
        caracteristicas: resultadoIA.caracteristicas || [],
        observacao: resultadoIA.observacao || null,
        faixa_preco_brasil: resultadoIA.faixa_preco_brasil || null,
        onde_vender: resultadoIA.onde_vender || null,
        desbloqueada: false
      })
      .select('*')
      .single();

    if (erroInsert || !linhaSalva) {
      console.error('Erro Supabase (insert identificacao):', erroInsert);
      return res.status(500).json({ error: 'Erro ao salvar o resultado. Tente novamente.' });
    }

    // ---- 5. Ver se essa conta já tem crédito pago disponível ----
    const { data: credito } = await supabase
      .from('creditos_avaliacao')
      .select('*')
      .eq('email', email)
      .eq('status', 'pago')
      .single();

    const temCreditoDisponivel = !!credito && credito.usos < credito.limite;

    let desbloqueado = false;
    let usosRestantes;
    let saldoRestante;

    if (temCreditoDisponivel) {
      // Já tinha pago antes (ou já desbloqueou outras): consome 1 crédito
      // e libera essa identificação na hora, sem passo extra.
      const { error: erroUpdateCredito } = await supabase
        .from('creditos_avaliacao')
        .update({ usos: credito.usos + 1 })
        .eq('email', email);

      if (!erroUpdateCredito) {
        await supabase
          .from('identificacoes')
          .update({ desbloqueada: true })
          .eq('id', linhaSalva.id);

        desbloqueado = true;
        usosRestantes = credito.limite - (credito.usos + 1);
        saldoRestante = credito.limite > 0
          ? Math.round((credito.valor_pago * usosRestantes / credito.limite) * 100) / 100
          : 0;
      } else {
        console.error('Erro Supabase (update crédito):', erroUpdateCredito);
      }
    }

    // ---- 6. Montar resposta: nome/confiança/alternativos/características SEMPRE
    //          vão; preço/onde vender só se "desbloqueado" for true. ----
    const resposta = {
      identificacao_id: linhaSalva.id,
      nome_provavel: resultadoIA.nome_provavel,
      confianca: resultadoIA.confianca,
      nomes_alternativos: resultadoIA.nomes_alternativos,
      caracteristicas: resultadoIA.caracteristicas,
      observacao: resultadoIA.observacao,
      desbloqueado: desbloqueado,
      faixa_preco_brasil: desbloqueado ? resultadoIA.faixa_preco_brasil : '',
      onde_vender: desbloqueado ? resultadoIA.onde_vender : ''
    };

    if (desbloqueado) {
      resposta.usos_restantes = usosRestantes;
      resposta.saldo_restante = saldoRestante;
    }

    return res.status(200).json(resposta);

  } catch (err) {
    console.error('Erro inesperado:', err);
    return res.status(500).json({ error: 'Erro interno. Tente novamente em instantes.' });
  }
};
