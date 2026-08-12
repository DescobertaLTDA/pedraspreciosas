// api/lojas-proximas.js
//
// Retorna lojas de pedras/minerais/joalherias perto de uma coordenada.
// Usa cache no Supabase (tabela lojas_cache) por célula de grade
// geográfica de ~11km, pra não chamar o Google Places toda vez que
// alguém abre a seção — só quando a célula está vazia ou o cache
// venceu (30 dias).
//
// Env vars necessárias na Vercel (Project Settings → Environment Variables):
// - GOOGLE_MAPS_API_KEY        → habilite "Places API (New)" no Google Cloud.
//                                 Como essa chamada é 100% server-side, restrinja
//                                 por IP (ou deixe sem restrição de app, já que
//                                 nunca é exposta ao navegador) — não precisa mais
//                                 da restrição por HTTP referrer.
// - SUPABASE_SERVICE_ROLE_KEY  → Supabase → Project Settings → API → service_role.
//                                 Necessária porque a tabela lojas_cache tem RLS
//                                 ativado sem policies públicas (só o backend acessa).

const SUPABASE_URL = 'https://lflqjmbygghuikwuoimd.supabase.co';
const TAMANHO_GRADE = 0.1; // ~11km por célula
const CACHE_TTL_DIAS = 30;
const RAIO_BUSCA_METROS = 20000;

function arredondarGrade(valor) {
  return Number((Math.round(valor / TAMANHO_GRADE) * TAMANHO_GRADE).toFixed(2));
}

async function buscarNoCache(gradeLat, gradeLng) {
  const url = SUPABASE_URL + '/rest/v1/lojas_cache?grid_lat=eq.' + gradeLat +
    '&grid_lng=eq.' + gradeLng + '&select=lugares,atualizado_em';
  const res = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY
    }
  });
  if (!res.ok) return null;
  const linhas = await res.json();
  if (!linhas || linhas.length === 0) return null;
  const registro = linhas[0];
  const idadeDias = (Date.now() - new Date(registro.atualizado_em).getTime()) / 86400000;
  if (idadeDias > CACHE_TTL_DIAS) return null;
  const lugares = registro.lugares;
  // Cache gravado antes do campo foto_ref existir — considera velho e refaz a busca.
  if (!lugares || lugares.length === 0 || !('foto_ref' in lugares[0])) return null;
  return lugares;
}

async function salvarNoCache(gradeLat, gradeLng, lugares) {
  const url = SUPABASE_URL + '/rest/v1/lojas_cache?on_conflict=grid_lat,grid_lng';
  await fetch(url, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates'
    },
    body: JSON.stringify([{
      grid_lat: gradeLat,
      grid_lng: gradeLng,
      lugares: lugares,
      atualizado_em: new Date().toISOString()
    }])
  });
}

async function buscarNoGooglePlaces(lat, lng) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.location,places.photos'
    },
    body: JSON.stringify({
      textQuery: 'loja de pedras e minerais joalheria gemologista',
      locationBias: {
        circle: { center: { latitude: lat, longitude: lng }, radius: RAIO_BUSCA_METROS }
      },
      maxResultCount: 10,
      languageCode: 'pt-BR'
    })
  });
  if (!res.ok) {
    const corpoErro = await res.text().catch(function() { return ''; });
    throw new Error('Places API respondeu ' + res.status + ': ' + corpoErro);
  }
  const data = await res.json();
  return (data.places || []).map(function(p) {
    var fotoRef = (p.photos && p.photos.length > 0) ? p.photos[0].name : null;
    return {
      place_id: p.id,
      nome: p.displayName && p.displayName.text,
      endereco: p.formattedAddress,
      rating: p.rating || null,
      total_avaliacoes: p.userRatingCount || null,
      lat: p.location && p.location.latitude,
      lng: p.location && p.location.longitude,
      foto_ref: fotoRef
    };
  }).slice(0, 6);
}

const LARGURA_MAX_FOTO_PX = 400;

async function servirFoto(req, res) {
  const ref = req.query && req.query.ref;
  if (!ref || typeof ref !== 'string') {
    res.status(400).json({ erro: 'parâmetro ref é obrigatório' });
    return;
  }
  // ref vem no formato "places/XXX/photos/YYY" — validação simples pra evitar SSRF.
  if (!/^places\/[^/]+\/photos\/[^/]+$/.test(ref)) {
    res.status(400).json({ erro: 'ref inválida' });
    return;
  }
  try {
    const url = 'https://places.googleapis.com/v1/' + ref +
      '/media?maxWidthPx=' + LARGURA_MAX_FOTO_PX + '&key=' + process.env.GOOGLE_MAPS_API_KEY;
    const resposta = await fetch(url);
    if (!resposta.ok) { res.status(404).json({ erro: 'Foto não encontrada' }); return; }
    const buffer = Buffer.from(await resposta.arrayBuffer());
    const contentType = resposta.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 's-maxage=604800, stale-while-revalidate');
    res.status(200).send(buffer);
  } catch (erro) {
    console.error('Erro ao buscar foto da loja:', erro);
    res.status(500).json({ erro: 'Não foi possível carregar a foto' });
  }
}

export default async function handler(req, res) {
  // GET /api/lojas-proximas?ref=places/XXX/photos/YYY → proxy de foto
  // (mesma função serverless faz as duas coisas pra não estourar o limite
  // de 12 funções do plano Hobby da Vercel)
  if (req.method === 'GET') { await servirFoto(req, res); return; }

  if (req.method !== 'POST') { res.status(405).json({ erro: 'Método não permitido' }); return; }

  const body = req.body || {};
  const lat = typeof body.lat === 'number' ? body.lat : parseFloat(body.lat);
  const lng = typeof body.lng === 'number' ? body.lng : parseFloat(body.lng);
  if (!isFinite(lat) || !isFinite(lng)) {
    res.status(400).json({ erro: 'lat e lng são obrigatórios e devem ser números' });
    return;
  }

  const gradeLat = arredondarGrade(lat);
  const gradeLng = arredondarGrade(lng);

  try {
    let lugares = await buscarNoCache(gradeLat, gradeLng);
    let origem = 'cache';
    if (!lugares) {
      lugares = await buscarNoGooglePlaces(lat, lng);
      origem = 'google';
      await salvarNoCache(gradeLat, gradeLng, lugares);
    }
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
    res.status(200).json({ lugares: lugares, origem: origem });
  } catch (erro) {
    console.error('Erro ao buscar lojas próximas:', erro);
    res.status(500).json({ erro: 'Não foi possível buscar lojas agora' });
  }
}
