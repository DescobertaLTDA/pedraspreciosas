// /api/historico.js
// Lista as identificações já feitas por essa conta (mais recentes primeiro),
// pra montar a tela de "Histórico". Não devolve foto nem preço aqui — isso
// só vem no /api/obter, quando a pessoa abre uma identificação específica.
// Evita respostas pesadas quando a lista tem várias fotos.

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

  const token = pegarToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Você precisa entrar na sua conta primeiro.' });
  }

  const { data: userData, error: erroAuth } = await supabase.auth.getUser(token);
  if (erroAuth || !userData || !userData.user || !userData.user.email) {
    return res.status(401).json({ error: 'Sessão inválida. Faça login novamente.' });
  }

  const email = userData.user.email.toLowerCase();

  const { data: linhas, error } = await supabase
    .from('identificacoes')
    .select('id, nome_provavel, confianca, desbloqueada, criado_em')
    .eq('email', email)
    .order('criado_em', { ascending: false })
    .limit(30);

  if (error) {
    console.error('Erro Supabase (historico):', error);
    return res.status(500).json({ error: 'Erro ao buscar seu histórico.' });
  }

  return res.status(200).json({ itens: linhas || [] });
};
