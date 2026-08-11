// /api/stats.js
// Retorna estatísticas reais da comunidade
// - Total de membros (TODOS os usuários cadastrados no Supabase Auth)
// - Total de pedras avaliadas (identificações públicas)
// - Avaliações feitas hoje

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
    // ==========================================
    // 1. TOTAL DE MEMBROS (TODOS OS USUÁRIOS CADASTRADOS)
    // ==========================================
    let totalMembros = 0;
    
    try {
      // Tenta buscar da tabela auth.users
      const { count: totalUsuarios, error: errUsuarios } = await supabase
        .from('auth.users')
        .select('id', { count: 'exact', head: true });
      
      if (!errUsuarios && totalUsuarios > 0) {
        totalMembros = totalUsuarios;
        console.log('✅ Total de membros (auth.users):', totalMembros);
      } else {
        throw new Error('Não foi possível acessar auth.users');
      }
    } catch (err) {
      // Fallback: Busca emails únicos da tabela identificacoes
      console.log('⚠️ Fallback: contando emails únicos da tabela identificacoes');
      
      const { data: membrosData, error: errMembrosData } = await supabase
        .from('identificacoes')
        .select('email');

      if (!errMembrosData && membrosData) {
        const emailsUnicos = new Set();
        membrosData.forEach(row => {
          if (row.email) emailsUnicos.add(row.email.toLowerCase());
        });
        totalMembros = emailsUnicos.size;
      }

      if (errMembrosData) {
        console.error('Erro ao buscar membros (fallback):', errMembrosData);
      }
    }

    // ==========================================
    // 2. Total de pedras avaliadas (identificações públicas)
    // ==========================================
    const { count: totalPedras, error: errPedras } = await supabase
      .from('identificacoes')
      .select('id', { count: 'exact', head: true })
      .eq('publica', true);

    if (errPedras) {
      console.error('Erro ao buscar pedras:', errPedras);
    }

    // ==========================================
    // 3. Avaliações de hoje (apenas públicas)
    // ==========================================
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

    // ==========================================
    // 4. Membros que avaliaram hoje
    // ==========================================
    const { data: membrosHojeData, error: errMembrosHoje } = await supabase
      .from('identificacoes')
      .select('email')
      .eq('publica', true)
      .gte('criado_em', hojeISO);

    let membrosHoje = 0;
    if (!errMembrosHoje && membrosHojeData) {
      const emailsUnicosHoje = new Set();
      membrosHojeData.forEach(row => {
        if (row.email) emailsUnicosHoje.add(row.email.toLowerCase());
      });
      membrosHoje = emailsUnicosHoje.size;
    }

    // ==========================================
    // 5. Total de avaliações (todas, para referência)
    // ==========================================
    const { count: totalAvaliacoes, error: errTotal } = await supabase
      .from('identificacoes')
      .select('id', { count: 'exact', head: true });

    if (errTotal) {
      console.error('Erro ao buscar total de avaliações:', errTotal);
    }

    // ==========================================
    // Retorna os dados formatados
    // ==========================================
    return res.status(200).json({
      membros: formatarNumero(totalMembros || 0),
      membros_raw: totalMembros || 0,
      pedras: formatarNumero(totalPedras || 0),
      pedras_raw: totalPedras || 0,
      hoje: '+' + (avaliacoesHoje || 0),
      hoje_raw: avaliacoesHoje || 0,
      membros_hoje: membrosHoje || 0,
      total_avaliacoes: totalAvaliacoes || 0,
      // Dados de debug
      _debug: {
        total_membros_raw: totalMembros,
        total_pedras_raw: totalPedras,
        avaliacoes_hoje_raw: avaliacoesHoje,
        membros_hoje_raw: membrosHoje
      }
    });

  } catch (error) {
    console.error('Erro ao buscar estatísticas:', error);
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