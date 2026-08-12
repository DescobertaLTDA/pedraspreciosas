// api/loja-foto.js
//
// Proxy de imagem: recebe a referência de foto (photos[].name) devolvida
// pela Places API (New) em /api/lojas-proximas e busca a imagem real no
// Google usando a GOOGLE_MAPS_API_KEY no servidor — assim a key nunca
// fica exposta no <img src="...">.
//
// Uso no front: <img src="/api/loja-foto?ref=NAME_URL_ENCODED">
//
// Env var necessária (mesma do lojas-proximas.js):
// - GOOGLE_MAPS_API_KEY

const LARGURA_MAX_PX = 400;

export default async function handler(req, res) {
  const ref = req.query && req.query.ref;
  if (!ref || typeof ref !== 'string') {
    res.status(400).json({ erro: 'parâmetro ref é obrigatório' });
    return;
  }

  // ref vem no formato "places/XXX/photos/YYY" — validação simples
  // pra evitar SSRF via query param arbitrário.
  if (!/^places\/[^/]+\/photos\/[^/]+$/.test(ref)) {
    res.status(400).json({ erro: 'ref inválida' });
    return;
  }

  try {
    const url = 'https://places.googleapis.com/v1/' + ref +
      '/media?maxWidthPx=' + LARGURA_MAX_PX + '&key=' + process.env.GOOGLE_MAPS_API_KEY;
    const resposta = await fetch(url);
    if (!resposta.ok) {
      res.status(404).json({ erro: 'Foto não encontrada' });
      return;
    }
    const buffer = Buffer.from(await resposta.arrayBuffer());
    const contentType = resposta.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 's-maxage=604800, stale-while-revalidate'); // 7 dias
    res.status(200).send(buffer);
  } catch (erro) {
    console.error('Erro ao buscar foto da loja:', erro);
    res.status(500).json({ erro: 'Não foi possível carregar a foto' });
  }
}
