// /api/obter.js
// Reabre uma identificação já feita antes — nome, características, faixa de
// preço e foto sempre vêm; "onde vender" só vem se já estiver desbloqueada.
// Não roda a IA de novo e não consome crédito nenhum: é só uma leitura do que
// já foi salvo. Usado tanto pela tela de histórico quanto para restaurar
// automaticamente a última avaliação quando a pessoa recarrega a página.

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

  const { data: identificacao, error } = await supabase
    .from('identificacoes')
    .select('*')
    .eq('id', identificacao_id)
    .single();

  if (error || !identificacao) {
    return res.status(404).json({ error: 'Identificação não encontrada.' });
  }
  if (identificacao.email !== email) {
    return res.status(403).json({ error: 'Essa identificação não pertence a essa conta.' });
  }

  const desbloqueada = !!identificacao.desbloqueada;

  return res.status(200).json({
    identificacao_id: identificacao.id,
    nome_provavel: identificacao.nome_provavel,
    confianca: identificacao.confianca,
    nomes_alternativos: identificacao.nomes_alternativos,
    caracteristicas: identificacao.caracteristicas,
    observacao: identificacao.observacao,
    desbloqueado: desbloqueada,
    faixa_preco_brasil: identificacao.faixa_preco_brasil,
    onde_vender: desbloqueada ? identificacao.onde_vender : '',
    foto_base64: identificacao.foto_base64,
    foto_media_type: identificacao.foto_media_type,
    criado_em: identificacao.criado_em
  });
};
