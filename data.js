// Vercel Serverless Function: /api/data?action=wallet|signals|prices
// Gerekli ortam değişkeni: HELIUS_API_KEY (Vercel > Settings > Environment Variables)

const WSOL = 'So11111111111111111111111111111111111111112';
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HELIUS = 'https://mainnet.helius-rpc.com/v0/addresses/';

async function history(addr, key, limit, before) {
  let url = `${HELIUS}${addr}/transactions?api-key=${key}&type=SWAP&limit=${limit}`;
  if (before) url += `&before=${before}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Helius hatası: ' + r.status);
  return r.json();
}

// Bir swap işleminden cüzdanın token ve SOL hareketini çıkarır
function parseSwap(tx, wallet) {
  const acc = (tx.accountData || []).find(a => a.account === wallet);
  const sol = (acc ? acc.nativeBalanceChange : 0) / 1e9;
  let tok = 0, mint = null;
  for (const t of tx.tokenTransfers || []) {
    if (t.mint === WSOL) continue;
    if (t.toUserAccount === wallet) { tok += Number(t.tokenAmount); mint = t.mint; }
    else if (t.fromUserAccount === wallet) { tok -= Number(t.tokenAmount); mint = t.mint; }
  }
  if (!mint || tok === 0) return null;
  return { mint, tok, sol, ts: tx.timestamp, sig: tx.signature };
}

// DexScreener: fiyat, likidite, coin yaşı (en eski çiftin oluşum zamanı)
async function tokenInfo(mints) {
  const out = {};
  const list = [...new Set(mints)].filter(m => B58.test(m));
  for (let i = 0; i < list.length; i += 30) {
    try {
      const r = await fetch('https://api.dexscreener.com/tokens/v1/solana/' + list.slice(i, i + 30).join(','));
      if (!r.ok) continue;
      const pairs = await r.json();
      for (const p of pairs || []) {
        const m = p.baseToken && p.baseToken.address;
        if (!m) continue;
        const liq = (p.liquidity && p.liquidity.usd) || 0;
        const o = out[m] || (out[m] = { symbol: p.baseToken.symbol, price: null, liq: -1, created: null });
        if (liq > o.liq) { o.liq = liq; o.price = p.priceUsd ? Number(p.priceUsd) : null; }
        if (p.pairCreatedAt && (!o.created || p.pairCreatedAt < o.created)) o.created = p.pairCreatedAt;
      }
    } catch (e) { /* veri yoksa devam */ }
  }
  return out;
}

async function analyzeWallet(addr, key) {
  let all = [], before;
  for (let p = 0; p < 2; p++) {
    const page = await history(addr, key, 100, before);
    all = all.concat(page);
    if (page.length < 100) break;
    before = page[page.length - 1].signature;
  }
  const per = {};
  for (const tx of all) {
    const e = parseSwap(tx, addr);
    if (!e) continue;
    const t = per[e.mint] || (per[e.mint] = { mint: e.mint, bought: 0, spent: 0, sold: 0, recv: 0, firstBuy: null });
    if (e.tok > 0 && e.sol < 0) {
      t.bought += e.tok; t.spent += -e.sol;
      if (!t.firstBuy || e.ts < t.firstBuy) t.firstBuy = e.ts;
    } else if (e.tok < 0 && e.sol > 0) {
      t.sold += -e.tok; t.recv += e.sol;
    }
  }
  const toks = Object.values(per).filter(t => t.bought > 0)
    .sort((a, b) => (b.firstBuy || 0) - (a.firstBuy || 0)).slice(0, 60);
  const info = await tokenInfo(toks.map(t => t.mint));
  let pnl = 0, closed = 0, wins = 0, posSum = 0, best = 0, snipers = 0, aged = 0;
  const rows = toks.map(t => {
    const i = info[t.mint] || {};
    const isClosed = t.sold > 0;
    const realized = isClosed ? t.recv - t.spent * Math.min(1, t.sold / t.bought) : 0;
    let age = null;
    if (i.created && t.firstBuy) age = Math.max(0, (t.firstBuy * 1000 - i.created) / 3.6e6);
    const sniper = age !== null && age * 3600 < 60;
    if (age !== null) { aged++; if (sniper) snipers++; }
    if (isClosed) {
      closed++; pnl += realized;
      if (realized > 0) { wins++; posSum += realized; best = Math.max(best, realized); }
    }
    return { mint: t.mint, symbol: i.symbol || '?', spent: t.spent, recv: t.recv, realized, closed: isClosed, ageH: age, sniper };
  });
  const winRate = closed ? wins / closed : 0;
  const bestShare = posSum > 0 ? best / posSum : 1;
  const sniperShare = aged ? snipers / aged : 0;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const score = Math.round(
    clamp(pnl * 3, 0, 35) + winRate * 25 + (posSum > 0 ? (1 - bestShare) * 20 : 0) +
    Math.min(10, closed) + (1 - sniperShare) * 10
  );
  return { address: addr, txCount: all.length,
    stats: { pnl, closed, winRate, bestShare, sniperShare, score }, tokens: rows.slice(0, 30) };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const key = process.env.HELIUS_API_KEY;
  if (!key) return res.status(500).json({ error: 'HELIUS_API_KEY tanımlı değil' });
  const { action, address, addresses, mints } = req.query;
  try {
    if (action === 'wallet') {
      if (!B58.test(address || '')) return res.status(400).json({ error: 'Geçersiz cüzdan adresi' });
      return res.json(await analyzeWallet(address, key));
    }
    if (action === 'signals') {
      const list = (addresses || '').split(',').filter(a => B58.test(a)).slice(0, 10);
      const results = await Promise.allSettled(list.map(a => history(a, key, 15)));
      const signals = [];
      results.forEach((r, idx) => {
        if (r.status !== 'fulfilled') return;
        for (const tx of r.value) {
          const e = parseSwap(tx, list[idx]);
          if (e && e.tok > 0 && e.sol < 0) signals.push({ wallet: list[idx], mint: e.mint, sig: e.sig, ts: e.ts, sol: -e.sol });
        }
      });
      return res.json({ signals });
    }
    if (action === 'prices') {
      const list = (mints || '').split(',').slice(0, 60);
      return res.json(await tokenInfo(list));
    }
    return res.status(400).json({ error: 'Bilinmeyen action' });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
