// /api/webhook-cakto.js
// Webhook da Cakto para liberar créditos de avaliação de pedras
// Versão COMPLETA com validações, logs e segurança

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// CONFIGURAÇÃO DO PACOTE
const LIMITE_PADRAO = 10;          // 10 leituras por pacote
const VALOR_PADRAO = 13.99;        // R$ 13,99

module.exports = async function handler(req, res) {
  // 1. Aceita apenas POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const payload = req.body || {};

  // 2. Validar segredo (evita chamadas falsas)
  if (!payload.secret || payload.secret !== process.env.CAKTO_WEBHOOK_SECRET) {
    console.warn('❌ Webhook rejeitado: segredo inválido');
    return res.status(401).json({ error: 'Assinatura inválida' });
  }

  // 3. Só processar compras aprovadas e pagas
  if (payload.event !== 'purchase_approved') {
    return res.status(200).json({ ok: true, ignorado: true, motivo: 'evento ignorado' });
  }

  const data = payload.data || {};

  if (data.status !== 'paid') {
    return res.status(200).json({ ok: true, ignorado: true, motivo: 'status não pago' });
  }

  // 4. Filtrar pelo ID da oferta (se configurado)
  const offerIdEsperado = process.env.CAKTO_OFFER_ID;
  if (offerIdEsperado && data.offer && data.offer.id !== offerIdEsperado) {
    return res.status(200).json({ ok: true, ignorado: true, motivo: 'oferta não corresponde' });
  }

  // 5. Extrair e-mail do comprador
  const emailBruto = data.customer?.email;
  if (!emailBruto) {
    console.error('❌ Webhook: payload sem e-mail', JSON.stringify(data));
    return res.status(400).json({ error: 'Payload sem e-mail do comprador' });
  }
  const email = emailBruto.toLowerCase().trim();

  if (!data.id) {
    return res.status(400).json({ error: 'Payload sem ID do pedido' });
  }

  // 6. Extrair valor pago (se disponível)
  const valorPago = typeof data.amount === 'number' ? data.amount / 100 : VALOR_PADRAO;

  try {
    console.log(`📦 Processando compra para ${email}, pedido ${data.id}`);

    // 7. VERIFICAR se o e-mail já tem um pacote ativo (com saldo)
    const { data: creditoExistente, error: erroBusca } = await supabase
      .from('creditos_avaliacao')
      .select('usos, limite, status, valor_pago, order_id')
      .eq('email', email)
      .single();

    // 8. Se já tem um pacote ativo com saldo, NÃO sobrescreve
    //    (evita que a pessoa perca leituras não usadas ao comprar de novo)
    if (creditoExistente && creditoExistente.status === 'pago') {
      const saldoAtual = creditoExistente.limite - creditoExistente.usos;
      
      if (saldoAtual > 0) {
        console.log(`⚠️ ${email} já tem ${saldoAtual} leituras sobrando. Pacote NÃO substituído.`);
        return res.status(200).json({ 
          ok: true, 
          ignorado: true, 
          motivo: 'pacote já ativo com saldo',
          saldo_restante: saldoAtual
        });
      }

      // Se o pacote está zerado, podemos renovar (substituir)
      console.log(`🔄 ${email} zerou o pacote anterior. Renovando...`);
    }

    // 9. Calcular novo total de leituras (soma, se já tiver)
    //    Para evitar perda, SOMAMOS as leituras em vez de substituir
    //    (melhor experiência pro usuário)
    let usosInicial = 0;
    let limiteFinal = LIMITE_PADRAO;
    let valorFinal = VALOR_PADRAO;

    if (creditoExistente && creditoExistente.status === 'pago') {
      // Se já tem pacote, adiciona as novas leituras ao saldo existente
      const saldoAtual = creditoExistente.limite - creditoExistente.usos;
      limiteFinal = creditoExistente.limite + LIMITE_PADRAO;
      usosInicial = creditoExistente.usos;
      valorFinal = creditoExistente.valor_pago + VALOR_PADRAO;
      
      console.log(`➕ ${email} tinha ${saldoAtual} leituras. Somando +${LIMITE_PADRAO}. Total: ${limiteFinal - usosInicial}`);
    }

    // 10. Upsert com SOMA (não substituição)
    const { error: erroUpsert } = await supabase
      .from('creditos_avaliacao')
      .upsert(
        {
          email,
          order_id: data.id,
          status: 'pago',
          limite: limiteFinal,
          usos: usosInicial,
          valor_pago: valorFinal,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'email' }
      );

    if (erroUpsert) {
      console.error('❌ Erro Supabase (webhook upsert):', erroUpsert);
      return res.status(500).json({ error: 'Erro ao registrar crédito' });
    }

    console.log(`✅ Crédito liberado para ${email}: ${limiteFinal - usosInicial} leituras disponíveis`);
    return res.status(200).json({ 
      ok: true, 
      leituras_adicionadas: LIMITE_PADRAO,
      total_disponivel: limiteFinal - usosInicial
    });

  } catch (err) {
    console.error('❌ Erro inesperado no webhook:', err);
    return res.status(500).json({ error: 'Erro interno' });
  }
};