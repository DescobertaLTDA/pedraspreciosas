// /api/status.js
// Substitui o antigo /api/reivindicar.js (cookie/FIFO).
// Chamado quando a página carrega e o usuário já está logado (sessão do Supabase Auth
// guardada no navegador). Diz se esse e-mail já pagou e quantos usos restam.
// Não consome nenhum uso — só consulta.

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
    return res.status(401).json({ error: 'Não autenticado' });
  }

  const { data: userData, error: erroAuth } = await supabase.auth.getUser(token);
  if (erroAuth || !userData || !userData.user || !userData.user.email) {
    return res.status(401).json({ error: 'Sessão inválida. Faça login novamente.' });
  }

  const email = userData.user.email.toLowerCase();

  const { data: registro, error: erroBusca } = await supabase
    .from('creditos_avaliacao')
    .select('status, usos, limite, valor_pago')
    .eq('email', email)
    .single();

  if (erroBusca || !registro || registro.status !== 'pago') {
    return res.status(200).json({ pago: false, email: email });
  }

  var usosRestantes = registro.limite - registro.usos;
  var saldo = registro.limite > 0
    ? Math.round((registro.valor_pago * usosRestantes / registro.limite) * 100) / 100
    : 0;

  return res.status(200).json({
    pago: true,
    email: email,
    usos: registro.usos,
    limite: registro.limite,
    saldo: saldo
  });
};
