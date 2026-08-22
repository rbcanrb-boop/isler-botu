/**
 * domainMonitor.js
 * ----------------------------------------------------------------
 * İşler Botu (Haydar) için domain erişim engeli takip modülü.
 *
 * Ne yapar:
 *  - Belirlenen domainleri her 15 dakikada bir kontrol eder.
 *  - check-host.net üzerinden GERÇEK Türkiye vantage node'larından
 *    HTTP erişim testi yapar (captcha yok, resmi/halka açık API).
 *  - Ek olarak domain'e Railway sunucusundan (TR dışı) doğrudan
 *    erişim testi yapar -> genel "site tamamen down mu" sinyali verir.
 *  - Best-effort olarak BTK/SGB resmi sorgu sayfasını da dener;
 *    captcha ile karşılaşırsa otomatik atlar, log'a "manuel kontrol
 *    gerekli" yazar (captcha çözme/atlatma YAPILMAZ - kasıtlı).
 *  - Önceki durumla kıyaslar, DURUM DEĞİŞTİYSE Telegram'a bildirim
 *    atar (her 15 dakikada spam atmaz, sadece değişimde).
 *
 * Kurulum:
 *   npm install node-cron
 *   (Node 18+ varsayılır - global fetch mevcut, node-fetch gerekmez)
 *
 * .env değişkenleri (mevcut İşler Botu .env dosyanıza ekleyin):
 *   TELEGRAM_BOT_TOKEN=...        (zaten mevcut olmalı)
 *   DOMAIN_MONITOR_CHAT_ID=...    (bildirimlerin gideceği chat/grup id)
 *
 * Mevcut bot dosyanıza (örn. index.js) entegrasyon:
 *
 *   const { startDomainMonitor } = require('./domainMonitor');
 *   startDomainMonitor(); // botu başlatırken bir kere çağırın
 *
 * Telegram komutları eklemek için index.js dosyanıza aşağıdaki
 * bot.onText bloklarını ekleyin (bu dosyanın altındaki örneklere bakın):
 *   /domainekle domain.com   -> takibe yeni domain ekler
 *   /domainsil domain.com    -> takipten domain çıkarır
 *   /domainler               -> takip edilen domainleri listeler
 *   /domainkontrol           -> anlık kontrol yapar, sonucu yazar
 * ----------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const dns = require('dns').promises;

// ------------------------- AYARLAR -------------------------

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.DOMAIN_MONITOR_CHAT_ID;

// Durum kaydını diskte tutuyoruz ki bot yeniden başlasa bile
// "az önce neydi" bilgisini kaybetmeyelim (Railway restart olursa
// ilk çalışmada sadece baseline kurulur, bildirim atılmaz).
const STATE_FILE = path.join(__dirname, 'data', 'domainStatus.json');

// Takip edilen domain listesi artık kodda sabit DEĞİL, diskte tutuluyor.
// /domainekle ve /domainsil komutlarıyla Telegram'dan değiştirilebilir.
const DOMAINS_FILE = path.join(__dirname, 'data', 'domains.json');

// İlk çalıştırmada domains.json yoksa bu varsayılan liste ile oluşturulur.
const VARSAYILAN_DOMAINLER = ['rekabet1182.com'];

// ------------------------- YARDIMCI FONKSİYONLAR -------------------------

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getDomains() {
  try {
    return JSON.parse(fs.readFileSync(DOMAINS_FILE, 'utf8'));
  } catch {
    saveDomains(VARSAYILAN_DOMAINLER);
    return VARSAYILAN_DOMAINLER;
  }
}

function saveDomains(domains) {
  fs.mkdirSync(path.dirname(DOMAINS_FILE), { recursive: true });
  fs.writeFileSync(DOMAINS_FILE, JSON.stringify(domains, null, 2));
}

function domainTemizle(ham) {
  return ham
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
}

function addDomain(ham) {
  const domain = domainTemizle(ham);
  const domains = getDomains();
  if (domains.includes(domain)) {
    return { basarili: false, mesaj: `${domain} zaten listede.` };
  }
  domains.push(domain);
  saveDomains(domains);
  return { basarili: true, mesaj: `${domain} takip listesine eklendi.` };
}

function removeDomain(ham) {
  const domain = domainTemizle(ham);
  const domains = getDomains();
  if (!domains.includes(domain)) {
    return { basarili: false, mesaj: `${domain} zaten listede değil.` };
  }
  saveDomains(domains.filter((d) => d !== domain));
  // İlgili durum kaydını da temizleyelim
  const state = loadState();
  delete state[domain];
  saveState(state);
  return { basarili: true, mesaj: `${domain} takip listesinden çıkarıldı.` };
}

async function sendTelegramAlert(text) {
  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    console.warn('[domainMonitor] TELEGRAM_BOT_TOKEN veya DOMAIN_MONITOR_CHAT_ID eksik, bildirim atılamadı.');
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: 'HTML',
      }),
    });
  } catch (err) {
    console.error('[domainMonitor] Telegram gönderim hatası:', err.message);
  }
}

// ------------------------- SAĞLAYICI 1: check-host.net (TR vantage) -------------------------
// Halka açık, captcha gerektirmez. İki adımlı: önce testi başlat, sonra sonucu çek.

async function getTurkishNodes() {
  const res = await fetch('https://check-host.net/nodes/hosts', {
    headers: { Accept: 'application/json' },
  });
  const data = await res.json();
  // data.nodes: { "node_id": { location: [...], country: [...], ... } }
  const nodeEntries = Object.entries(data.nodes || {});

  // TEŞHİS: ilk node'un ham yapısını logla, alan adlarını görelim
  if (nodeEntries.length > 0) {
    console.log('[domainMonitor][DEBUG] Örnek node verisi:', JSON.stringify(nodeEntries[0]));
    console.log('[domainMonitor][DEBUG] Toplam node sayısı:', nodeEntries.length);
  } else {
    console.log('[domainMonitor][DEBUG] nodes/hosts cevabı boş veya beklenmedik formatta:', JSON.stringify(data).slice(0, 300));
  }

  const trNodes = nodeEntries
    .filter(([, info]) => {
      const metin = JSON.stringify(info).toLowerCase();
      return metin.includes('turkey') || metin.includes('"tr"') || metin.includes(',tr,') || metin.includes('istanbul');
    })
    .map(([nodeId]) => nodeId);

  console.log('[domainMonitor][DEBUG] Bulunan TR node sayısı:', trNodes.length, trNodes.slice(0, 5));

  return trNodes;
}

async function checkViaCheckHost(domain) {
  try {
    const trNodes = await getTurkishNodes();
    const nodeParams = trNodes.slice(0, 3).map((n) => `node=${encodeURIComponent(n)}`).join('&');
    const initRes = await fetch(
      `https://check-host.net/check-http?host=https://${domain}&${nodeParams}`,
      { headers: { Accept: 'application/json' } }
    );
    const initData = await initRes.json();
    if (!initData.ok || !initData.request_id) {
      return { provider: 'check-host', status: 'BILINMIYOR', detail: 'İstek başlatılamadı' };
    }

    // check-host testleri asenkron çalışıyor, sonucun oluşması için kısa bekleme
    await new Promise((r) => setTimeout(r, 7000));

    const resultRes = await fetch(
      `https://check-host.net/check-result/${initData.request_id}`,
      { headers: { Accept: 'application/json' } }
    );
    const resultData = await resultRes.json();

    const results = Object.values(resultData || {});
    const basarili = results.filter((r) => Array.isArray(r) && r[0] && r[0][0] === 1).length;
    const toplam = results.length || 1;

    if (basarili === 0) {
      return { provider: 'check-host', status: 'ENGELLI_OLABILIR', detail: `TR node'larının ${toplam}/${toplam} tanesi ulaşamadı` };
    }
    if (basarili < toplam) {
      return { provider: 'check-host', status: 'KARISIK', detail: `${basarili}/${toplam} TR node ulaştı - kısmi engel olasılığı` };
    }
    return { provider: 'check-host', status: 'TEMIZ', detail: `${basarili}/${toplam} TR node başarıyla ulaştı` };
  } catch (err) {
    return { provider: 'check-host', status: 'HATA', detail: err.message };
  }
}

// ------------------------- SAĞLAYICI 2b: Türk ISS DNS sorgusu (asıl engel tespiti) -------------------------
// Türkiye'deki "idari tedbir" engelleri çoğunlukla DNS seviyesinde uygulanır:
// ISS'nin kendi DNS sunucusu, engelli domain sorulduğunda gerçek IP yerine
// bilinen bir "erişim engellendi" sayfa adresi döndürür. Bu yüzden bu kontrol,
// check-host'tan daha güvenilir bir sinyal verir.

const TURK_ISS_DNS = [
  { isim: 'Turk Telekom', ip: '195.175.39.39' },
  { isim: 'Superonline', ip: '78.35.53.53' },
  { isim: 'Vodafone', ip: '195.175.39.40' },
];

// Bilinen "erişim engellendi" yönlendirme adresleri (DNS sinkhole IP'leri).
// Bu liste zamanla değişebilir, kesin/eksiksiz değildir - sadece bilinen örnekler.
const BILINEN_ENGEL_IP_ONEKLERI = ['195.175.254.', '78.135.106.'];

async function tekIssDnsSorgula(domain, issAdi, dnsIp) {
  const resolver = new dns.Resolver();
  resolver.setServers([dnsIp]);
  try {
    const adresler = await Promise.race([
      resolver.resolve4(domain),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);
    const engelliMi = adresler.some((ip) => BILINEN_ENGEL_IP_ONEKLERI.some((onek) => ip.startsWith(onek)));
    return { isim: issAdi, sonuc: engelliMi ? 'ENGELLI' : 'TEMIZ', ip: adresler[0] };
  } catch (err) {
    // NXDOMAIN veya timeout da bazı ISS'lerde engel yöntemi olabilir
    return { isim: issAdi, sonuc: 'COZULEMEDI', ip: err.message };
  }
}

async function checkViaTurkIssDns(domain) {
  try {
    const sonuclar = await Promise.all(
      TURK_ISS_DNS.map((iss) => tekIssDnsSorgula(domain, iss.isim, iss.ip))
    );
    const engelliOlanlar = sonuclar.filter((s) => s.sonuc === 'ENGELLI');
    const detay = sonuclar.map((s) => `${s.isim}:${s.sonuc}`).join(', ');

    if (engelliOlanlar.length > 0) {
      return { provider: 'tr-isp-dns', status: 'ENGELLI', detail: `${engelliOlanlar.length}/${sonuclar.length} ISS'de DNS engeli tespit edildi (${detay})` };
    }
    return { provider: 'tr-isp-dns', status: 'TEMIZ', detail: detay };
  } catch (err) {
    return { provider: 'tr-isp-dns', status: 'HATA', detail: err.message };
  }
}



async function checkViaDirectFetch(domain) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`https://${domain}`, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      },
    });
    clearTimeout(timeout);
    const not = res.status === 403 ? ' (403 genelde bot-koruması anlamına gelir, resmi engel değil)' : '';
    return { provider: 'direct', status: res.ok ? 'ERISILEBILIR' : 'HATA_KODU', detail: `HTTP ${res.status}${not}` };
  } catch (err) {
    return { provider: 'direct', status: 'ERISILEMIYOR', detail: err.message };
  }
}

// ------------------------- SAĞLAYICI 3: BTK/SGB resmi sayfa (best-effort) -------------------------
// Captcha ile karşılaşırsa OTOMATIK ATLANIR - captcha çözme/atlatma yapılmaz.

async function checkViaResmiSayfa(domain) {
  try {
    const res = await fetch('https://internet.btk.gov.tr/sitesorgu/', { method: 'GET' });
    const html = await res.text();
    if (/captcha/i.test(html)) {
      return { provider: 'resmi-sayfa', status: 'MANUEL_KONTROL_GEREKLI', detail: 'Captcha tespit edildi, otomatik sorgu atlandı' };
    }
    return { provider: 'resmi-sayfa', status: 'BILINMIYOR', detail: 'Sayfa formatı değişmiş olabilir, kontrol edin' };
  } catch (err) {
    return { provider: 'resmi-sayfa', status: 'ERISILEMIYOR', detail: 'Resmi sayfaya (muhtemelen SGB geçişi nedeniyle) ulaşılamadı' };
  }
}

// ------------------------- ANA KONTROL MANTIĞI -------------------------

function ozetVerdictOlustur(sonuclar) {
  // ÖNCELİK 1: Türk ISS DNS kontrolü - gerçek kullanıcı deneyimine en yakın sinyal
  const issDns = sonuclar.find((s) => s.provider === 'tr-isp-dns');
  if (issDns?.status === 'ENGELLI') return 'ENGELLI_SUPHESI';

  // ÖNCELİK 2: check-host TR node testi - tamamlayıcı sinyal
  const ch = sonuclar.find((s) => s.provider === 'check-host');
  if (ch?.status === 'ENGELLI_OLABILIR') return 'ENGELLI_SUPHESI';
  if (ch?.status === 'KARISIK') return 'KISMI_ENGEL_SUPHESI';

  if (issDns?.status === 'TEMIZ' && ch?.status === 'TEMIZ') return 'TEMIZ';
  if (issDns?.status === 'TEMIZ' || ch?.status === 'TEMIZ') return 'TEMIZ';
  return 'BILINMIYOR';
}

async function checkDomain(domain) {
  const [chSonuc, issDnsSonuc, directSonuc, resmiSonuc] = await Promise.all([
    checkViaCheckHost(domain),
    checkViaTurkIssDns(domain),
    checkViaDirectFetch(domain),
    checkViaResmiSayfa(domain),
  ]);
  const sonuclar = [chSonuc, issDnsSonuc, directSonuc, resmiSonuc];
  const verdict = ozetVerdictOlustur(sonuclar);
  return { domain, verdict, sonuclar, timestamp: new Date().toISOString() };
}

function raporMetniOlustur(sonuc) {
  const emoji = {
    ENGELLI_SUPHESI: '🔴',
    KISMI_ENGEL_SUPHESI: '🟠',
    TEMIZ: '🟢',
    BILINMIYOR: '⚪',
  }[sonuc.verdict] || '⚪';

  let metin = `${emoji} <b>${sonuc.domain}</b> — ${sonuc.verdict}\n`;
  sonuc.sonuclar.forEach((s) => {
    metin += `  • ${s.provider}: ${s.status} (${s.detail})\n`;
  });
  return metin;
}

async function checkAllDomainsNow() {
  const state = loadState();
  const raporlar = [];
  let degisimVarMi = false;

  const domains = getDomains();
  if (domains.length === 0) {
    return 'Takip edilen domain yok. /domainekle domain.com ile ekleyebilirsiniz.';
  }

  for (const domain of domains) {
    const sonuc = await checkDomain(domain);
    raporlar.push(raporMetniOlustur(sonuc));

    const oncekiVerdict = state[domain]?.verdict;
    if (oncekiVerdict && oncekiVerdict !== sonuc.verdict) {
      degisimVarMi = true;
      await sendTelegramAlert(
        `⚠️ <b>DURUM DEĞİŞTİ: ${domain}</b>\n${oncekiVerdict} ➜ ${sonuc.verdict}\n\n${raporMetniOlustur(sonuc)}`
      );
    }
    state[domain] = { verdict: sonuc.verdict, timestamp: sonuc.timestamp };
  }

  saveState(state);
  return raporlar.join('\n') + (degisimVarMi ? '\n\n(Değişiklik bildirimi Telegram\'a gönderildi)' : '\n\n(Önceki duruma göre değişiklik yok)');
}

// ------------------------- ZAMANLAYICI -------------------------

function startDomainMonitor() {
  console.log('[domainMonitor] Başlatıldı - her 15 dakikada bir kontrol edilecek.');
  cron.schedule('*/15 * * * *', async () => {
    try {
      await checkAllDomainsNow();
    } catch (err) {
      console.error('[domainMonitor] Zamanlanmış kontrol hatası:', err.message);
    }
  });
}

module.exports = {
  startDomainMonitor,
  checkAllDomainsNow,
  checkDomain,
  getDomains,
  addDomain,
  removeDomain,
};
