const TelegramBot = require('node-telegram-bot-api');
const { Client } = require('@notionhq/client');
const { Mistral } = require('@mistralai/mistralai');
const { tavily } = require('@tavily/core');

// =========================================
//   ENV DEĞİŞKENLERİ
// =========================================

const TOKEN = process.env.BOT_TOKEN;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.DATABASE_ID;
const ARSIV_DATABASE_ID = process.env.ARSIV_DATABASE_ID;
const TEKRAR_DATABASE_ID = process.env.TEKRAR_DATABASE_ID;
const SHIFT_DATABASE_ID = process.env.SHIFT_DATABASE_ID;
const CHAT_ID = process.env.CHAT_ID;
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

const bot = new TelegramBot(TOKEN, { polling: true });
const notion = new Client({ auth: NOTION_TOKEN });
const mistral = new Mistral({ apiKey: MISTRAL_API_KEY });
const tavilyClient = tavily({ apiKey: TAVILY_API_KEY });

// Kullanıcı durumları (komut akışı + Haydar sohbet geçmişi)
const kullaniciDurum = {};

// =========================================
//   SABİTLER
// =========================================

const SHIFT_SAATLERI = {
  'A': { baslangic: 9, bitis: 17 },
  'B': { baslangic: 14, bitis: 22 },
  'C': { baslangic: 20, bitis: 28 }
};

const IZIN_SHIFT_KARSILIGI = {
  'A': { shift: 'B', baslangic: 9, bitis: 17 },
  'B': { shift: 'C', baslangic: 17, bitis: 25 },
  'C': { shift: 'B', baslangic: 17, bitis: 25 }
};

const GUNLER = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];

// =========================================
//   YARDIMCI FONKSİYONLAR
// =========================================

function oncelikEmoji(oncelik) {
  if (!oncelik) return '⚪';
  const o = oncelik.toUpperCase();
  if (o.includes('KRIT')) return '🔴';
  if (o.includes('YÜKSEK') || o.includes('YUKSEK')) return '🟡';
  if (o.includes('NORMAL')) return '🟢';
  if (o.includes('BEKLEM')) return '🔵';
  return '⚪';
}

function tarihFormat(tarihStr) {
  if (!tarihStr) return '-';
  try {
    const d = new Date(tarihStr);
    const gun = String(d.getDate()).padStart(2, '0');
    const ay = String(d.getMonth() + 1).padStart(2, '0');
    const yil = d.getFullYear();
    const saat = String(d.getHours()).padStart(2, '0');
    const dakika = String(d.getMinutes()).padStart(2, '0');
    return `${gun}.${ay}.${yil} ${saat}:${dakika}`;
  } catch (e) { return tarihStr; }
}

function bugunTarih() {
  const d = trSimdi();
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function trSimdi() {
  return new Date(new Date().getTime() + 3 * 60 * 60 * 1000);
}

function haftaNumarasi(tarih = new Date()) {
  const d = new Date(Date.UTC(tarih.getFullYear(), tarih.getMonth(), tarih.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function gunAdi(tarih = new Date()) {
  return GUNLER[tarih.getDay()];
}

function notionMetinAl(prop) {
  if (!prop) return '-';
  if (prop.type === 'title' && prop.title) return prop.title.map(t => t.plain_text).join('') || '-';
  if (prop.type === 'rich_text' && prop.rich_text) return prop.rich_text.map(t => t.plain_text).join('') || '-';
  if (prop.type === 'select' && prop.select) return prop.select.name || '-';
  if (prop.type === 'date' && prop.date) return tarihFormat(prop.date.start);
  if (prop.type === 'checkbox') return prop.checkbox ? 'Evet' : 'Hayır';
  return '-';
}

function altMaddeleriParse(notlar) {
  if (!notlar || notlar === '-') return [];
  return notlar.split('\n')
    .filter(s => s.trim().startsWith('☐') || s.trim().startsWith('☑'))
    .map((s, i) => ({
      index: i,
      tamamlandi: s.trim().startsWith('☑'),
      metin: s.trim().replace(/^[☐☑]\s*/, '').trim()
    }));
}

function altMaddeleriYaz(maddeler) {
  return maddeler.map(m => `${m.tamamlandi ? '☑' : '☐'} ${m.metin}`).join('\n');
}

async function mesajGonder(chatId, metin, klavye) {
  const opts = { parse_mode: 'HTML' };
  if (klavye) opts.reply_markup = klavye;
  try {
    await bot.sendMessage(chatId, metin, opts);
  } catch (e) {
    console.error('Mesaj gönderme hatası:', e.message);
  }
}

// =========================================
//   RETRY YARDIMCISI
// =========================================

async function retryAsync(fn, denemeSayisi = 2, bekleme = 1000) {
  for (let i = 0; i < denemeSayisi; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === denemeSayisi - 1) throw e;
      await new Promise(r => setTimeout(r, bekleme));
    }
  }
}

// =========================================
//   NOTION FONKSİYONLARI
// =========================================

async function acikIsleriGetir(oncelikFiltre = null) {
  const filter = oncelikFiltre
    ? { and: [{ property: 'DURUM', select: { equals: 'AÇIK' } }, { property: 'ÖNCELİK', select: { equals: oncelikFiltre } }] }
    : { property: 'DURUM', select: { equals: 'AÇIK' } };
  return await retryAsync(() => notion.databases.query({ database_id: DATABASE_ID, filter }).then(r => r.results));
}

async function bitenIsleriGetir(tarihStr = null) {
  let hedefTarih;
  if (tarihStr) {
    const p = tarihStr.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (p) hedefTarih = `${p[3]}-${p[2].padStart(2, '0')}-${p[1].padStart(2, '0')}`;
  }
  if (!hedefTarih) {
    const tr = trSimdi();
    hedefTarih = `${tr.getFullYear()}-${String(tr.getMonth() + 1).padStart(2, '0')}-${String(tr.getDate()).padStart(2, '0')}`;
  }
  const baslangic = `${hedefTarih}T00:00:00.000+03:00`;
  const bitis = `${hedefTarih}T23:59:59.999+03:00`;
  return await retryAsync(() =>
    notion.databases.query({
      database_id: DATABASE_ID,
      filter: {
        and: [
          { property: 'DURUM', select: { equals: 'BİTTİ' } },
          { property: 'Tamamlanma Tarihi', date: { on_or_after: baslangic } },
          { property: 'Tamamlanma Tarihi', date: { on_or_before: bitis } }
        ]
      },
      sorts: [{ property: 'Tamamlanma Tarihi', direction: 'descending' }]
    }).then(r => r.results)
  );
}

async function yeniIsOlustur(isAdi, oncelik, sorumlu, deadline, altMaddeler) {
  const properties = {
    'İş Başlığı': { title: [{ text: { content: isAdi } }] },
    'DURUM': { select: { name: 'AÇIK' } },
    'ÖNCELİK': { select: { name: oncelik || 'NORMAL' } },
    'SORUMLU': { rich_text: [{ text: { content: sorumlu || '' } }] }
  };
  if (deadline && deadline.toLowerCase() !== 'yok') {
    const p = deadline.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})/);
    if (p) {
      properties['Deanline'] = { date: { start: `${p[3]}-${p[2].padStart(2, '0')}-${p[1].padStart(2, '0')}T${p[4].padStart(2, '0')}:${p[5]}:00` } };
    }
  }
  if (altMaddeler && altMaddeler.toLowerCase() !== 'yok') {
    const maddeler = altMaddeler.split(',').map(m => `☐ ${m.trim()}`).join('\n');
    properties['NOTLAR'] = { rich_text: [{ text: { content: maddeler } }] };
  }
  return await retryAsync(() => notion.pages.create({ parent: { database_id: DATABASE_ID }, properties }));
}

async function isGuncelle(pageId, properties) {
  return await retryAsync(() => notion.pages.update({ page_id: pageId, properties }));
}

async function isTamamla(pageId) {
  const trSu = trSimdi();
  return await retryAsync(() =>
    notion.pages.update({
      page_id: pageId,
      properties: {
        'DURUM': { select: { name: 'BİTTİ' } },
        'Tamamlanma Tarihi': { date: { start: trSu.toISOString() } }
      }
    })
  );
}

async function isArsivle(page) {
  const baslik = notionMetinAl(page.properties['İş Başlığı']);
  const oncelik = notionMetinAl(page.properties['ÖNCELİK']);
  const sorumlu = notionMetinAl(page.properties['SORUMLU']);
  const tamamlanmaTarihi = page.properties['Tamamlanma Tarihi']?.date?.start || new Date().toISOString();
  await retryAsync(() =>
    notion.pages.create({
      parent: { database_id: ARSIV_DATABASE_ID },
      properties: {
        'İş Başlığı': { title: [{ text: { content: baslik } }] },
        'DURUM': { select: { name: 'BİTTİ' } },
        'ÖNCELİK': { select: { name: oncelik === '-' ? 'NORMAL' : oncelik } },
        'SORUMLU': { rich_text: [{ text: { content: sorumlu === '-' ? '' : sorumlu } }] },
        'Arşivlenme Tarihi': { date: { start: new Date().toISOString() } },
        'Tamamlanma Tarihi': { date: { start: tamamlanmaTarihi } }
      }
    })
  );
  await retryAsync(() => notion.pages.update({ page_id: page.id, archived: true }));
}

async function bitenIsBildirimiGonder(pageId) {
  try {
    const page = await retryAsync(() => notion.pages.retrieve({ page_id: pageId }));
    const baslik = notionMetinAl(page.properties['İş Başlığı']);
    const sorumlu = notionMetinAl(page.properties['SORUMLU']);
    const oncelik = notionMetinAl(page.properties['ÖNCELİK']);
    await bot.sendMessage(CHAT_ID, `✅ <b>İŞ TAMAMLANDI</b>\n━━━━━━━━━━━━━━━\n\n${oncelikEmoji(oncelik)} <b>${baslik}</b>\n👤 ${sorumlu}\n\nTebrikler! 🎉`, { parse_mode: 'HTML' });
  } catch (e) { console.error('Biten iş bildirimi hatası:', e.message); }
}

// =========================================
//   SHIFT FONKSİYONLARI
// =========================================

async function buHaftanınShiftiniGetir() {
  try {
    const response = await retryAsync(() =>
      notion.databases.query({
        database_id: SHIFT_DATABASE_ID,
        filter: { property: 'Hafta', title: { equals: haftaNumarasi() } }
      })
    );
    return response.results.length > 0 ? response.results[0] : null;
  } catch (e) { return null; }
}

function shiftBilgisiniParse(metin) {
  const kisiler = {}, izinler = {};
  const shiftRegex = /([ABC])\s*shifti\s+(\w+)/gi;
  let match;
  while ((match = shiftRegex.exec(metin)) !== null) kisiler[match[2]] = match[1].toUpperCase();
  const izinRegex = /(\w+)\s+(Pazartesi|Salı|Çarşamba|Perşembe|Cuma|Cumartesi|Pazar)\s+izin/gi;
  while ((match = izinRegex.exec(metin)) !== null) izinler[match[1]] = match[2];
  return { kisiler, izinler };
}

function suAnMesaideKimVar(shiftData, saat = null) {
  if (!shiftData) return [];
  const props = shiftData.properties;
  const tr = trSimdi();
  const bugunGun = gunAdi(tr);
  const simdi = saat !== null ? saat : tr.getUTCHours() + tr.getUTCMinutes() / 60;
  const kisiler = [
    { ad: 'Can', shiftProp: 'Can_Shift', izinProp: 'Can_Izin' },
    { ad: 'Deaven', shiftProp: 'Deaven_Shift', izinProp: 'Deaven_Izin' },
    { ad: 'BL', shiftProp: 'BL_Shift', izinProp: 'BL_Izin' }
  ];
  const mesaideOlanlar = [];
  for (const kisi of kisiler) {
    const shiftHarfi = notionMetinAl(props[kisi.shiftProp]);
    const izinGunu = notionMetinAl(props[kisi.izinProp]);
    if (shiftHarfi === '-') continue;
    if (izinGunu !== '-' && izinGunu === bugunGun) continue;
    let baslangic = SHIFT_SAATLERI[shiftHarfi]?.baslangic;
    let bitis = SHIFT_SAATLERI[shiftHarfi]?.bitis;
    for (const dk of kisiler) {
      if (dk.ad === kisi.ad) continue;
      const ds = notionMetinAl(props[dk.shiftProp]);
      const di = notionMetinAl(props[dk.izinProp]);
      if (di !== '-' && di === bugunGun) {
        const k = IZIN_SHIFT_KARSILIGI[ds];
        if (k && k.shift === shiftHarfi) { baslangic = k.baslangic; bitis = k.bitis; }
      }
    }
    if (baslangic === undefined || bitis === undefined) continue;
    const ns = simdi < 5 ? simdi + 24 : simdi;
    if (ns >= baslangic && ns < bitis) mesaideOlanlar.push(kisi.ad);
  }
  return mesaideOlanlar;
}

async function shiftKaydet(metin, chatId) {
  const { kisiler, izinler } = shiftBilgisiniParse(metin);
  if (Object.keys(kisiler).length === 0) {
    await mesajGonder(chatId, '❌ Shift bilgisi anlaşılamadı. Format: "C shifti BL B shifti Can A shifti Deaven BL Çarşamba izin"');
    return;
  }
  const hafta = haftaNumarasi();
  const mevcut = await buHaftanınShiftiniGetir();
  const properties = {
    'Hafta': { title: [{ text: { content: hafta } }] },
    'Can_Shift': { rich_text: [{ text: { content: kisiler['Can'] || '' } }] },
    'Can_Izin': { rich_text: [{ text: { content: izinler['Can'] || '' } }] },
    'Deaven_Shift': { rich_text: [{ text: { content: kisiler['Deaven'] || '' } }] },
    'Deaven_Izin': { rich_text: [{ text: { content: izinler['Deaven'] || '' } }] },
    'BL_Shift': { rich_text: [{ text: { content: kisiler['BL'] || '' } }] },
    'BL_Izin': { rich_text: [{ text: { content: izinler['BL'] || '' } }] }
  };
  if (mevcut) await retryAsync(() => notion.pages.update({ page_id: mevcut.id, properties }));
  else await retryAsync(() => notion.pages.create({ parent: { database_id: SHIFT_DATABASE_ID }, properties }));

  const shiftMetin = Object.entries(kisiler).map(([kisi, shift]) => {
    const saatler = SHIFT_SAATLERI[shift];
    const izin = izinler[kisi] ? ` (İzin: ${izinler[kisi]})` : '';
    const bas = String(saatler?.baslangic || 0).padStart(2, '0') + ':00';
    const bit = saatler?.bitis || 0;
    const bitStr = String(bit > 24 ? bit - 24 : bit).padStart(2, '0') + ':00';
    return `👤 ${kisi} → ${shift} Shifti (${bas}-${bitStr})${izin}`;
  }).join('\n');
  await mesajGonder(chatId, `✅ <b>${hafta} Shift Kaydedildi</b>\n━━━━━━━━━━━━━━━\n\n${shiftMetin}`);
}

// =========================================
//   TEKRAR EDEN İŞLER
// =========================================

async function tekrarEdenIsleriGetir() {
  try {
    return await retryAsync(() => notion.databases.query({ database_id: TEKRAR_DATABASE_ID }).then(r => r.results));
  } catch (e) { return []; }
}

function tekrarTetiklenmelimi(is, simdi = new Date()) {
  const tr = new Date(simdi.getTime() + 3 * 60 * 60 * 1000);
  const tip = notionMetinAl(is.properties['TEKRAR_TİPİ']);
  const gun = notionMetinAl(is.properties['TEKRAR_GÜNÜ']);
  const saatStr = notionMetinAl(is.properties['TEKRAR_SAATİ']);
  const sonTetikleme = is.properties['SON_TETIKLEME']?.date?.start;
  if (!saatStr || saatStr === '-') return false;
  const [hs, ds] = saatStr.split(':').map(Number);
  const hedef = hs * 60 + ds;
  const simdiki = tr.getUTCHours() * 60 + tr.getUTCMinutes();
  if (Math.abs(hedef - simdiki) > 2) return false;
  if (sonTetikleme && (simdi - new Date(sonTetikleme)) / 60000 < 60) return false;
  const bugunGunAdi = gunAdi(tr);
  const bugunGunNo = tr.getUTCDate();
  if (tip === 'Günlük') return true;
  if (tip === 'Haftalık') return gun === bugunGunAdi;
  if (tip === 'Aylık') return String(bugunGunNo) === String(gun);
  return false;
}

async function tekrarEdenIsleriKontrolEt() {
  const isler = await tekrarEdenIsleriGetir();
  const shiftData = await buHaftanınShiftiniGetir();
  const simdi = new Date();
  for (const is of isler) {
    if (!tekrarTetiklenmelimi(is, simdi)) continue;
    const baslik = notionMetinAl(is.properties['İş Başlığı']);
    const oncelik = notionMetinAl(is.properties['ÖNCELİK']);
    const altMaddeler = notionMetinAl(is.properties['ALT_MADDELER']);
    const mesaideOlanlar = suAnMesaideKimVar(shiftData);
    const sorumlu = mesaideOlanlar.length > 0 ? mesaideOlanlar.join(', ') : 'Belirsiz';
    try {
      const not = `Otomatik açıldı, Kim yaptı: ${sorumlu}`;
      const altM = altMaddeler !== '-' ? altMaddeler + ',' + not : not;
      await yeniIsOlustur(baslik, oncelik === '-' ? 'NORMAL' : oncelik, sorumlu, 'yok', altM);
      await retryAsync(() => notion.pages.update({ page_id: is.id, properties: { 'SON_TETIKLEME': { date: { start: simdi.toISOString() } } } }));
      await bot.sendMessage(CHAT_ID, `🔁 <b>TEKRAR EDEN İŞ AÇILDI</b>\n━━━━━━━━━━━━━━━\n\n${oncelikEmoji(oncelik)} <b>${baslik}</b>\n👤 ${sorumlu}`, { parse_mode: 'HTML' });
    } catch (e) { console.error('Tekrar eden iş hatası:', e.message); }
  }
}

async function tekrarEdenIsEkle(chatId, durum, metin) {
  if (durum.adim === 'tekrar_isim') {
    durum.isAdi = metin; durum.adim = 'tekrar_oncelik';
    await mesajGonder(chatId, `✅ İş adı: <b>${metin}</b>\n\n<b>2/5 — Öncelik?</b>`, {
      keyboard: [[{ text: '🔴 KRİTİK' }, { text: '🟡 YÜKSEK' }], [{ text: '🟢 NORMAL' }, { text: '🔵 BEKLEMEDE' }]],
      one_time_keyboard: true, resize_keyboard: true
    });
  } else if (durum.adim === 'tekrar_oncelik') {
    durum.oncelik = metin.replace(/^[🔴🟡🟢🔵]\s*/, '');
    durum.adim = 'tekrar_tip';
    await mesajGonder(chatId, `✅ Öncelik: <b>${durum.oncelik}</b>\n\n<b>3/5 — Tekrar tipi?</b>`, {
      keyboard: [[{ text: 'Günlük' }, { text: 'Haftalık' }], [{ text: 'Aylık' }]],
      one_time_keyboard: true, resize_keyboard: true
    });
  } else if (durum.adim === 'tekrar_tip') {
    durum.tekrarTip = metin;
    if (metin === 'Günlük') {
      durum.tekrarGun = 'Her Gün'; durum.adim = 'tekrar_saat';
      await mesajGonder(chatId, `✅ Tip: <b>Günlük</b>\n\n<b>4/5 — Saat? (örn: 09:00)</b>`, { remove_keyboard: true });
    } else if (metin === 'Haftalık') {
      durum.adim = 'tekrar_gun';
      await mesajGonder(chatId, `✅ Tip: <b>Haftalık</b>\n\n<b>4/5 — Hangi gün?</b>`, {
        keyboard: [[{ text: 'Pazartesi' }, { text: 'Salı' }, { text: 'Çarşamba' }], [{ text: 'Perşembe' }, { text: 'Cuma' }, { text: 'Cumartesi' }], [{ text: 'Pazar' }]],
        one_time_keyboard: true, resize_keyboard: true
      });
    } else if (metin === 'Aylık') {
      durum.adim = 'tekrar_gun';
      await mesajGonder(chatId, `✅ Tip: <b>Aylık</b>\n\n<b>4/5 — Ayın kaçında? (örn: 1, 15)</b>`, { remove_keyboard: true });
    }
  } else if (durum.adim === 'tekrar_gun') {
    durum.tekrarGun = metin; durum.adim = 'tekrar_saat';
    await mesajGonder(chatId, `✅ Gün: <b>${metin}</b>\n\n<b>5/5 — Saat? (örn: 09:00)</b>`, { remove_keyboard: true });
  } else if (durum.adim === 'tekrar_saat') {
    durum.tekrarSaat = metin; durum.adim = 'tekrar_altmaddeler';
    await mesajGonder(chatId, `✅ Saat: <b>${metin}</b>\n\n<b>Alt maddeler? (virgülle yaz veya "yok")</b>`);
  } else if (durum.adim === 'tekrar_altmaddeler') {
    durum.altMaddeler = metin;
    delete kullaniciDurum[chatId];
    try {
      const properties = {
        'İş Başlığı': { title: [{ text: { content: durum.isAdi } }] },
        'ÖNCELİK': { select: { name: durum.oncelik } },
        'TEKRAR_TİPİ': { select: { name: durum.tekrarTip } },
        'TEKRAR_GÜNÜ': { rich_text: [{ text: { content: durum.tekrarGun || 'Her Gün' } }] },
        'TEKRAR_SAATİ': { rich_text: [{ text: { content: durum.tekrarSaat } }] }
      };
      if (durum.altMaddeler && durum.altMaddeler.toLowerCase() !== 'yok') {
        properties['ALT_MADDELER'] = { rich_text: [{ text: { content: durum.altMaddeler } }] };
      }
      await retryAsync(() => notion.pages.create({ parent: { database_id: TEKRAR_DATABASE_ID }, properties }));
      await mesajGonder(chatId, `✅ <b>TEKRAR EDEN İŞ KAYDEDİLDİ</b>\n━━━━━━━━━━━━━━━\n\n${oncelikEmoji(durum.oncelik)} <b>${durum.isAdi}</b>\n🔁 ${durum.tekrarTip} — ${durum.tekrarGun || 'Her Gün'} ${durum.tekrarSaat}`);
    } catch (e) { await mesajGonder(chatId, '❌ Hata: ' + e.message); }
  }
}

// =========================================
//   OTOMATİK BİLDİRİMLER
// =========================================

async function kritikIsleriiBildir() {
  try {
    const isler = await acikIsleriGetir('KRİTİK');
    if (isler.length === 0) return;
    let metin = `🔴 <b>KRİTİK AÇIK İŞLER (${isler.length})</b>\n━━━━━━━━━━━━━━━\n\n`;
    for (const is of isler) {
      metin += `🔴 <b>${notionMetinAl(is.properties['İş Başlığı'])}</b>\n👤 ${notionMetinAl(is.properties['SORUMLU'])}\n⏰ ${notionMetinAl(is.properties['Deanline'])}\n\n`;
    }
    await bot.sendMessage(CHAT_ID, metin, { parse_mode: 'HTML' });
  } catch (e) { console.error('Kritik bildirim hatası:', e.message); }
}

async function yuksekIsleriiBildir() {
  try {
    const isler = await acikIsleriGetir('YÜKSEK');
    if (isler.length === 0) return;
    let metin = `🟡 <b>YÜKSEK ÖNCELİKLİ AÇIK İŞLER (${isler.length})</b>\n━━━━━━━━━━━━━━━\n\n`;
    for (const is of isler) {
      metin += `🟡 <b>${notionMetinAl(is.properties['İş Başlığı'])}</b>\n👤 ${notionMetinAl(is.properties['SORUMLU'])}\n⏰ ${notionMetinAl(is.properties['Deanline'])}\n\n`;
    }
    await bot.sendMessage(CHAT_ID, metin, { parse_mode: 'HTML' });
  } catch (e) { console.error('Yüksek bildirim hatası:', e.message); }
}

// =========================================
//   HAYDAR AI — VERİ ÇEKME
// =========================================

async function tumVeriCek() {
  const [acikIsler, tekrarIsler, shiftData, bitenIsler] = await Promise.all([
    acikIsleriGetir().catch(() => []),
    tekrarEdenIsleriGetir().catch(() => []),
    buHaftanınShiftiniGetir().catch(() => null),
    bitenIsleriGetir().catch(() => [])
  ]);

  const mesaideOlanlar = suAnMesaideKimVar(shiftData);
  const tr = trSimdi();
  const saatStr = `${String(tr.getUTCHours()).padStart(2, '0')}:${String(tr.getUTCMinutes()).padStart(2, '0')}`;

  let context = `=== GÜNCEL DURUM ===\n`;
  context += `Tarih: ${bugunTarih()}, Saat: ${saatStr}, Gün: ${gunAdi(tr)}\n`;
  context += `Şu an mesaide: ${mesaideOlanlar.length > 0 ? mesaideOlanlar.join(', ') : 'Belirsiz'}\n\n`;

  context += `=== AÇIK İŞLER (${acikIsler.length}) ===\n`;
  if (acikIsler.length === 0) {
    context += 'Açık iş yok.\n';
  } else {
    acikIsler.forEach((is, i) => {
      const baslik = notionMetinAl(is.properties['İş Başlığı']);
      const oncelik = notionMetinAl(is.properties['ÖNCELİK']);
      const sorumlu = notionMetinAl(is.properties['SORUMLU']);
      const deadline = notionMetinAl(is.properties['Deanline']);
      const maddeler = altMaddeleriParse(notionMetinAl(is.properties['NOTLAR']));
      const maddeInfo = maddeler.length > 0 ? ` [${maddeler.filter(m => m.tamamlandi).length}/${maddeler.length} madde]` : '';
      context += `${i + 1}. [${oncelik}] ${baslik}${maddeInfo} | Sorumlu: ${sorumlu} | Deadline: ${deadline}\n`;
    });
  }

  context += `\n=== BUGÜN BİTEN İŞLER (${bitenIsler.length}) ===\n`;
  if (bitenIsler.length === 0) {
    context += 'Bugün biten iş yok.\n';
  } else {
    bitenIsler.forEach((is, i) => {
      const baslik = notionMetinAl(is.properties['İş Başlığı']);
      const sorumlu = notionMetinAl(is.properties['SORUMLU']);
      const tamamlanma = notionMetinAl(is.properties['Tamamlanma Tarihi']);
      context += `${i + 1}. ${baslik} | Sorumlu: ${sorumlu} | Tamamlanma: ${tamamlanma}\n`;
    });
  }

  context += `\n=== TEKRAR EDEN İŞLER (${tekrarIsler.length}) ===\n`;
  if (tekrarIsler.length === 0) {
    context += 'Tekrar eden iş yok.\n';
  } else {
    tekrarIsler.forEach((is, i) => {
      const baslik = notionMetinAl(is.properties['İş Başlığı']);
      const tip = notionMetinAl(is.properties['TEKRAR_TİPİ']);
      const gun = notionMetinAl(is.properties['TEKRAR_GÜNÜ']);
      const saat = notionMetinAl(is.properties['TEKRAR_SAATİ']);
      context += `${i + 1}. ${baslik} | ${tip} ${gun !== 'Her Gün' ? gun : ''} ${saat}\n`;
    });
  }

  if (shiftData) {
    const props = shiftData.properties;
    context += `\n=== BU HAFTA SHİFT (${haftaNumarasi()}) ===\n`;
    for (const kisi of ['Can', 'Deaven', 'BL']) {
      const shift = notionMetinAl(props[`${kisi}_Shift`]);
      const izin = notionMetinAl(props[`${kisi}_Izin`]);
      if (shift !== '-') {
        context += `${kisi}: ${shift} Shifti${izin !== '-' ? ` (İzin: ${izin})` : ''}\n`;
      }
    }
  }

  return { context, acikIsler, bitenIsler, tekrarIsler };
}

// =========================================
//   HAYDAR AI — HAFIZA SIKISTIRMA
// =========================================

async function gecmisiSikistir(gecmis) {
  if (gecmis.length <= 20) return gecmis;
  // Son 6 mesajı koru, gerisini özetle
  const ozetlen = gecmis.slice(0, -6);
  const korununlar = gecmis.slice(-6);
  try {
    const ozet = await mistral.chat.complete({
      model: 'mistral-large-latest',
      messages: [
        {
          role: 'system',
          content: 'Aşağıdaki konuşma geçmişini 3-4 cümleyle Türkçe özetle. Yapılan işlemleri, kararları ve önemli bilgileri kaybet.'
        },
        {
          role: 'user',
          content: ozetlen.map(m => `${m.role === 'user' ? 'Kullanıcı' : 'Haydar'}: ${m.content}`).join('\n')
        }
      ],
      maxTokens: 300
    });
    const ozetMetin = ozet.choices[0].message.content.trim();
    return [
      { role: 'user', content: `[Önceki konuşma özeti: ${ozetMetin}]` },
      { role: 'assistant', content: 'Anladım, devam edelim.' },
      ...korununlar
    ];
  } catch (e) {
    // Özetleme başarısız olursa sadece son 10'u al
    return gecmis.slice(-10);
  }
}

// =========================================
//   HAYDAR AI — WEB ARAMA
// =========================================

async function webArama(sorgu, derinlik = 'basic') {
  try {
    const result = await tavilyClient.search(sorgu, {
      searchDepth: derinlik,
      maxResults: 4,
      includeAnswer: true,
      includeRawContent: false
    });
    let bilgi = '';
    if (result.answer) bilgi += `Özet: ${result.answer}\n\n`;
    if (result.results && result.results.length > 0) {
      bilgi += 'Kaynaklar:\n';
      result.results.forEach((r, i) => {
        bilgi += `${i + 1}. ${r.title}\n${r.content?.slice(0, 400) || ''}\nURL: ${r.url}\n\n`;
      });
    }
    return bilgi || 'Sonuç bulunamadı.';
  } catch (e) {
    return `Arama hatası: ${e.message}`;
  }
}

// =========================================
//   HAYDAR AI — DÜŞÜNME MOTORU
// =========================================

async function haydarDusun(mesajlar, context, acikIsler) {
  const acikIsListesi = acikIsler.map((is, i) => {
    return `${i + 1}. ${notionMetinAl(is.properties['İş Başlığı'])} [${notionMetinAl(is.properties['ÖNCELİK'])}] - ${notionMetinAl(is.properties['SORUMLU'])}`;
  }).join('\n');

  const tr = trSimdi();

  const sistemPrompt = `Sen Haydar'sın. Bir ekibin iş takip Telegram botunun yapay zeka asistanısın. Ekibin bir parçasısın, yabancı değilsin.

KİŞİLİĞİN:
- Samimi ve sıcaksın, ekiple abi-kardeş ilişkin var
- Türkçe konuşursun, doğal argo kullanabilirsin (abi, kanka, aga, vb.)
- Kısa ve net cevap verirsin — gereksiz uzatmazsın, madde madde sıralamak yerine akıcı yazarsın
- Her şeyi yapabilirsin, "yapamam" demezsin
- Eğer bir şey bilmiyorsan web'de ararsın, kafadan uydurmassın
- Gerekmedikçe soru sormadan direkt aksiyona geçersin

YETKİLERİN:
- Açık işleri listelemek ve analiz etmek
- Bugün veya belirli tarihteki biten işleri görmek
- Yeni iş açmak
- İş tamamlamak
- İptal/silmek
- Shift bilgisini görmek
- Tekrar eden işleri listelemek
- Arşivleme
- İnternette arama (döviz, haber, hava durumu, güncel bilgi, herhangi bir konu)

GÜNCEL DURUM:
${context}
Şu anki gün ve saat: ${gunAdi(tr)}, ${String(tr.getUTCHours()).padStart(2, '0')}:${String(tr.getUTCMinutes()).padStart(2, '0')}

AÇIK İŞLERİN NUMARALI LİSTESİ:
${acikIsListesi || 'Açık iş yok'}

KARAR KURALLARI:
- Güncel, değişken veya bilmediğin bilgiler (döviz, haber, hava durumu, spor, fiyat vb.) için WEB_ARA kullan
- Aynı konuda birden fazla şey sorulursa tek seferde birden fazla WEB_ARA yapabilirsin (aksiyon: "WEB_ARA_COKLU")
- İş sorularında Notion verisini kullan, web aramana gerek yok
- Kullanıcı hangi işi kastettiğini net söylemediyse en mantıklı eşleşmeyi seç, mesajında belirt
- Öncelik belirtilmemişse NORMAL kullan
- Sorumlu belirtilmemişse şu an mesaidekileri yaz, yoksa "Belirsiz"
- Konuşma geçmişini takip et, önceki mesajlara atıf yapabilirsin

YANIT FORMATI — SADECE JSON, başka hiçbir şey yazma:
{
  "mesaj": "Kullanıcıya söylenecek samimi mesaj (WEB_ARA aksiyonlarında boş bırak)",
  "aksiyon": "AKSIYON_ADI",
  "parametreler": {}
}

AKSIYONLAR:
- "YOK" → sadece konuş
- "WEB_ARA" → parametreler: { "sorgu": "arama terimi", "derinlik": "basic|advanced" }
- "WEB_ARA_COKLU" → parametreler: { "sorgular": ["sorgu1", "sorgu2"] }
- "LISTELE_ACIK" → açık işleri listele
- "LISTELE_BITEN" → parametreler: { "tarih": "GG.AA.YYYY" } (belirtilmezse bugün)
- "LISTELE_TEKRAR" → tekrar eden işleri listele
- "IS_AC" → parametreler: { "isAdi": "...", "oncelik": "KRİTİK|YÜKSEK|NORMAL|BEKLEMEDE", "sorumlu": "...", "deadline": "GG.AA.YYYY SS:DD veya yok", "altMaddeler": "madde1,madde2 veya yok" }
- "IS_TAMAMLA" → parametreler: { "isNo": 1 }
- "IS_IPTAL" → parametreler: { "isNo": 1 }
- "ARSIVLE" → biten tüm işleri arşivle`;

  const response = await retryAsync(() =>
    mistral.chat.complete({
      model: 'mistral-large-latest',
      messages: [
        { role: 'system', content: sistemPrompt },
        ...mesajlar
      ],
      responseFormat: { type: 'json_object' },
      temperature: 0.4
    })
  );

  const raw = response.choices[0].message.content.trim();
  try {
    return JSON.parse(raw);
  } catch (e) {
    return { mesaj: raw, aksiyon: 'YOK', parametreler: {} };
  }
}

// =========================================
//   HAYDAR AI — AKSİYON UYGULA
// =========================================

async function haydarAksiyonUygula(chatId, parsed, acikIsler, gecmis) {
  const { mesaj, aksiyon, parametreler } = parsed;

  // WEB_ARA aksiyonlarında mesaj boş gelir, önce aramayı yap
  if (aksiyon === 'WEB_ARA') {
    try {
      await bot.sendChatAction(chatId, 'typing');
      const { sorgu, derinlik } = parametreler;
      const aramaSonucu = await webArama(sorgu, derinlik || 'basic');

      // Arama sonucunu Haydar'a yorumlat
      const yorumPrompt = `Kullanıcı şunu istedi: "${gecmis[gecmis.length - 1]?.content || sorgu}"

Web araması yaptım ("${sorgu}"), şu sonuçlar geldi:
${aramaSonucu}

Bu bilgileri kullanarak kullanıcıya Haydar gibi — samimi, kısa, Türkçe — cevap ver. 
Kaynak URL'lerinden en alakalı birini sonuna ekleyebilirsin ama şart değil.
Sadece cevap yaz, JSON değil.`;

      const yorumResponse = await retryAsync(() =>
        mistral.chat.complete({
          model: 'mistral-large-latest',
          messages: [
            { role: 'system', content: 'Sen Haydar\'sın. Samimi, kısa, Türkçe cevap ver. Argo kullanabilirsin. Kafadan uydurma, verilen bilgiyi kullan.' },
            { role: 'user', content: yorumPrompt }
          ],
          temperature: 0.5
        })
      );

      const yorumMetin = yorumResponse.choices[0].message.content.trim();
      await mesajGonder(chatId, `🌐 ${yorumMetin}`);
    } catch (e) {
      await mesajGonder(chatId, '❌ Web aramada sorun çıktı: ' + e.message);
    }
    return;
  }

  if (aksiyon === 'WEB_ARA_COKLU') {
    try {
      await bot.sendChatAction(chatId, 'typing');
      const { sorgular } = parametreler;
      const sonuclar = await Promise.all(sorgular.map(s => webArama(s, 'basic')));
      const birlestirilenSonuc = sorgular.map((s, i) => `=== "${s}" sonuçları ===\n${sonuclar[i]}`).join('\n\n');

      const yorumPrompt = `Kullanıcı şunu istedi: "${gecmis[gecmis.length - 1]?.content}"

Birden fazla web araması yaptım:
${birlestirilenSonuc}

Bu bilgileri karşılaştırarak kullanıcıya Haydar gibi — samimi, kapsamlı ama gereksiz uzun olmayan, Türkçe — cevap ver.
Sadece cevap yaz, JSON değil.`;

      const yorumResponse = await retryAsync(() =>
        mistral.chat.complete({
          model: 'mistral-large-latest',
          messages: [
            { role: 'system', content: 'Sen Haydar\'sın. Samimi, Türkçe cevap ver. Birden fazla kaynaktan gelen bilgiyi sentezle.' },
            { role: 'user', content: yorumPrompt }
          ],
          temperature: 0.5
        })
      );

      const yorumMetin = yorumResponse.choices[0].message.content.trim();
      await mesajGonder(chatId, `🌐 ${yorumMetin}`);
    } catch (e) {
      await mesajGonder(chatId, '❌ Çoklu arama hatası: ' + e.message);
    }
    return;
  }

  // Diğer aksiyonlarda önce mesajı gönder
  if (mesaj) await mesajGonder(chatId, mesaj);

  if (aksiyon === 'LISTELE_ACIK') {
    const isler = await acikIsleriGetir();
    if (isler.length === 0) {
      await mesajGonder(chatId, '🎉 Açık iş yok, her şey temiz!');
      return;
    }
    const gruplar = { 'KRİTİK': [], 'YÜKSEK': [], 'NORMAL': [], 'BEKLEMEDE': [], 'DİĞER': [] };
    for (const is of isler) {
      const oncelik = notionMetinAl(is.properties['ÖNCELİK']).toUpperCase();
      const baslik = notionMetinAl(is.properties['İş Başlığı']);
      const sorumlu = notionMetinAl(is.properties['SORUMLU']);
      const deadline = notionMetinAl(is.properties['Deanline']);
      const maddeler = altMaddeleriParse(notionMetinAl(is.properties['NOTLAR']));
      const maddeInfo = maddeler.length > 0 ? ` (${maddeler.filter(m => m.tamamlandi).length}/${maddeler.length})` : '';
      const kart = `${oncelikEmoji(oncelik)} <b>${baslik}</b>${maddeInfo}\n👤 ${sorumlu} ⏰ ${deadline}`;
      (gruplar[oncelik] || gruplar['DİĞER']).push(kart);
    }
    let liste = `📋 <b>AÇIK İŞLER (${isler.length})</b>\n━━━━━━━━━━━━━━━\n\n`;
    for (const g of [{ key: 'KRİTİK', emoji: '🔴' }, { key: 'YÜKSEK', emoji: '🟡' }, { key: 'NORMAL', emoji: '🟢' }, { key: 'BEKLEMEDE', emoji: '🔵' }, { key: 'DİĞER', emoji: '⚪' }]) {
      if (gruplar[g.key].length > 0) liste += `${g.emoji} <b>${g.key}</b>\n` + gruplar[g.key].join('\n\n') + '\n\n';
    }
    await mesajGonder(chatId, liste);

  } else if (aksiyon === 'LISTELE_BITEN') {
    const tarihParam = parametreler?.tarih || null;
    const isler = await bitenIsleriGetir(tarihParam);
    const tarihGoster = tarihParam || bugunTarih();
    if (isler.length === 0) {
      await mesajGonder(chatId, `📭 ${tarihGoster} tarihinde biten iş yok.`);
      return;
    }
    let liste = `📋 <b>BİTEN İŞLER — ${tarihGoster} (${isler.length})</b>\n━━━━━━━━━━━━━━━\n\n`;
    for (const is of isler) {
      const tamamlanma = notionMetinAl(is.properties['Tamamlanma Tarihi']);
      liste += `${oncelikEmoji(notionMetinAl(is.properties['ÖNCELİK']))} <b>${notionMetinAl(is.properties['İş Başlığı'])}</b>\n👤 ${notionMetinAl(is.properties['SORUMLU'])}\n🕐 ${tamamlanma}\n\n`;
    }
    await mesajGonder(chatId, liste);

  } else if (aksiyon === 'LISTELE_TEKRAR') {
    const isler = await tekrarEdenIsleriGetir();
    if (isler.length === 0) {
      await mesajGonder(chatId, '🔁 Tekrar eden iş yok.');
      return;
    }
    let liste = `🔁 <b>TEKRAR EDEN İŞLER (${isler.length})</b>\n━━━━━━━━━━━━━━━\n\n`;
    for (const is of isler) {
      const baslik = notionMetinAl(is.properties['İş Başlığı']);
      const tip = notionMetinAl(is.properties['TEKRAR_TİPİ']);
      const gun = notionMetinAl(is.properties['TEKRAR_GÜNÜ']);
      const saat = notionMetinAl(is.properties['TEKRAR_SAATİ']);
      const son = notionMetinAl(is.properties['SON_TETIKLEME']);
      liste += `${oncelikEmoji(notionMetinAl(is.properties['ÖNCELİK']))} <b>${baslik}</b>\n🔁 ${tip} ${gun !== 'Her Gün' ? gun : ''} ${saat} | Son: ${son}\n\n`;
    }
    await mesajGonder(chatId, liste);

  } else if (aksiyon === 'IS_AC') {
    const { isAdi, oncelik, sorumlu, deadline, altMaddeler } = parametreler;
    await yeniIsOlustur(isAdi, oncelik || 'NORMAL', sorumlu || 'Belirsiz', deadline || 'yok', altMaddeler || 'yok');
    await bot.sendMessage(CHAT_ID, `🆕 <b>YENİ İŞ AÇILDI</b>\n━━━━━━━━━━━━━━━\n\n${oncelikEmoji(oncelik)} <b>${isAdi}</b>\n👤 ${sorumlu || 'Belirsiz'}\n⏰ ${(!deadline || deadline === 'yok') ? 'Deadline yok' : deadline}\n\n🤖 Haydar tarafından açıldı`, { parse_mode: 'HTML' });

  } else if (aksiyon === 'IS_TAMAMLA') {
    const isNo = (parametreler.isNo || 1) - 1;
    if (!acikIsler[isNo]) { await mesajGonder(chatId, '❌ İş bulunamadı.'); return; }
    await isTamamla(acikIsler[isNo].id);
    await bitenIsBildirimiGonder(acikIsler[isNo].id);

  } else if (aksiyon === 'IS_IPTAL') {
    const isNo = (parametreler.isNo || 1) - 1;
    if (!acikIsler[isNo]) { await mesajGonder(chatId, '❌ İş bulunamadı.'); return; }
    const baslik = notionMetinAl(acikIsler[isNo].properties['İş Başlığı']);
    await retryAsync(() => notion.pages.update({ page_id: acikIsler[isNo].id, archived: true }));
    await bot.sendMessage(CHAT_ID, `🗑️ <b>${baslik}</b> silindi.\n\n🤖 Haydar tarafından iptal edildi`, { parse_mode: 'HTML' });

  } else if (aksiyon === 'ARSIVLE') {
    const response = await retryAsync(() =>
      notion.databases.query({ database_id: DATABASE_ID, filter: { property: 'DURUM', select: { equals: 'BİTTİ' } } })
    );
    const isler = response.results;
    if (isler.length === 0) { await mesajGonder(chatId, '🗂️ Arşivlenecek biten iş yok.'); return; }
    let basarili = 0;
    for (const is of isler) {
      try { await isArsivle(is); basarili++; } catch (e) { }
    }
    await bot.sendMessage(CHAT_ID, `🗂️ <b>${basarili} İŞ ARŞİVLENDİ</b>\n━━━━━━━━━━━━━━━\n\nİyi geceler ekip 😴\n\n🤖 Haydar tarafından arşivlendi`, { parse_mode: 'HTML' });
  }
}

// =========================================
//   TELEGRAM KOMUTLARI
// =========================================

bot.onText(/\/acik/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const isler = await acikIsleriGetir();
    if (isler.length === 0) { await mesajGonder(chatId, '📋 <b>AÇIK İŞLER</b>\n━━━━━━━━━━━━━━━\n\n🎉 Açık iş yok, her şey temiz!'); return; }
    const gruplar = { 'KRİTİK': [], 'YÜKSEK': [], 'NORMAL': [], 'BEKLEMEDE': [], 'DİĞER': [] };
    for (const is of isler) {
      const oncelik = notionMetinAl(is.properties['ÖNCELİK']).toUpperCase();
      const baslik = notionMetinAl(is.properties['İş Başlığı']);
      const sorumlu = notionMetinAl(is.properties['SORUMLU']);
      const deadline = notionMetinAl(is.properties['Deanline']);
      const maddeler = altMaddeleriParse(notionMetinAl(is.properties['NOTLAR']));
      const maddeInfo = maddeler.length > 0 ? ` (${maddeler.filter(m => m.tamamlandi).length}/${maddeler.length})` : '';
      const kart = `${oncelikEmoji(oncelik)} <b>${baslik}</b>${maddeInfo}\n👤 ${sorumlu}\n⏰ ${deadline}`;
      (gruplar[oncelik] || gruplar['DİĞER']).push(kart);
    }
    let metin = `📋 <b>AÇIK İŞLER (${isler.length})</b>\n━━━━━━━━━━━━━━━\n\n`;
    for (const g of [{ key: 'KRİTİK', emoji: '🔴' }, { key: 'YÜKSEK', emoji: '🟡' }, { key: 'NORMAL', emoji: '🟢' }, { key: 'BEKLEMEDE', emoji: '🔵' }, { key: 'DİĞER', emoji: '⚪' }]) {
      if (gruplar[g.key].length > 0) metin += `${g.emoji} <b>${g.key}</b>\n` + gruplar[g.key].join('\n\n') + '\n\n';
    }
    await mesajGonder(chatId, metin);
  } catch (e) { await mesajGonder(chatId, '❌ Hata: ' + e.message); }
});

bot.onText(/\/kritik/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const isler = await acikIsleriGetir('KRİTİK');
    if (isler.length === 0) { await mesajGonder(chatId, '🔴 Açık kritik iş yok!'); return; }
    let metin = `🔴 <b>KRİTİK (${isler.length})</b>\n━━━━━━━━━━━━━━━\n\n`;
    for (const is of isler) {
      const maddeler = altMaddeleriParse(notionMetinAl(is.properties['NOTLAR']));
      const maddeInfo = maddeler.length > 0 ? `\n📝 ${maddeler.filter(m => m.tamamlandi).length}/${maddeler.length} madde` : '';
      metin += `🔴 <b>${notionMetinAl(is.properties['İş Başlığı'])}</b>\n👤 ${notionMetinAl(is.properties['SORUMLU'])}\n⏰ ${notionMetinAl(is.properties['Deanline'])}${maddeInfo}\n\n`;
    }
    await mesajGonder(chatId, metin);
  } catch (e) { await mesajGonder(chatId, '❌ Hata: ' + e.message); }
});

bot.onText(/\/yüksek|\/yuksek/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const isler = await acikIsleriGetir('YÜKSEK');
    if (isler.length === 0) { await mesajGonder(chatId, '🟡 Açık yüksek öncelikli iş yok!'); return; }
    let metin = `🟡 <b>YÜKSEK (${isler.length})</b>\n━━━━━━━━━━━━━━━\n\n`;
    for (const is of isler) metin += `🟡 <b>${notionMetinAl(is.properties['İş Başlığı'])}</b>\n👤 ${notionMetinAl(is.properties['SORUMLU'])}\n⏰ ${notionMetinAl(is.properties['Deanline'])}\n\n`;
    await mesajGonder(chatId, metin);
  } catch (e) { await mesajGonder(chatId, '❌ Hata: ' + e.message); }
});

bot.onText(/\/normal/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const isler = await acikIsleriGetir('NORMAL');
    if (isler.length === 0) { await mesajGonder(chatId, '🟢 Açık normal iş yok!'); return; }
    let metin = `🟢 <b>NORMAL (${isler.length})</b>\n━━━━━━━━━━━━━━━\n\n`;
    for (const is of isler) metin += `🟢 <b>${notionMetinAl(is.properties['İş Başlığı'])}</b>\n👤 ${notionMetinAl(is.properties['SORUMLU'])}\n⏰ ${notionMetinAl(is.properties['Deanline'])}\n\n`;
    await mesajGonder(chatId, metin);
  } catch (e) { await mesajGonder(chatId, '❌ Hata: ' + e.message); }
});

bot.onText(/\/biten(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const tarihParam = match[1]?.trim() || null;
  try {
    const isler = await bitenIsleriGetir(tarihParam);
    const tarihGoster = tarihParam || bugunTarih();
    if (isler.length === 0) { await mesajGonder(chatId, `📋 <b>BİTEN İŞLER — ${tarihGoster}</b>\n━━━━━━━━━━━━━━━\n\n📭 Bu tarihte biten iş yok.`); return; }
    let metin = `📋 <b>BİTEN İŞLER — ${tarihGoster} (${isler.length})</b>\n━━━━━━━━━━━━━━━\n\n`;
    for (const is of isler) {
      const tamamlanma = notionMetinAl(is.properties['Tamamlanma Tarihi']);
      metin += `${oncelikEmoji(notionMetinAl(is.properties['ÖNCELİK']))} <b>${notionMetinAl(is.properties['İş Başlığı'])}</b>\n👤 ${notionMetinAl(is.properties['SORUMLU'])}\n🕐 ${tamamlanma}\n\n`;
    }
    await mesajGonder(chatId, metin);
  } catch (e) { await mesajGonder(chatId, '❌ Hata: ' + e.message); }
});

bot.onText(/\/arsivle/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const response = await retryAsync(() =>
      notion.databases.query({ database_id: DATABASE_ID, filter: { property: 'DURUM', select: { equals: 'BİTTİ' } } })
    );
    const isler = response.results;
    if (isler.length === 0) { await mesajGonder(chatId, '🗂️ Arşivlenecek biten iş yok.'); return; }
    await mesajGonder(chatId, `⏳ ${isler.length} iş arşivleniyor...`);
    let basarili = 0;
    for (const is of isler) { try { await isArsivle(is); basarili++; } catch (e) { } }
    await bot.sendMessage(CHAT_ID, `🗂️ <b>${basarili} İŞ ARŞİVLENDİ</b>\n━━━━━━━━━━━━━━━\n\nİyi geceler ekip 😴`, { parse_mode: 'HTML' });
  } catch (e) { await mesajGonder(chatId, '❌ Hata: ' + e.message); }
});

bot.onText(/\/tamamla/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const isler = await acikIsleriGetir();
    if (isler.length === 0) { await mesajGonder(chatId, '📋 Açık iş yok.'); return; }
    let metin = '📋 <b>Hangi işi tamamlıyorsunuz?</b>\n━━━━━━━━━━━━━━━\n\n';
    isler.forEach((is, i) => metin += `${i + 1}. ${oncelikEmoji(notionMetinAl(is.properties['ÖNCELİK']))} ${notionMetinAl(is.properties['İş Başlığı'])}\n`);
    metin += '\nNumara yaz (örn: 2)';
    kullaniciDurum[chatId] = { adim: 'tamamla_secim', isler };
    await mesajGonder(chatId, metin);
  } catch (e) { await mesajGonder(chatId, '❌ Hata: ' + e.message); }
});

bot.onText(/\/tekraredenler/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const isler = await tekrarEdenIsleriGetir();
    if (isler.length === 0) { await mesajGonder(chatId, '🔁 <b>TEKRAR EDEN İŞLER</b>\n━━━━━━━━━━━━━━━\n\nHenüz tekrar eden iş yok.\n/tekraredenekle ile ekleyebilirsiniz.'); return; }
    let metin = `🔁 <b>TEKRAR EDEN İŞLER (${isler.length})</b>\n━━━━━━━━━━━━━━━\n\n`;
    for (const is of isler) {
      const gun = notionMetinAl(is.properties['TEKRAR_GÜNÜ']);
      metin += `${oncelikEmoji(notionMetinAl(is.properties['ÖNCELİK']))} <b>${notionMetinAl(is.properties['İş Başlığı'])}</b>\n🔁 ${notionMetinAl(is.properties['TEKRAR_TİPİ'])}${gun !== '-' && gun !== 'Her Gün' ? ` — ${gun}` : ''} ${notionMetinAl(is.properties['TEKRAR_SAATİ'])}\n⏱ Son: ${notionMetinAl(is.properties['SON_TETIKLEME'])}\n\n`;
    }
    await mesajGonder(chatId, metin);
  } catch (e) { await mesajGonder(chatId, '❌ Hata: ' + e.message); }
});

bot.onText(/\/tekraredenekle/, async (msg) => {
  const chatId = msg.chat.id;
  kullaniciDurum[chatId] = { adim: 'tekrar_isim' };
  await mesajGonder(chatId, '🔁 <b>TEKRAR EDEN İŞ EKLEME</b>\n━━━━━━━━━━━━━━━\n\n<b>1/5 — İş adı nedir?</b>\n\n(İptal için /iptal yaz)');
});

bot.onText(/\/shift (.+)/, async (msg, match) => {
  await shiftKaydet(match[1], msg.chat.id);
});

bot.onText(/\/yeni/, async (msg) => {
  const chatId = msg.chat.id;
  kullaniciDurum[chatId] = { adim: 'isim' };
  await mesajGonder(chatId, '🆕 <b>YENİ İŞ AÇILIYOR</b>\n━━━━━━━━━━━━━━━\n\n<b>1/5 — İş adı nedir?</b>\n\n(İptal için /iptal yaz)');
});

bot.onText(/\/iptal/, async (msg) => {
  delete kullaniciDurum[msg.chat.id];
  await mesajGonder(msg.chat.id, '❌ İşlem iptal edildi.', { remove_keyboard: true });
});

bot.onText(/\/yardim|\/start/, async (msg) => {
  const metin = `🤖 <b>KOMUT LİSTESİ</b>\n━━━━━━━━━━━━━━━\n\n📋 <b>İş Listeleme</b>\n/acik — Tüm açık işler\n/kritik — Kritik işler\n/yüksek — Yüksek öncelikli işler\n/normal — Normal işler\n/biten — Bugün biten işler\n/biten 23.05.2026 — O güne ait bitenler\n\n✅ <b>İş Yönetimi</b>\n/yeni — Yeni iş aç\n/tamamla — İş tamamla\n/arsivle — Biten işleri arşivle\n\n🔁 <b>Tekrar Eden İşler</b>\n/tekraredenler — Tekrar eden işleri listele\n/tekraredenekle — Tekrar eden iş ekle\n\n👥 <b>Shift</b>\n/shift [bilgi] — Haftalık shift kaydet\n\n🤖 <b>Haydar (AI)</b>\n"Hey Haydar [istek]" — Haydar'a seslen\n"Haydar kapanabilirsin" — Haydar'ı kapat\n\n❌ /iptal — İşlemi iptal et`;
  await mesajGonder(msg.chat.id, metin);
});

// =========================================
//   KONUŞMA AKIŞI
// =========================================

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const metin = msg.text || '';
  if (metin.startsWith('/')) return;

  // Hey Haydar ile uyanır
  if (/^hey haydar/i.test(metin)) {
    const istek = metin.replace(/^hey haydar[,!]?\s*/i, '').trim();
    if (!kullaniciDurum[chatId] || kullaniciDurum[chatId].adim !== 'haydar_aktif') {
      kullaniciDurum[chatId] = { adim: 'haydar_aktif', gecmis: [] };
    }
    if (!istek) {
      await mesajGonder(chatId, '👋 Buyur abi, ne yapayım?');
      return;
    }
    try {
      await bot.sendChatAction(chatId, 'typing');
      const { context, acikIsler } = await tumVeriCek();
      kullaniciDurum[chatId].gecmis.push({ role: 'user', content: istek });

      // Hafıza sıkıştırma
      if (kullaniciDurum[chatId].gecmis.length > 20) {
        kullaniciDurum[chatId].gecmis = await gecmisiSikistir(kullaniciDurum[chatId].gecmis);
      }

      const parsed = await haydarDusun(kullaniciDurum[chatId].gecmis, context, acikIsler);
      kullaniciDurum[chatId].gecmis.push({ role: 'assistant', content: parsed.mesaj || parsed.aksiyon });
      await haydarAksiyonUygula(chatId, parsed, acikIsler, kullaniciDurum[chatId].gecmis);
    } catch (e) { await mesajGonder(chatId, '❌ Haydar hatası: ' + e.message); }
    return;
  }

  // Haydar aktifse her mesajı işle
  if (kullaniciDurum[chatId]?.adim === 'haydar_aktif') {
    if (/haydar kapat|haydar kapanabilirsin|kapan haydar|görüşürüz haydar/i.test(metin)) {
      delete kullaniciDurum[chatId];
      await mesajGonder(chatId, '👋 Tamam, görüşürüz! Bir şey lazım olursa "Hey Haydar" de.');
      return;
    }
    try {
      await bot.sendChatAction(chatId, 'typing');
      const { context, acikIsler } = await tumVeriCek();
      kullaniciDurum[chatId].gecmis.push({ role: 'user', content: metin });

      // Hafıza sıkıştırma
      if (kullaniciDurum[chatId].gecmis.length > 20) {
        kullaniciDurum[chatId].gecmis = await gecmisiSikistir(kullaniciDurum[chatId].gecmis);
      }

      const parsed = await haydarDusun(kullaniciDurum[chatId].gecmis, context, acikIsler);
      kullaniciDurum[chatId].gecmis.push({ role: 'assistant', content: parsed.mesaj || parsed.aksiyon });
      await haydarAksiyonUygula(chatId, parsed, acikIsler, kullaniciDurum[chatId].gecmis);
    } catch (e) { await mesajGonder(chatId, '❌ Haydar hatası: ' + e.message); }
    return;
  }

  // Normal komut akışı
  const durum = kullaniciDurum[chatId];
  if (!durum) return;

  if (durum.adim?.startsWith('tekrar_')) {
    await tekrarEdenIsEkle(chatId, durum, metin);
    return;
  }

  if (durum.adim === 'isim') {
    durum.isAdi = metin; durum.adim = 'oncelik';
    await mesajGonder(chatId, `✅ İş adı: <b>${metin}</b>\n\n<b>2/5 — Öncelik?</b>`, {
      keyboard: [[{ text: '🔴 KRİTİK' }, { text: '🟡 YÜKSEK' }], [{ text: '🟢 NORMAL' }, { text: '🔵 BEKLEMEDE' }]],
      one_time_keyboard: true, resize_keyboard: true
    });
  } else if (durum.adim === 'oncelik') {
    durum.oncelik = metin.replace(/^[🔴🟡🟢🔵]\s*/, '');
    durum.adim = 'sorumlu';
    await mesajGonder(chatId, `✅ Öncelik: <b>${durum.oncelik}</b>\n\n<b>3/5 — Sorumlu?</b>`, { remove_keyboard: true });
  } else if (durum.adim === 'sorumlu') {
    durum.sorumlu = metin; durum.adim = 'deadline';
    await mesajGonder(chatId, `✅ Sorumlu: <b>${metin}</b>\n\n<b>4/5 — Deadline?</b>\n\nFormat: 28.05.2026 14:00\nYoksa <b>yok</b> yaz`);
  } else if (durum.adim === 'deadline') {
    durum.deadline = metin; durum.adim = 'altmaddeler';
    await mesajGonder(chatId, `✅ Deadline: <b>${metin}</b>\n\n<b>5/5 — Alt maddeler?</b>\n\nVirgülle yaz veya <b>yok</b> yaz`);
  } else if (durum.adim === 'altmaddeler') {
    durum.altMaddeler = metin;
    delete kullaniciDurum[chatId];
    try {
      await yeniIsOlustur(durum.isAdi, durum.oncelik, durum.sorumlu, durum.deadline, durum.altMaddeler);
      const deadlineMetin = durum.deadline.toLowerCase() === 'yok' ? 'Deadline yok' : durum.deadline;
      const altMaddeMetin = durum.altMaddeler.toLowerCase() === 'yok' ? '' : `\n📝 ${durum.altMaddeler.split(',').length} alt madde`;
      await bot.sendMessage(CHAT_ID, `🆕 <b>YENİ İŞ AÇILDI</b>\n━━━━━━━━━━━━━━━\n\n${oncelikEmoji(durum.oncelik)} <b>${durum.isAdi}</b>\n👤 ${durum.sorumlu}\n⏰ ${deadlineMetin}${altMaddeMetin}`, { parse_mode: 'HTML' });
      if (String(chatId) !== String(CHAT_ID)) await mesajGonder(chatId, '✅ İş başarıyla açıldı!');
    } catch (e) { await mesajGonder(chatId, '❌ Hata: ' + e.message); }
  } else if (durum.adim === 'tamamla_secim') {
    const secim = parseInt(metin) - 1;
    if (isNaN(secim) || secim < 0 || secim >= durum.isler.length) { await mesajGonder(chatId, '❌ Geçersiz numara.'); return; }
    const secilenIs = durum.isler[secim];
    const baslik = notionMetinAl(secilenIs.properties['İş Başlığı']);
    const maddeler = altMaddeleriParse(notionMetinAl(secilenIs.properties['NOTLAR']));
    if (maddeler.length === 0) {
      delete kullaniciDurum[chatId];
      await isTamamla(secilenIs.id);
      await bitenIsBildirimiGonder(secilenIs.id);
      return;
    }
    let maddeMetin = `📋 <b>${baslik}</b>\n━━━━━━━━━━━━━━━\n\n`;
    maddeler.forEach((m, i) => maddeMetin += `${i + 1}. ${m.tamamlandi ? '☑' : '☐'} ${m.metin}\n`);
    maddeMetin += '\nNumaraları yaz (örn: <b>1 3</b>) | <b>hepsi</b> | <b>bitir</b>';
    kullaniciDurum[chatId] = { adim: 'tamamla_maddeler', secilenIs, baslik, maddeler };
    await mesajGonder(chatId, maddeMetin);
  } else if (durum.adim === 'tamamla_maddeler') {
    const { secilenIs, baslik, maddeler } = durum;
    if (metin.toLowerCase() === 'bitir') {
      delete kullaniciDurum[chatId];
      await isTamamla(secilenIs.id);
      await bitenIsBildirimiGonder(secilenIs.id);
      return;
    }
    if (metin.toLowerCase() === 'hepsi') {
      maddeler.forEach(m => m.tamamlandi = true);
    } else {
      metin.split(/[\s,]+/).map(n => parseInt(n) - 1).filter(n => !isNaN(n) && n >= 0 && n < maddeler.length).forEach(n => maddeler[n].tamamlandi = true);
    }
    const yeniNotlar = altMaddeleriYaz(maddeler);
    const hepsiTamam = maddeler.every(m => m.tamamlandi);
    if (hepsiTamam) {
      await isGuncelle(secilenIs.id, { 'NOTLAR': { rich_text: [{ text: { content: yeniNotlar } }] } });
      await isTamamla(secilenIs.id);
      delete kullaniciDurum[chatId];
      await bitenIsBildirimiGonder(secilenIs.id);
    } else {
      await isGuncelle(secilenIs.id, { 'NOTLAR': { rich_text: [{ text: { content: yeniNotlar } }] } });
      delete kullaniciDurum[chatId];
      const tamamlanan = maddeler.filter(m => m.tamamlandi).length;
      let duzenliMetin = `📋 <b>${baslik}</b> güncellendi\n━━━━━━━━━━━━━━━\n\n`;
      maddeler.forEach((m, i) => duzenliMetin += `${i + 1}. ${m.tamamlandi ? '☑' : '☐'} ${m.metin}\n`);
      duzenliMetin += `\n${tamamlanan}/${maddeler.length} madde tamamlandı.`;
      await mesajGonder(chatId, duzenliMetin);
    }
  }
});

// =========================================
//   ZAMANLANMIŞ GÖREVLER
// =========================================

setInterval(kritikIsleriiBildir, 30 * 60 * 1000);
setInterval(yuksekIsleriiBildir, 45 * 60 * 1000);
setInterval(tekrarEdenIsleriKontrolEt, 60 * 1000);

console.log('🤖 İşler Botu başlatıldı! Haydar hazır. 🌐 Web search aktif.');
