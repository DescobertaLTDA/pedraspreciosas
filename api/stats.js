// /api/stats.js
// Retorna estatísticas reais da comunidade:
// - Total de membros (usuários com avaliações públicas)
// - Total de pedras avaliadas (identificações públicas)
// - Avaliações feitas hoje
// Não requer autenticação - dados públicos

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function formatarNumero(num) {
  if (!num || num === 0) return '0';
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'k';
  }
  return num.toString();
}

module.exports = async function handler(req, res) {
  // Configuração CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  try {
    // 1. Total de membros (emails únicos com avaliações PÚBLICAS)
    const { count: totalMembros, error: errMembros } = await supabase
      .from('identificacoes')
      .select('email', { count: 'exact', head: true, distinct: true })
      .eq('publica', true);  // ← FILTRO ADICIONADO

    if (errMembros) {
      console.error('Erro ao buscar membros:', errMembros);
    }

    // 2. Total de pedras avaliadas (identificações públicas)
    const { count: totalPedras, error: errPedras } = await supabase
      .from('identificacoes')
      .select('id', { count: 'exact', head: true })
      .eq('publica', true);

    if (errPedras) {
      console.error('Erro ao buscar pedras:', errPedras);
    }

    // 3. Avaliações de hoje (apenas públicas)
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    const hojeISO = hoje.toISOString();

    const { count: avaliacoesHoje, error: errHoje } = await supabase
      .from('identificacoes')
      .select('id', { count: 'exact', head: true })
      .eq('publica', true)
      .gte('criado_em', hojeISO);

    if (errHoje) {
      console.error('Erro ao buscar avaliações de hoje:', errHoje);
    }

    // 4. Membros que avaliaram hoje (emails únicos com avaliações públicas hoje)
    const { count: membrosHoje, error: errMembrosHoje } = await supabase
      .from('identificacoes')
      .select('email', { count: 'exact', head: true, distinct: true })
      .eq('publica', true)
      .gte('criado_em', hojeISO);

    if (errMembrosHoje) {
      console.error('Erro ao buscar membros de hoje:', errMembrosHoje);
    }

    // 5. Total de avaliações (para referência)
    const { count: totalAvaliacoes, error: errTotal } = await supabase
      .from('identificacoes')
      .select('id', { count: 'exact', head: true });

    if (errTotal) {
      console.error('Erro ao buscar total de avaliações:', errTotal);
    }

    // Retorna os dados formatados
    return res.status(200).json({
      membros: formatarNumero(totalMembros || 0),
      membros_raw: totalMembros || 0,
      pedras: formatarNumero(totalPedras || 0),
      pedras_raw: totalPedras || 0,
      hoje: '+' + (avaliacoesHoje || 0),
      hoje_raw: avaliacoesHoje || 0,
      membros_hoje: membrosHoje || 0,
      total_avaliacoes: totalAvaliacoes || 0
    });

  } catch (error) {
    console.error('Erro ao buscar estatísticas:', error);
    
    // Fallback com dados estáticos caso algo dê errado
    return res.status(500).json({
      error: 'Erro ao buscar estatísticas da comunidade',
      membros: '0',
      pedras: '0',
      hoje: '+0',
      membros_raw: 0,
      pedras_raw: 0,
      hoje_raw: 0
    });
  }
};