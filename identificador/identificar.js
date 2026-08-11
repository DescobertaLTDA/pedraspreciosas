// /api/identificar.js
// Endpoint serverless (Vercel) para identificação de pedras via IA (Claude API).
//
// Regras de acesso:
// - Cada conta (por e-mail) tem direito a LIMITE_AVALIACOES_GRATIS identificações
//   gratuitas. Nelas, a resposta traz nome, características, confiança e faixa
//   de preço — mas o campo "onde vender" fica bloqueado, com uma chamada para
//   liberar o acesso premium.
// - Se a conta já tiver crédito pago disponível, a identificação sai completa
//   (com "onde vender") e consome 1 uso do crédito — independente de ainda
//   restarem avaliações grátis.
// - Se a conta já esgotou as avaliações grátis e não tem crédito pago, o
//   pedido é bloqueado ANTES de chamar a Claude API (evita gasto desnecessário).
// - Fotos que a IA identifica como "não é pedra/mineral" nunca contam como uma
//   das avaliações grátis nem consomem crédito pago.
//
// Fotos (múltiplos ângulos):
// - O front envia um array `fotos` com 1 a 5 imagens ({ base64, mediaType } cada).
// - Todas as fotos entram na MESMA mensagem enviada à Claude (um bloco "image"
//   por foto), pra IA cruzar informações entre ângulos (cor, textura, brilho,
//   transparência) — isso continua sendo UMA análise, consumindo 1 avaliação
//   grátis ou 1 uso de crédito pago, nunca 1 por foto.
// - Só a 1ª foto do array é persistida no banco (colunas foto_base64/foto_media_type),
//   como "capa" da identificação — as demais só passam pela chamada à IA e não
//   são salvas, pra não inflar o armazenamento no Supabase.
//
// Também registra (silenciosamente, sem afetar a resposta) o custo em USD de
// cada chamada à Claude API na tabela `custos_ia`, usando o campo "usage"
// que a própria resposta da API já traz — pra você acompanhar gasto x margem
// direto pelo Supabase.

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---- Preços da Claude API (claude-sonnet-4-6), por milhão de tokens ----
// Ajuste aqui se o preço do modelo mudar. Fonte: platform.claude.com/docs
const MODELO = 'claude-sonnet-4-6';
const PRECO_INPUT_POR_MILHAO = 3;   // USD
const PRECO_OUTPUT_POR_MILHAO = 15; // USD

// ---- Cota de avaliações gratuitas por conta ----
const LIMITE_AVALIACOES_GRATIS = 1;
const MENSAGEM_UPSELL = 'Gostou do resultado? Libere agora onde anunciar essa pedra e desbloqueie +10 avaliações completas por apenas R$13,99.';

// ---- Limites de upload de fotos (1 análise = até 5 fotos = 1 crédito) ----
// Payload total do request precisa ficar bem abaixo do limite de body do Vercel
// (4.5MB no plano Hobby). O front já comprime cada imagem no client (~1280px,
// JPEG q0.8) antes de enviar, então esses números são uma margem de segurança.
const MIN_FOTOS = 1;
const MAX_FOTOS = 5;
const TAMANHO_MAX_BASE64_POR_FOTO = 2_000_000;  // ~1.5MB decodificado
const TAMANHO_MAX_BASE64_TOTAL = 4_200_000;     // ~3.1MB decodificado, soma de todas as fotos

function calcularCustoUsd(inputTokens, outputTokens) {
  const custoInput = (inputTokens / 1_000_000) * PRECO_INPUT_POR_MILHAO;
  const custoOutput = (outputTokens / 1_000_000) * PRECO_OUTPUT_POR_MILHAO;
  return Math.round((custoInput + custoOutput) * 1_000_000) / 1_000_000; // 6 casas
}

// Grava o custo da chamada. Roda "fire and forget": se der erro, só loga —
// nunca deve derrubar ou atrasar a resposta pro usuário.
async function registrarCustoIA({ identificacaoId, email, usage }) {
  try {
    if (!usage) return;
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const custoUsd = calcularCustoUsd(inputTokens, outputTokens);

    const { error } = await supabase.from('custos_ia').insert({
      identificacao_id: identificacaoId || null,
      email: email || null,
      modelo: MODELO,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      custo_usd: custoUsd
    });

    if (error) {
      console.error('Erro Supabase (insert custos_ia):', error);
    }
  } catch (err) {
    console.error('Erro inesperado ao registrar custo IA:', err);
  }
}

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

  const { fotos, permitirVitrine } = req.body || {};
  // Se o front não mandar o campo (versão antiga do app, por exemplo),
  // assume true — mas o app atual sempre envia esse valor explicitamente.
  const permiteVitrine = permitirVitrine !== false;

  // ---- 1. Validações básicas de entrada ----
  if (!Array.isArray(fotos) || fotos.length < MIN_FOTOS) {
    return res.status(400).json({ error: 'Envie pelo menos 1 foto da pedra.' });
  }

  if (fotos.length > MAX_FOTOS) {
    return res.status(400).json({ error: `Envie no máximo ${MAX_FOTOS} fotos por análise.` });
  }

  const tiposPermitidos = ['image/jpeg', 'image/png', 'image/webp'];
  let tamanhoTotalBase64 = 0;

  for (let i = 0; i < fotos.length; i++) {
    const foto = fotos[i];
    if (!foto || !foto.base64 || !foto.mediaType) {
      return res.status(400).json({ error: `Foto ${i + 1} não enviada corretamente.` });
    }
    if (!tiposPermitidos.includes(foto.mediaType)) {
      return res.status(400).json({ error: `Formato da foto ${i + 1} não suportado.` });
    }
    if (foto.base64.length > TAMANHO_MAX_BASE64_POR_FOTO) {
      return res.status(400).json({ error: `Foto ${i + 1} está muito grande. Envie uma foto menor.` });
    }
    tamanhoTotalBase64 += foto.base64.length;
  }

  if (tamanhoTotalBase64 > TAMANHO_MAX_BASE64_TOTAL) {
    return res.status(400).json({ error: 'O conjunto de fotos ficou muito grande. Remova alguma foto ou envie versões menores.' });
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
  const nomeExibicao = (userData.user.user_metadata && userData.user.user_metadata.nome)
    ? userData.user.user_metadata.nome
    : email.split('@')[0];
  const whatsappExibicao = (userData.user.user_metadata && userData.user.user_metadata.whatsapp)
    ? userData.user.user_metadata.whatsapp
    : null;

  try {
    // ---- 3. Ver se essa conta já tem crédito pago disponível ----
    const { data: credito } = await supabase
      .from('creditos_avaliacao')
      .select('*')
      .eq('email', email)
      .eq('status', 'pago')
      .single();

    const temCreditoDisponivel = !!credito && credito.usos < credito.limite;

    // ---- 4. Se não tem crédito pago, checar cota de avaliações grátis ----
    // Bloqueia ANTES de chamar a IA, pra não gastar com uma chamada que não vai poder ser liberada.
    let avaliacoesGratisUsadas = 0;
    if (!temCreditoDisponivel) {
      const { count, error: erroContagem } = await supabase
        .from('identificacoes')
        .select('id', { count: 'exact', head: true })
        .eq('email', email)
        .eq('consumiu_credito_pago', false);

      if (erroContagem) {
        console.error('Erro Supabase (contagem avaliações grátis):', erroContagem);
        return res.status(500).json({ error: 'Erro ao verificar sua cota de avaliações. Tente novamente.' });
      }

      avaliacoesGratisUsadas = count || 0;

      if (avaliacoesGratisUsadas >= LIMITE_AVALIACOES_GRATIS) {
        return res.status(402).json({
          error: 'Você já usou suas avaliações gratuitas.',
          avaliacoes_gratis_esgotadas: true,
          mensagem_upsell: MENSAGEM_UPSELL
        });
      }
    }

    // ---- 5. Chamar a Claude API ----
    const promptSistema = `Você é um especialista em gemologia e identificação de pedras e minerais.
Primeiro, avalie se a imagem enviada realmente mostra uma pedra, gema, cristal ou mineral físico (bruto ou lapidado). Fotos de pessoas, animais, objetos do dia a dia, paisagens, telas de celular, texto, ou qualquer coisa que não seja uma pedra/mineral devem ser marcadas como NÃO sendo pedra.

Responda APENAS com um JSON válido, sem markdown, sem crases, sem texto antes ou depois, no seguinte formato exato:

{
  "e_pedra_ou_mineral": true | false,
  "nome_provavel": "nome da pedra em português",
  "confianca": "alta" | "media" | "baixa",
  "nomes_alternativos": ["nome1", "nome2"],
  "caracteristicas": ["característica 1", "característica 2", "característica 3"],
  "faixa_preco_brasil": "faixa de preço em reais praticada no mercado brasileiro, ex: R$20 a R$150 por grama/unidade bruta",
  "onde_vender": "sugestões objetivas de onde vender esse tipo de pedra no Brasil, ex: lojas de minerais, feiras de gemas, colecionadores, joalherias, marketplaces especializados",
  "observacao": "uma frase curta com recomendação, ex: para confirmar o valor exato, procure um gemólogo"
}

Se "e_pedra_ou_mineral" for false, preencha os demais campos com string vazia ou lista vazia — não invente uma identificação.

Se for uma pedra mas não for possível identificar com segurança, defina "e_pedra_ou_mineral" como true, "confianca" como "baixa" e ainda assim dê o palpite mais provável.`;

    const blocosDeImagem = fotos.map(function (foto) {
      return {
        type: 'image',
        source: { type: 'base64', media_type: foto.mediaType, data: foto.base64 }
      };
    });

    const textoInstrucao = fotos.length > 1
      ? `Estas são ${fotos.length} fotos da MESMA pedra, em ângulos e/ou condições de luz diferentes. Compare cor, textura, brilho e transparência entre as fotos para aumentar a precisão da identificação. Identifique esta pedra e responda apenas com o JSON pedido.`
      : 'Identifique esta pedra e responda apenas com o JSON pedido.';

    const respostaClaude = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: 1000,
        system: promptSistema,
        messages: [
          {
            role: 'user',
            content: blocosDeImagem.concat([
              {
                type: 'text',
                text: textoInstrucao
              }
            ])
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
      // Mesmo com falha de parse, a chamada foi cobrada — registra o custo.
      registrarCustoIA({ identificacaoId: null, email, usage: dataClaude.usage });
      return res.status(502).json({ error: 'Não foi possível interpretar o resultado. Tente novamente.' });
    }

    // ---- 5.1 Se a IA identificou que a imagem NÃO é uma pedra/mineral,
    //          corta aqui: não salva em identificacoes, não consome crédito
    //          nem avaliação grátis, só registra o custo (a chamada à IA já
    //          foi feita e cobrada). ----
    if (resultadoIA.e_pedra_ou_mineral === false) {
      registrarCustoIA({ identificacaoId: null, email, usage: dataClaude.usage });
      return res.status(200).json({
        e_pedra_ou_mineral: false,
        error: 'Não conseguimos identificar uma pedra ou mineral nessa foto. Tente enviar uma imagem mais nítida, focada na pedra.'
      });
    }

    // ---- 6. Consumir crédito pago (se houver) ANTES de salvar, pra já
    //          gravar consumiu_credito_pago corretamente na mesma inserção ----
    let desbloqueado = false;
    let usosRestantes;
    let saldoRestante;

    if (temCreditoDisponivel) {
      const { error: erroUpdateCredito } = await supabase
        .from('creditos_avaliacao')
        .update({ usos: credito.usos + 1 })
        .eq('email', email);

      if (!erroUpdateCredito) {
        desbloqueado = true;
        usosRestantes = credito.limite - (credito.usos + 1);
        saldoRestante = credito.limite > 0
          ? Math.round((credito.valor_pago * usosRestantes / credito.limite) * 100) / 100
          : 0;
      } else {
        console.error('Erro Supabase (update crédito):', erroUpdateCredito);
      }
    }

    // ---- 7. Salvar o resultado COMPLETO no banco (preço/onde vender inclusive,
    //          mesmo quando gratuito — o "onde vender" só fica de fora da RESPOSTA) ----
    const { data: linhaSalva, error: erroInsert } = await supabase
      .from('identificacoes')
      .insert({
        email: email,
        nome_exibicao: nomeExibicao,
        whatsapp: whatsappExibicao,
        nome_provavel: resultadoIA.nome_provavel || null,
        confianca: resultadoIA.confianca || null,
        nomes_alternativos: resultadoIA.nomes_alternativos || [],
        caracteristicas: resultadoIA.caracteristicas || [],
        observacao: resultadoIA.observacao || null,
        faixa_preco_brasil: resultadoIA.faixa_preco_brasil || null,
        onde_vender: resultadoIA.onde_vender || null,
        foto_base64: fotos[0].base64,
        foto_media_type: fotos[0].mediaType,
        desbloqueada: desbloqueado,
        consumiu_credito_pago: desbloqueado,
        permite_vitrine: permiteVitrine
      })
      .select('*')
      .single();

    if (erroInsert || !linhaSalva) {
      console.error('Erro Supabase (insert identificacao):', erroInsert);
      // A chamada à Claude já foi cobrada mesmo sem conseguir salvar — registra.
      registrarCustoIA({ identificacaoId: null, email, usage: dataClaude.usage });
      return res.status(500).json({ error: 'Erro ao salvar o resultado. Tente novamente.' });
    }

    // ---- 7.1 Registrar custo da chamada (não bloqueia a resposta) ----
    registrarCustoIA({ identificacaoId: linhaSalva.id, email, usage: dataClaude.usage });

    // ---- 8. Montar resposta:
    //          - nome/confiança/alternativos/características/faixa de preço SEMPRE vão
    //          - "onde vender" só se desbloqueado (crédito pago)
    //          - quando gratuito, inclui quantas avaliações grátis ainda restam e o texto de upsell
    const resposta = {
      identificacao_id: linhaSalva.id,
      e_pedra_ou_mineral: true,
      nome_provavel: resultadoIA.nome_provavel,
      confianca: resultadoIA.confianca,
      nomes_alternativos: resultadoIA.nomes_alternativos,
      caracteristicas: resultadoIA.caracteristicas,
      observacao: resultadoIA.observacao,
      faixa_preco_brasil: resultadoIA.faixa_preco_brasil,
      desbloqueado: desbloqueado,
      onde_vender: desbloqueado ? resultadoIA.onde_vender : ''
    };

    if (desbloqueado) {
      resposta.usos_restantes = usosRestantes;
      resposta.saldo_restante = saldoRestante;
    } else {
      resposta.avaliacoes_gratis_restantes = Math.max(0, LIMITE_AVALIACOES_GRATIS - (avaliacoesGratisUsadas + 1));
      resposta.mensagem_upsell = MENSAGEM_UPSELL;
    }

    return res.status(200).json(resposta);

  } catch (err) {
    console.error('Erro inesperado:', err);
    return res.status(500).json({ error: 'Erro interno. Tente novamente em instantes.' });
  }
};
