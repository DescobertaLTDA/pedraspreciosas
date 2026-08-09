// /api/desbloquear.js
// Chamado depois que a pessoa já viu o resultado grátis (nome, características)
// e quer liberar preço + onde vender de UMA identificação específica que já
// rodou antes (salva na tabela identificacoes por /api/identificar).
// Não roda a IA de novo — só confere se há crédito pago disponível, consome 1
// e devolve os campos que estavam bloqueados.

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

function montarResposta(identificacao) {
  const desbloqueada = !!identificacao.desbloqueada;
  return {
    identificacao_id: identificacao.id,
    nome_provavel: identificacao.nome_provavel,
    confianca: identificacao.confianca,
    nomes_alternativos: identificacao.nomes_alternativos,
    caracteristicas: identificacao.caracteristicas,
    observacao: identificacao.observacao,
    desbloqueado: desbloqueada,
    faixa_preco_brasil: desbloqueada ? identificacao.faixa_preco_brasil : '',
    onde_vender: desbloqueada ? identificacao.onde_vender : ''
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const { identificacao_id } = req.body || {};
  if (!identificacao_id) {
    return res.status(400).json({ error: 'identificacao_id não enviado' });
  }

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
    // ---- 1. Buscar a identificação e confirmar que é dessa conta ----
    const { data: identificacao, error: erroIdent } = await supabase
      .from('identificacoes')
      .select('*')
      .eq('id', identificacao_id)
      .single();

    if (erroIdent || !identificacao) {
      return res.status(404).json({ error: 'Identificação não encontrada.' });
    }
    if (identificacao.email !== email) {
      return res.status(403).json({ error: 'Essa identificação não pertence a essa conta.' });
    }

    // ---- 2. Se já estava desbloqueada, só devolve (idempotente) ----
    if (identificacao.desbloqueada) {
      return res.status(200).json(montarResposta(identificacao));
    }

    // ---- 3. Checar crédito pago disponível ----
    const { data: credito, error: erroCredito } = await supabase
      .from('creditos_avaliacao')
      .select('*')
      .eq('email', email)
      .eq('status', 'pago')
      .single();

    if (erroCredito || !credito || credito.usos >= credito.limite) {
      return res.status(402).json({ error: 'Você ainda não pagou pela avaliação.', desbloqueado: false });
    }

    // ---- 4. Consumir 1 crédito e desbloquear essa identificação ----
    const { error: erroUpdateCredito } = await supabase
      .from('creditos_avaliacao')
      .update({ usos: credito.usos + 1 })
      .eq('email', email);

    if (erroUpdateCredito) {
      console.error('Erro Supabase (update crédito):', erroUpdateCredito);
      return res.status(500).json({ error: 'Erro ao liberar o resultado. Tente novamente.' });
    }

    const { data: identAtualizada, error: erroUpdateIdent } = await supabase
      .from('identificacoes')
      .update({ desbloqueada: true })
      .eq('id', identificacao_id)
      .select('*')
      .single();

    if (erroUpdateIdent) {
      console.error('Erro Supabase (update identificacao):', erroUpdateIdent);
    }

    const usosRestantes = credito.limite - (credito.usos + 1);
    const resposta = montarResposta(identAtualizada || { ...identificacao, desbloqueada: true });
    resposta.usos_restantes = usosRestantes;
    resposta.saldo_restante = credito.limite > 0
      ? Math.round((credito.valor_pago * usosRestantes / credito.limite) * 100) / 100
      : 0;

    return res.status(200).json(resposta);

  } catch (err) {
    console.error('Erro inesperado:', err);
    return res.status(500).json({ error: 'Erro interno. Tente novamente em instantes.' });
  }
};
