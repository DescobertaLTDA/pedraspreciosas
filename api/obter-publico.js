// /api/obter-publico.js
// Busca dados públicos de uma identificação (sem autenticação)
// Usado para abrir o dossiê da vitrine

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const id = req.query.id;
  if (!id) {
    return res.status(400).json({ error: 'ID não informado' });
  }

  try {
    const { data, error } = await supabase
      .from('identificacoes')
      .select('id, nome_provavel, confianca, caracteristicas, faixa_preco_brasil, onde_vender, desbloqueada, observacao, criado_em')
      .eq('id', id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Identificação não encontrada' });
    }

    if (!data.desbloqueada) {
      data.onde_vender = null;
    }

    return res.status(200).json(data);

  } catch (error) {
    console.error('Erro ao buscar identificação pública:', error);
    return res.status(500).json({ error: 'Erro ao buscar dados' });
  }
};